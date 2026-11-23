import Foundation

// MARK: - Models (`profile/v1` and `canon status`)

struct TailscalePin: Codable, Equatable, Sendable {
    var address: String
    var name: String
}

struct ProfileV1: Codable, Equatable, Sendable {
    var schema: String = "profile/v1"
    var exposure: String // "tailscale" | "local" | "stopped"
    var port: Int
    var storeRoot: String
    var stateDir: String
    var buildsDir: String
    var tailscale: TailscalePin?
}

/// status/v1 per-alias `refusedToServe`: `{since, count, lastAt, lastPath}`. `since` is the later
/// of this generation going live and the running service's start (core/app-status `f5dc2df`),
/// so a fix plus a service restart clears the count. `lastPath` is the file the last refusal was for.
struct AliasRefusals: Codable, Equatable, Sendable {
    var since: String
    var count: Int
    var lastAt: String?
    var lastPath: String?
}

struct AliasSummary: Codable, Identifiable, Equatable, Sendable {
    var name: String
    var generation: Int
    var contentId: String
    var updatedAt: String
    var artifactSchema: String?
    var title: String?
    var entry: String?
    var agentEntry: String?
    /// status/v1 (`docs/core/app-status-v1.md` S1): "verified" | "drift". Absent after a
    /// transient I/O error, and from CLIs older than core/app-status: then no pill is shown.
    var verify: String?
    /// "manifest" whenever `verify` is present: content ID and manifest digest only, file
    /// bodies are not re-hashed. The pill must not claim more than this.
    var verifyDepth: String?
    /// Present only with `verify == "drift"`: packet-missing, checksums-unreadable,
    /// manifest-unreadable, manifest-hash-mismatch, content-id-mismatch, refused-to-serve.
    var driftReasons: [String]?
    /// core/app-status `7cb5d7a`: the service's refusals (integrity-failure events) against this
    /// alias's current content ID since this generation went live. Core already folds a
    /// non-zero count into `verify`/`driftReasons`; the app only uses it for wording. Omitted
    /// when events.jsonl can't be read, and by older CLIs.
    var refusedToServe: AliasRefusals?

    var id: String { name }

    var isDrift: Bool { verify == "drift" }

    var displayTitle: String {
        if let t = title?.trimmingCharacters(in: .whitespacesAndNewlines), !t.isEmpty {
            return t
        }
        return name
    }

    /// Lowercase kind label as shown in the popover and menu ("brief" / "sitrep").
    var kindLabel: String {
        artifactSchema == "site-bundle/v1" ? "sitrep" : "brief"
    }

    var kindBadge: String {
        artifactSchema == "site-bundle/v1" ? "SitRep" : "Brief"
    }

    /// First 8 hex characters after the "sha256-" prefix, matching the design's short-ID style (e.g. "f9b0c51d").
    var shortId: String {
        let hex = contentId.hasPrefix("sha256-") ? String(contentId.dropFirst("sha256-".count)) : contentId
        return String(hex.prefix(8))
    }

    /// The 64 hex digits of the sha256 content ID, one per fingerprint cell. Empty if the ID isn't a sha256 digest.
    var fingerprintDigits: [UInt8] {
        let hex = contentId.hasPrefix("sha256-") ? String(contentId.dropFirst("sha256-".count)) : contentId
        guard hex.count == 64 else { return [] }
        return hex.compactMap { UInt8($0.hexDigitValue ?? -1) }
    }
}

struct ServiceSummary: Codable, Equatable, Sendable {
    var state: String
    var visibility: String?
    var pid: Int?
    var storeRoot: String?
    var urls: [String]
    var preferredBaseUrl: String?
    var stateDir: String
    /// status/v1: integrity-failure reads counted from the service's events.jsonl. `since` is
    /// "service-start" (anchored at `at`) or "all-time" (`at` null); read it before `count`.
    var refusedToServe: RefusedToServe?
}

struct RefusedToServe: Codable, Equatable, Sendable {
    var since: String
    var at: String?
    var count: Int
}

// MARK: - `canon alias verify <name> --json` (alias-verify/v1)

struct AliasVerifyError: Codable, Equatable, Sendable, Hashable {
    var code: String
    var path: String
    var message: String
}

struct AliasVerifyResult: Codable, Equatable, Sendable {
    var name: String
    var contentId: String
    var generation: Int
    var verify: String
    var verifyDepth: String
    var fileCount: Int?
    var totalBytes: Int?
    var manifestSha256: String?
    var errors: [AliasVerifyError]?
}

/// One Verify now run as the drift card shows it: the decoded result when the CLI printed one,
/// the exit status, and stderr when it printed nothing usable (e.g. "alias … not found").
struct VerifyRun: Equatable, Sendable {
    var exitCode: Int32
    var result: AliasVerifyResult?
    var message: String?
}

// MARK: - `canon activity --json` (activity/v1)

/// Loose JSON for `service` items' `detail`, which is the raw event record.
enum JSONValue: Codable, Equatable, Sendable {
    case string(String), number(Double), bool(Bool), object([String: JSONValue]), array([JSONValue]), null

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        if c.decodeNil() { self = .null }
        else if let b = try? c.decode(Bool.self) { self = .bool(b) }
        else if let n = try? c.decode(Double.self) { self = .number(n) }
        else if let s = try? c.decode(String.self) { self = .string(s) }
        else if let a = try? c.decode([JSONValue].self) { self = .array(a) }
        else { self = .object(try c.decode([String: JSONValue].self)) }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .object(let o): try c.encode(o)
        case .array(let a): try c.encode(a)
        case .null: try c.encodeNil()
        }
    }

    subscript(key: String) -> JSONValue? {
        if case .object(let o) = self { return o[key] }
        return nil
    }

    var string: String? {
        switch self {
        case .string(let s): return s
        case .number(let n): return n == n.rounded() ? String(Int(n)) : String(n)
        case .bool(let b): return b ? "true" : "false"
        default: return nil
        }
    }
}

struct ActivityItem: Codable, Equatable, Sendable, Identifiable {
    var at: String
    var kind: String // publish | alias | service | verify-failure
    var summary: String?
    var contentId: String?
    var outcome: String?
    var errorClass: String?
    var name: String?
    var generation: Int?
    var previousContentId: String?
    var event: String?
    var detail: JSONValue?
    var path: String?

    /// Items have no id of their own; `at` plus kind plus subject is unique in practice, and
    /// the index from the feed disambiguates ties.
    var id: String { "\(at)|\(kind)|\(name ?? contentId ?? event ?? "")|\(path ?? "")" }

    var date: Date? { ActivityItem.parse(at) }

    static func parse(_ iso: String) -> Date? {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let d = f.date(from: iso) { return d }
        f.formatOptions = [.withInternetDateTime]
        return f.date(from: iso)
    }
}

struct ActivityFeed: Codable, Equatable, Sendable {
    var items: [ActivityItem]
    var skipped: Int
    var truncated: Bool
}

/// "sha256-f9b0c51d…" → "f9b0c51d", the design's short-ID style.
func shortContentId(_ id: String) -> String {
    let hex = id.hasPrefix("sha256-") ? String(id.dropFirst("sha256-".count)) : id
    return String(hex.prefix(8))
}

struct ProfileSummary: Codable, Equatable, Sendable {
    var configured: Bool
    var path: String?
    var exposure: String?
    var port: Int?
    var tailscale: TailscalePin?
}

struct CanonStatusPayload: Codable, Equatable, Sendable {
    var profile: ProfileSummary
    var storeRoot: String
    var service: ServiceSummary?
    var aliases: [AliasSummary]
}

private struct TailscaleStatusJSON: Decodable {
    struct PeerSelf: Decodable {
        var DNSName: String?
    }
    var `Self`: PeerSelf?
}

// MARK: - Shell Runner (Off-Main-Thread)

struct CommandOutcome: Sendable {
    let exitCode: Int32
    let stdout: String
    let stderr: String
}

enum ShellRunner {
    static var homeDirectory: String {
        FileManager.default.homeDirectoryForCurrentUser.path
    }

    static var canonHome: String {
        if let override = ProcessInfo.processInfo.environment["CANON_HOME"], !override.isEmpty {
            return override
        }
        return (homeDirectory as NSString).appendingPathComponent(".canon")
    }

    static func enrichedEnvironment() -> [String: String] {
        var env = ProcessInfo.processInfo.environment
        let extra = [
            (homeDirectory as NSString).appendingPathComponent(".local/bin"),
            "/opt/homebrew/bin",
            "/usr/local/bin",
            "/usr/bin",
            "/bin",
            "/usr/sbin",
            "/sbin",
        ]
        let existing = (env["PATH"] ?? "").split(separator: ":").map(String.init)
        var merged: [String] = []
        for entry in extra + existing where !entry.isEmpty && !merged.contains(entry) {
            merged.append(entry)
        }
        env["PATH"] = merged.joined(separator: ":")
        env["CANON_HOME"] = canonHome
        return env
    }

    static func findExecutable(_ name: String) -> String? {
        let env = enrichedEnvironment()
        let searchPaths = (env["PATH"] ?? "").split(separator: ":").map(String.init)
        for dir in searchPaths {
            let candidate = (dir as NSString).appendingPathComponent(name)
            if FileManager.default.isExecutableFile(atPath: candidate) {
                return candidate
            }
        }
        return nil
    }

    /// Dev override: `CANON_CLI=<path>` runs that CLI instead of the `canon` on PATH — an
    /// executable, or a `.mjs`/`.js` entry point run with `node` (e.g. a Core worktree's
    /// `src/cli.mjs`). Unset in normal use; the user's config is never involved.
    static var cliOverride: String? {
        guard let value = ProcessInfo.processInfo.environment["CANON_CLI"], !value.isEmpty else { return nil }
        return value
    }

    static func runCanon(_ arguments: [String]) async -> CommandOutcome {
        if let override = cliOverride {
            if override.hasSuffix(".mjs") || override.hasSuffix(".js") {
                guard let nodeBin = findExecutable("node") else {
                    return CommandOutcome(exitCode: 127, stdout: "", stderr: "CANON_CLI needs `node` on PATH")
                }
                return await runProcess(executable: nodeBin, arguments: [override] + arguments)
            }
            return await runProcess(executable: override, arguments: arguments)
        }
        if let canonBin = findExecutable("canon") {
            return await runProcess(executable: canonBin, arguments: arguments)
        }
        // Dev builds only: build-app.sh writes this checkout's src/cli.mjs here. Release builds
        // have no such key, so they use the `canon` on PATH (Homebrew: /opt/homebrew/bin on
        // Apple silicon, /usr/local/bin on Intel).
        if let nodeBin = findExecutable("node"),
           let script = Bundle.main.object(forInfoDictionaryKey: "CanonFallbackCliScript") as? String,
           FileManager.default.fileExists(atPath: script) {
            return await runProcess(executable: nodeBin, arguments: [script] + arguments)
        }
        return CommandOutcome(
            exitCode: 127,
            stdout: "",
            stderr: "Unable to locate `canon` or `node` on PATH (~/.local/bin, /opt/homebrew/bin, /usr/local/bin)."
        )
    }

    static func detectTailscaleNode() async -> Result<TailscalePin, Error> {
        guard let tsBin = findExecutable("tailscale") else {
            return .failure(NSError(domain: "CanonBar", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "tailscale CLI not found in /usr/local/bin or /opt/homebrew/bin"
            ]))
        }
        let ipRes = await runProcess(executable: tsBin, arguments: ["ip", "-4"])
        guard ipRes.exitCode == 0 else {
            let msg = ipRes.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            return .failure(NSError(domain: "CanonBar", code: 2, userInfo: [
                NSLocalizedDescriptionKey: msg.isEmpty ? "tailscale ip -4 exited \(ipRes.exitCode)" : msg
            ]))
        }
        let ipv4 = ipRes.stdout
            .split(whereSeparator: \.isNewline)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .first ?? ""

        let stRes = await runProcess(executable: tsBin, arguments: ["status", "--json"])
        guard stRes.exitCode == 0,
              let data = stRes.stdout.data(using: .utf8),
              let parsed = try? JSONDecoder().decode(TailscaleStatusJSON.self, from: data),
              let rawDns = parsed.Self?.DNSName else {
            return .failure(NSError(domain: "CanonBar", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "Unable to read Self.DNSName from tailscale status --json"
            ]))
        }
        let dns = rawDns.trimmingCharacters(in: CharacterSet(charactersIn: ". \t\r\n")).lowercased()
        guard !ipv4.isEmpty, !dns.isEmpty else {
            return .failure(NSError(domain: "CanonBar", code: 4, userInfo: [
                NSLocalizedDescriptionKey: "Tailscale returned empty IPv4 or MagicDNS name"
            ]))
        }
        return .success(TailscalePin(address: ipv4, name: dns))
    }

    static func runProcess(executable: String, arguments: [String]) async -> CommandOutcome {
        await Task.detached(priority: .userInitiated) {
            let proc = Process()
            proc.executableURL = URL(fileURLWithPath: executable)
            proc.arguments = arguments
            proc.environment = enrichedEnvironment()

            let outPipe = Pipe()
            let errPipe = Pipe()
            proc.standardOutput = outPipe
            proc.standardError = errPipe

            do {
                try proc.run()
            } catch {
                return CommandOutcome(exitCode: 127, stdout: "", stderr: error.localizedDescription)
            }

            let outTask = Task.detached {
                outPipe.fileHandleForReading.readDataToEndOfFile()
            }
            let errTask = Task.detached {
                errPipe.fileHandleForReading.readDataToEndOfFile()
            }

            proc.waitUntilExit()
            let outData = await outTask.value
            let errData = await errTask.value
            return CommandOutcome(
                exitCode: proc.terminationStatus,
                stdout: String(data: outData, encoding: .utf8) ?? "",
                stderr: String(data: errData, encoding: .utf8) ?? ""
            )
        }.value
    }

    /// Read-only GET, used only to show the footer's `/healthz` status; never mutates service state.
    static func fetchHealthz(baseUrl: String) async -> Int? {
        guard let url = URL(string: "\(baseUrl)/healthz") else { return nil }
        var request = URLRequest(url: url)
        request.timeoutInterval = 2.5
        request.httpMethod = "GET"
        return await withCheckedContinuation { continuation in
            let task = URLSession.shared.dataTask(with: request) { _, response, _ in
                let code = (response as? HTTPURLResponse)?.statusCode
                continuation.resume(returning: code)
            }
            task.resume()
        }
    }
}

// MARK: - Directory Watcher (FSEvents / kqueue DispatchSource)

final class DirectoryMonitor {
    private var sources: [DispatchSourceFileSystemObject] = []
    private let queue = DispatchQueue(label: "dev.oncanon.Canon.fswatch")
    private var debounceWork: DispatchWorkItem?

    func watch(paths: [String], onChange: @escaping @Sendable () -> Void) {
        stop()
        for path in paths {
            try? FileManager.default.createDirectory(atPath: path, withIntermediateDirectories: true)
            let fd = open(path, O_EVTONLY)
            guard fd >= 0 else { continue }
            let src = DispatchSource.makeFileSystemObjectSource(
                fileDescriptor: fd,
                eventMask: [.write, .rename, .delete, .attrib, .extend],
                queue: queue
            )
            src.setEventHandler { [weak self] in
                self?.debounceWork?.cancel()
                let item = DispatchWorkItem { onChange() }
                self?.debounceWork = item
                self?.queue.asyncAfter(deadline: .now() + .milliseconds(250), execute: item)
            }
            src.setCancelHandler {
                close(fd)
            }
            src.resume()
            sources.append(src)
        }
    }

    func stop() {
        debounceWork?.cancel()
        for src in sources {
            src.cancel()
        }
        sources.removeAll()
    }

    deinit {
        stop()
    }
}
