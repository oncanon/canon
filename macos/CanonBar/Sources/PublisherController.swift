import AppKit
import Foundation
import ServiceManagement

/// The five menu-bar icon shapes from the design (page07, plate 1). Cloud is drawn here for
/// P1 even though nothing can put the app in that state yet — Cloud is gated to P4.
enum IconVisibilityState: String, CaseIterable {
    case loopback
    case tailnet
    case cloud
    case stopped
}

@MainActor
final class PublisherController: ObservableObject {
    @Published var profile: ProfileV1?
    @Published var service: ServiceSummary?
    @Published var aliases: [AliasSummary] = []
    @Published var isBusy: Bool = false
    @Published var lastError: String?
    @Published var launchAtLoginEnabled: Bool = false
    @Published var healthzStatus: Int?
    /// The status payload's store root (the store `canon status` actually read).
    @Published var statusStoreRoot: String?

    /// Which screen the panel shows: home (page06) or the Activity drill-in (page08). Reset to
    /// home whenever the panel closes.
    enum PanelRoute { case home, activity }
    @Published var panelRoute: PanelRoute = .home

    /// activity/v1, newest first. Nil until first loaded.
    @Published var activity: ActivityFeed?
    @Published var activityError: String?
    @Published var isLoadingActivity = false

    /// Verify now results by alias name, and the alias being verified right now.
    @Published var verifyRuns: [String: VerifyRun] = [:]
    @Published var verifyingAlias: String?

    private let monitor = DirectoryMonitor()
    private var pollTimer: Timer?
    private var didInitialReconcile = false

    /// When true (`--export-*` and `--read-only`), this controller never writes `~/.canon` and
    /// never starts or stops the real service: it only reads. Actions that would change
    /// something (Restart, Stop, visibility, Tailscale re-pin, launch at login) are logged and
    /// skipped, so a test copy can exercise every row and shortcut against the live store.
    private let readOnly: Bool

    /// In a read-only run, logs the skipped action and returns true. The log line is how tests
    /// see that a row or shortcut reached its action.
    private func skippedInReadOnly(_ action: String) -> Bool {
        guard readOnly else { return false }
        NSLog("Canon read-only: skipped %@", action)
        return true
    }

    init(readOnly: Bool = false) {
        self.readOnly = readOnly
        refreshLaunchAtLoginState()
        Task {
            await bootstrapAndReconcile()
            if readOnly {
                // Polling only reads (`canon status`, `/healthz`). The directory watchers stay
                // off: `DirectoryMonitor.watch` creates the directories it watches.
                installPollTimer()
            } else {
                installWatchers()
            }
        }
    }

    var profilePath: String {
        (ShellRunner.canonHome as NSString).appendingPathComponent("profile.json")
    }

    var sortedAliases: [AliasSummary] {
        aliases.sorted { lhs, rhs in
            if lhs.updatedAt != rhs.updatedAt {
                return lhs.updatedAt > rhs.updatedAt
            }
            return lhs.name < rhs.name
        }
    }

    /// Drives the menu-bar template icon shape. Cloud is unreachable in P1 (gated to P4);
    /// "needs you" is a separate overlay (see `needsAttention`), not a case here.
    var iconVisibilityState: IconVisibilityState {
        guard let svc = service, svc.state == "running" else { return .stopped }
        switch svc.visibility {
        case "tailscale": return .tailnet
        case "local": return .loopback
        default: return .stopped
        }
    }

    /// page07 Plate 1 "Needs you: Drift, or a join request. Dot in the top corner; the
    /// visibility badge stays." Drift comes from status/v1; join requests don't exist yet, and a
    /// surfaced reconciliation error also needs the user.
    var needsAttention: Bool {
        lastError != nil || aliases.contains(where: \.isDrift)
    }

    /// Aliases in drift, in the home list's order. The drift card shows the first.
    var driftedAliases: [AliasSummary] {
        sortedAliases.filter(\.isDrift)
    }

    var statusHeadline: String {
        if isBusy {
            return "Reconciling…"
        }
        guard let svc = service else {
            return "Initializing…"
        }
        if lastError != nil {
            return "Needs you"
        }
        return svc.state == "running" ? "Healthy" : "Stopped"
    }

    var activeEndpoint: String? {
        service?.preferredBaseUrl
    }

    var reachabilityCaption: String {
        guard let svc = service, svc.state == "running" else {
            return "Service stopped."
        }
        switch svc.visibility {
        case "tailscale": return "Reachable on your tailnet."
        case "local": return "Reachable from this Mac only."
        default: return "Reachability unknown."
        }
    }

    func bootstrapAndReconcile() async {
        if readOnly {
            self.profile = try? readExistingProfile()
            await refreshStatus()
            return
        }
        do {
            let prof = try await ensureProfileExists()
            self.profile = prof
            await refreshStatus()
            if !didInitialReconcile {
                didInitialReconcile = true
                await reconcileServiceToProfile(prof)
            }
        } catch {
            self.lastError = error.localizedDescription
        }
    }

    /// Read-only counterpart to `ensureProfileExists()`: never creates `~/.canon` directories
    /// or writes `profile.json`. Returns nil (not an error) if no profile exists yet.
    private func readExistingProfile() throws -> ProfileV1? {
        guard FileManager.default.fileExists(atPath: profilePath) else { return nil }
        let data = try Data(contentsOf: URL(fileURLWithPath: profilePath))
        return try JSONDecoder().decode(ProfileV1.self, from: data)
    }

    private func installWatchers() {
        let home = ShellRunner.canonHome
        let storeAliases = ((profile?.storeRoot ?? (home as NSString).appendingPathComponent("store")) as NSString)
            .appendingPathComponent("aliases")
        let serviceDir = profile?.stateDir ?? (home as NSString).appendingPathComponent("service")

        monitor.watch(paths: [home, storeAliases, serviceDir]) { [weak self] in
            Task { @MainActor [weak self] in
                guard let self, !self.isBusy else { return }
                await self.refreshStatus()
            }
        }
        installPollTimer()
    }

    private func installPollTimer() {
        pollTimer?.invalidate()
        pollTimer = Timer.scheduledTimer(withTimeInterval: 6.0, repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                guard let self, !self.isBusy else { return }
                await self.refreshStatus()
            }
        }
    }

    private func ensureProfileExists() async throws -> ProfileV1 {
        let home = ShellRunner.canonHome
        let fm = FileManager.default
        try fm.createDirectory(atPath: home, withIntermediateDirectories: true)

        if fm.fileExists(atPath: profilePath) {
            let data = try Data(contentsOf: URL(fileURLWithPath: profilePath))
            return try JSONDecoder().decode(ProfileV1.self, from: data)
        }

        let storeRoot = (home as NSString).appendingPathComponent("store")
        let stateDir = (home as NSString).appendingPathComponent("service")
        let buildsDir = (home as NSString).appendingPathComponent("builds")
        try fm.createDirectory(atPath: storeRoot, withIntermediateDirectories: true)
        try fm.createDirectory(atPath: stateDir, withIntermediateDirectories: true)
        try fm.createDirectory(atPath: buildsDir, withIntermediateDirectories: true)

        let tsResult = await ShellRunner.detectTailscaleNode()
        let initial: ProfileV1
        switch tsResult {
        case .success(let pin):
            initial = ProfileV1(
                exposure: "tailscale",
                port: 8791,
                storeRoot: storeRoot,
                stateDir: stateDir,
                buildsDir: buildsDir,
                tailscale: pin
            )
        case .failure:
            initial = ProfileV1(
                exposure: "local",
                port: 8791,
                storeRoot: storeRoot,
                stateDir: stateDir,
                buildsDir: buildsDir,
                tailscale: nil
            )
        }
        try saveProfile(initial)
        return initial
    }

    private func saveProfile(_ updated: ProfileV1) throws {
        // Backstop for the entry-point guards: a read-only run must never write the profile.
        guard !readOnly else { throw CocoaError(.fileWriteNoPermission) }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        var bytes = try encoder.encode(updated)
        bytes.append(0x0A)
        try bytes.write(to: URL(fileURLWithPath: profilePath), options: .atomic)
        self.profile = updated
    }

    /// Every read the app makes goes through here. In a read-only run each call is logged, so a
    /// test can show which CLI commands ran: all of them are reads (status, activity, alias
    /// verify), and none writes the store or the state dir.
    private func runCanonRead(_ args: [String]) async -> CommandOutcome {
        if readOnly { NSLog("Canon read-only: ran canon %@", args.joined(separator: " ")) }
        return await ShellRunner.runCanon(args)
    }

    func refreshStatus() async {
        let res = await runCanonRead(["status"])
        guard res.exitCode == 0, let data = res.stdout.data(using: .utf8) else {
            let errText = res.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            if !errText.isEmpty {
                self.lastError = errText
            }
            return
        }
        do {
            let decoded = try JSONDecoder().decode(CanonStatusPayload.self, from: data)
            self.service = decoded.service
            self.aliases = decoded.aliases
            self.statusStoreRoot = decoded.storeRoot
            // A verify result belongs to one drift episode of one edition: drop it once the alias
            // moves, or once the manifest check passes again. Otherwise a later drift of the same
            // edition would show the earlier episode's result. An absent `verify` (a transient
            // error) keeps it.
            self.verifyRuns = self.verifyRuns.filter { name, run in
                guard let alias = decoded.aliases.first(where: { $0.name == name }) else { return false }
                if alias.verify == "verified" { return false }
                return run.result.map { $0.contentId == alias.contentId } ?? true
            }
            if let diskData = try? Data(contentsOf: URL(fileURLWithPath: profilePath)),
               let diskProf = try? JSONDecoder().decode(ProfileV1.self, from: diskData) {
                self.profile = diskProf
            }
            if let base = decoded.service?.preferredBaseUrl {
                healthzStatus = await ShellRunner.fetchHealthz(baseUrl: base)
            } else {
                healthzStatus = nil
            }
        } catch {
            self.lastError = "Status decode error: \(error.localizedDescription)"
        }
    }

    private func fallbackProfile(exposure: String) -> ProfileV1 {
        let home = ShellRunner.canonHome
        return ProfileV1(
            exposure: exposure,
            port: 8791,
            storeRoot: (home as NSString).appendingPathComponent("store"),
            stateDir: (home as NSString).appendingPathComponent("service"),
            buildsDir: (home as NSString).appendingPathComponent("builds"),
            tailscale: nil
        )
    }

    func setExposure(_ target: String) {
        guard !isBusy, !skippedInReadOnly("setExposure(\(target))") else { return }
        isBusy = true
        lastError = nil
        Task {
            defer { isBusy = false }
            var current = profile ?? fallbackProfile(exposure: target)

            do {
                try FileManager.default.createDirectory(atPath: current.storeRoot, withIntermediateDirectories: true)
                try FileManager.default.createDirectory(atPath: current.stateDir, withIntermediateDirectories: true)
                try FileManager.default.createDirectory(atPath: current.buildsDir, withIntermediateDirectories: true)

                if target == "tailscale" && current.tailscale == nil {
                    switch await ShellRunner.detectTailscaleNode() {
                    case .success(let pin):
                        current.tailscale = pin
                    case .failure(let err):
                        self.lastError = err.localizedDescription
                        return
                    }
                }
                current.exposure = target
                try saveProfile(current)
                await reconcileServiceToProfile(current)
            } catch {
                self.lastError = error.localizedDescription
            }
        }
    }

    func refreshTailscalePin() {
        guard !isBusy, !skippedInReadOnly("refreshTailscalePin") else { return }
        isBusy = true
        lastError = nil
        Task {
            defer { isBusy = false }
            var current = profile ?? fallbackProfile(exposure: "tailscale")

            switch await ShellRunner.detectTailscaleNode() {
            case .success(let pin):
                do {
                    current.tailscale = pin
                    try saveProfile(current)
                    if current.exposure == "tailscale" {
                        await reconcileServiceToProfile(current, forceRestart: true)
                    } else {
                        await refreshStatus()
                    }
                } catch {
                    self.lastError = error.localizedDescription
                }
            case .failure(let err):
                self.lastError = err.localizedDescription
            }
        }
    }

    func restartServer() {
        guard !isBusy, let current = profile, !skippedInReadOnly("restartServer") else { return }
        isBusy = true
        lastError = nil
        Task {
            defer { isBusy = false }
            await reconcileServiceToProfile(current, forceRestart: true)
        }
    }

    private func isServiceMatchingProfile(_ prof: ProfileV1) -> Bool {
        guard let svc = service,
              svc.state == "running",
              svc.visibility == prof.exposure else {
            return false
        }
        if let activeStore = svc.storeRoot {
            let normActive = URL(fileURLWithPath: activeStore).standardizedFileURL.path
            let normProf = URL(fileURLWithPath: prof.storeRoot).standardizedFileURL.path
            if normActive != normProf {
                return false
            }
        }
        switch prof.exposure {
        case "local":
            return svc.urls.contains("http://127.0.0.1:\(prof.port)")
        case "tailscale":
            guard let pin = prof.tailscale else { return false }
            return svc.urls.contains("http://\(pin.address):\(prof.port)")
                && svc.urls.contains("http://\(pin.name):\(prof.port)")
        default:
            return false
        }
    }

    private func reconcileServiceToProfile(_ prof: ProfileV1, forceRestart: Bool = false) async {
        // Backstop for the entry-point guards: a read-only run never drives the service.
        guard !skippedInReadOnly("reconcileServiceToProfile") else { return }
        let currentState = service?.state

        if prof.exposure == "stopped" {
            if currentState != "stopped" {
                let stopRes = await ShellRunner.runCanon(["service", "stop", "--state-dir", prof.stateDir])
                if stopRes.exitCode != 0 {
                    lastError = stopRes.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
                }
            }
            await refreshStatus()
            return
        }

        if !forceRestart && isServiceMatchingProfile(prof) {
            return
        }

        // Stop any existing or stale listener first so bind switches cleanly
        if currentState != nil && currentState != "stopped" {
            _ = await ShellRunner.runCanon(["service", "stop", "--state-dir", prof.stateDir])
        }

        var startArgs = [
            "service", "start",
            "--root", prof.storeRoot,
            "--state-dir", prof.stateDir,
            "--port", String(prof.port),
        ]

        if prof.exposure == "tailscale" {
            guard let pin = prof.tailscale else {
                lastError = "Tailscale node is not pinned in profile.json"
                return
            }
            startArgs += [
                "--tailscale",
                "--expect-tailscale-address", pin.address,
                "--expect-tailscale-name", pin.name,
            ]
        }

        let startRes = await ShellRunner.runCanon(startArgs)
        if startRes.exitCode != 0 {
            let msg = startRes.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            lastError = msg.isEmpty ? "service start failed (exit \(startRes.exitCode))" : msg
        } else {
            lastError = nil
        }
        await refreshStatus()
    }

    // MARK: - Activity and Verify now (read-only CLI calls)

    var storeRootForReads: String? {
        statusStoreRoot ?? profile?.storeRoot
    }

    var stateDirForReads: String? {
        service?.stateDir ?? profile?.stateDir
    }

    /// Up to this many items are read; the list shows them all, newest first.
    static let activityLimit = 200

    func showActivity() {
        panelRoute = .activity
        Task { await refreshActivity() }
    }

    func showHome() {
        panelRoute = .home
    }

    func refreshActivity() async {
        var args = ["activity", "--json", "--limit", String(Self.activityLimit)]
        if let root = storeRootForReads { args += ["--root", root] }
        if let dir = stateDirForReads { args += ["--state-dir", dir] }
        guard args.count > 4 else {
            activityError = "No store or service directory to read."
            return
        }
        isLoadingActivity = true
        defer { isLoadingActivity = false }
        let res = await runCanonRead(args)
        guard res.exitCode == 0, let data = res.stdout.data(using: .utf8),
              let feed = try? JSONDecoder().decode(ActivityFeed.self, from: data) else {
            let err = res.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            activityError = err.isEmpty ? "canon activity exited \(res.exitCode)" : err
            return
        }
        activityError = nil
        activity = feed
    }

    /// The drift card's Verify now: `canon alias verify <name> --json`, a full re-hash of every
    /// file body. Exit 0 verified, exit 1 drift or no such alias. Read-only.
    func verifyNow(_ alias: AliasSummary) {
        guard verifyingAlias == nil else { return }
        verifyingAlias = alias.name
        Task {
            defer { verifyingAlias = nil }
            var args = ["alias", "verify", alias.name, "--json"]
            if let root = storeRootForReads { args += ["--root", root] }
            let res = await runCanonRead(args)
            let decoded = res.stdout.data(using: .utf8).flatMap { try? JSONDecoder().decode(AliasVerifyResult.self, from: $0) }
            let err = res.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            verifyRuns[alias.name] = VerifyRun(exitCode: res.exitCode, result: decoded,
                                               message: decoded == nil ? (err.isEmpty ? nil : err) : nil)
            // Re-read status at once, so the card and the pill never disagree with the run
            // until the next poll. A pass usually means the files were restored: the manifest
            // check then passes too, and the card goes.
            await refreshStatus()
        }
    }

    /// The events log behind the Activity list's service and refusal rows.
    var eventsLogPath: String? {
        stateDirForReads.map { ($0 as NSString).appendingPathComponent("events.jsonl") }
    }

    /// page08 Activity "Open full log ⌘L": opens events.jsonl in Console, read-only.
    func openFullLog() {
        guard let path = eventsLogPath, FileManager.default.fileExists(atPath: path) else { return }
        let console = URL(fileURLWithPath: "/System/Applications/Utilities/Console.app")
        let config = NSWorkspace.OpenConfiguration()
        NSWorkspace.shared.open([URL(fileURLWithPath: path)], withApplicationAt: console, configuration: config)
    }

    /// The current alias whose edition is `contentId`, for naming refusals in Activity.
    func aliasName(forContentId contentId: String) -> String? {
        sortedAliases.first(where: { $0.contentId == contentId })?.name
    }

    // MARK: - Actions & Clipboard

    func humanUrl(for alias: AliasSummary) -> URL? {
        guard let base = activeEndpoint else { return nil }
        return URL(string: "\(base)/a/\(alias.name)/")
    }

    func agentUrl(for alias: AliasSummary) -> URL? {
        guard let base = activeEndpoint,
              let entry = alias.agentEntry?.trimmingCharacters(in: .whitespacesAndNewlines),
              !entry.isEmpty else {
            return nil
        }
        return URL(string: "\(base)/a/\(alias.name)/\(entry)")
    }

    func immutableUrl(for alias: AliasSummary) -> URL? {
        guard let base = activeEndpoint else { return nil }
        return URL(string: "\(base)/p/\(alias.contentId)/")
    }

    func openInBrowser(_ url: URL) {
        NSWorkspace.shared.open(url)
    }

    func copyString(_ value: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(value, forType: .string)
    }

    func openStoreInFinder() {
        let path = profile?.storeRoot ?? (ShellRunner.canonHome as NSString).appendingPathComponent("store")
        NSWorkspace.shared.selectFile(nil, inFileViewerRootedAtPath: path)
    }

    func refreshLaunchAtLoginState() {
        launchAtLoginEnabled = (SMAppService.mainApp.status == .enabled)
    }

    func toggleLaunchAtLogin() {
        guard !skippedInReadOnly("toggleLaunchAtLogin") else { return }
        do {
            if SMAppService.mainApp.status == .enabled {
                try SMAppService.mainApp.unregister()
            } else {
                try SMAppService.mainApp.register()
            }
            refreshLaunchAtLoginState()
            lastError = nil
        } catch {
            lastError = "Launch at Login: \(error.localizedDescription)"
            refreshLaunchAtLoginState()
        }
    }
}
