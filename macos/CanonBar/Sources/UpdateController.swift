import AppKit
import Combine
import Sparkle

/// Sparkle 2 updates, through `SPUStandardUpdaterController` and its standard windows.
///
/// Updates are on only when Info.plist has both `SUFeedURL` and `SUPublicEDKey`. A release build
/// (`build-app.sh --release`) writes both; a dev build writes neither, so it never checks, its
/// "Check for Updates…" item is disabled and its Settings toggle says why.
@MainActor
final class UpdateController: ObservableObject {
    /// True when this build has an update feed and a public key.
    let isAvailable: Bool
    /// Mirrors `SPUUpdater.canCheckForUpdates`: false while a check or an install is running.
    @Published private(set) var canCheckForUpdates = false
    /// Mirrors `SPUUpdater.automaticallyChecksForUpdates`, which Sparkle keeps in user defaults.
    @Published private(set) var automaticallyChecksForUpdates = false

    private let standard: SPUStandardUpdaterController?
    private var observations: [AnyCancellable] = []

    /// - Parameter startsUpdater: false for the debug exports, so an export never checks the
    ///   feed; the toggle still shows the stored setting.
    init(startsUpdater: Bool) {
        let info = Bundle.main.infoDictionary ?? [:]
        let feed = (info["SUFeedURL"] as? String) ?? ""
        let key = (info["SUPublicEDKey"] as? String) ?? ""
        isAvailable = !feed.isEmpty && !key.isEmpty
        guard isAvailable else {
            standard = nil
            return
        }
        let standard = SPUStandardUpdaterController(
            startingUpdater: startsUpdater,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
        self.standard = standard
        let updater = standard.updater
        canCheckForUpdates = updater.canCheckForUpdates
        automaticallyChecksForUpdates = updater.automaticallyChecksForUpdates
        updater.publisher(for: \.canCheckForUpdates)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] value in self?.canCheckForUpdates = value }
            .store(in: &observations)
        updater.publisher(for: \.automaticallyChecksForUpdates)
            .receive(on: DispatchQueue.main)
            .sink { [weak self] value in self?.automaticallyChecksForUpdates = value }
            .store(in: &observations)
    }

    /// The updater's state now, not the last published value. The right-click menu is built when it
    /// opens, so it reads this.
    var canCheckForUpdatesNow: Bool {
        standard?.updater.canCheckForUpdates ?? false
    }

    /// The right-click menu's "Check for Updates…". The app is an agent (`LSUIElement`), so it
    /// activates first; otherwise Sparkle's window opens behind the front app.
    func checkForUpdates() {
        guard let standard else { return }
        NSApp.activate(ignoringOtherApps: true)
        standard.checkForUpdates(nil)
    }

    /// Settings › General › "Automatically check for updates".
    func setAutomaticallyChecksForUpdates(_ value: Bool) {
        standard?.updater.automaticallyChecksForUpdates = value
    }
}
