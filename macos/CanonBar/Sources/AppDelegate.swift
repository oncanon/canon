import AppKit
import Combine
import SwiftUI

/// Owns the `NSStatusItem` and distinguishes left-click (the popover, page06) from right-click
/// (the plain system menu, page07 plate 2) — something SwiftUI's `MenuBarExtra` can't do with a
/// single content closure, which is why this app drives AppKit directly instead.
@MainActor
final class AppDelegate: NSObject, NSApplicationDelegate {
    /// Computed once, directly from `CommandLine.arguments`, so the controller below can be
    /// constructed read-only in the same expression — no window exists where it could first
    /// come up in its normal, mutating mode before the debug-export check runs.
    static let isDebugExportRun: Bool = {
        let args = CommandLine.arguments
        return args.contains("--export-icons") || args.contains("--export-popover")
            || args.contains("--export-settings") || args.contains("--export-menu")
    }()

    /// `--read-only`: a normal interactive launch whose controller never creates or writes
    /// `~/.canon`, never reconciles the service and installs no watchers — the same mode the
    /// exports use. For running a review copy beside the installed app without touching the
    /// live service. `CANON_APP_READ_ONLY=1` in the environment does the same; unlike an
    /// argument, it survives a relaunch, so a test build that sets it in `LSEnvironment` stays
    /// read-only after Sparkle installs an update and relaunches it.
    static let isReadOnlyRun: Bool = isDebugExportRun
        || CommandLine.arguments.contains("--read-only")
        || ProcessInfo.processInfo.environment["CANON_APP_READ_ONLY"] == "1"

    let controller = PublisherController(readOnly: AppDelegate.isReadOnlyRun)
    /// Sparkle. The debug exports never start it, so an export never checks the feed.
    let updates = UpdateController(startsUpdater: !AppDelegate.isDebugExportRun)

    private var statusItem: NSStatusItem!
    private var panel: StatusPanelController!
    private var hotKey: GlobalHotKey?
    private var previewWindow: NSWindow?
    private var cancellable: AnyCancellable?
    private var defaultsObserver: AnyCancellable?

    func applicationDidFinishLaunching(_ notification: Notification) {
        FontRegistrar.registerBundledFonts()

        if AppDelegate.isDebugExportRun {
            Task {
                await runDebugExports()
                NSApp.terminate(nil)
            }
            return
        }

        statusItem = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        if let button = statusItem.button {
            button.image = StatusIconRenderer.icon(for: .stopped, needsAttention: false)
            button.action = #selector(statusItemClicked(_:))
            button.target = self
            button.sendAction(on: [.leftMouseUp, .rightMouseUp])
        }

        // A borderless panel rather than NSPopover: page06 draws the card with no arrow.
        panel = StatusPanelController(
            controller: controller,
            statusButton: statusItem.button,
            onOpenSettings: { [weak self] in self?.openSettings() }
        )
        hotKey = GlobalHotKey.openPopover { [weak self] in self?.panel.toggle() }

        cancellable = controller.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async { self?.refreshIcon() }
            self?.panel.contentDidChange()
        }
        // Settings › General › "Show visibility badge" writes this default; redraw the icon at once.
        defaultsObserver = NotificationCenter.default.publisher(for: UserDefaults.didChangeNotification)
            .sink { [weak self] _ in DispatchQueue.main.async { self?.refreshIcon() } }
        refreshIcon()

        if CommandLine.arguments.contains("--window") {
            openPreviewWindow()
        }
    }

    /// `--window`: opens the popover's content in a normal, always-visible `NSWindow` so the
    /// surface can be reviewed even when the status item is hidden in macOS's menu-bar overflow.
    private func openPreviewWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 392, height: 640),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false
        )
        window.title = "Canon"
        window.appearance = NSAppearance(named: .aqua) // the panel's content is light-only, as page06
        window.isReleasedWhenClosed = false
        window.contentViewController = NSHostingController(
            rootView: PopoverView(controller: controller, onOpenSettings: { [weak self] in self?.openSettings() })
        )
        window.center()
        window.makeKeyAndOrderFront(nil)
        previewWindow = window
        NSApp.activate(ignoringOtherApps: true)
    }

    private func refreshIcon() {
        let showBadge = (UserDefaults.standard.object(forKey: "showVisibilityBadge") as? Bool) ?? true
        statusItem.button?.image = StatusIconRenderer.icon(
            for: controller.iconVisibilityState,
            needsAttention: controller.needsAttention,
            showBadge: showBadge
        )
    }

    @objc private func statusItemClicked(_ sender: NSStatusBarButton) {
        // An accessibility press (VoiceOver, AXPress) arrives with no mouse event: treat it
        // as the primary action, like a left click.
        if NSApp.currentEvent?.type == .rightMouseUp {
            panel.close()
            let menu = MenuBuilder(controller: controller, updates: updates, target: self).build()
            menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.maxY + 4), in: sender)
        } else {
            panel.toggle()
        }
    }

    /// Opens the `Settings` scene through the app menu's "Settings…" item (`CanonBarApp`), so
    /// the panel row, the right-click menu and ⌘, take one path. AppKit's `showSettingsWindow:`
    /// action is not supported for SwiftUI scenes on macOS 14 and later.
    func openSettings() {
        if let (menu, index) = Self.settingsMenuItem() {
            menu.performActionForItem(at: index)
        } else {
            NSLog("Canon: the app menu has no Settings… item")
        }
    }

    /// Runs before the scene opens, on every path: the panel closes, and the agent app
    /// (`LSUIElement`) activates so the Settings window comes to the front.
    func prepareForSettings() {
        panel?.close()
        NSApp.activate(ignoringOtherApps: true)
    }

    /// The app menu's "Settings…" item: the one with the ⌘, key equivalent.
    static func settingsMenuItem() -> (NSMenu, Int)? {
        guard let appMenu = NSApp.mainMenu?.items.first?.submenu else { return nil }
        for (index, item) in appMenu.items.enumerated()
        where item.keyEquivalent == "," && item.keyEquivalentModifierMask == .command {
            return (appMenu, index)
        }
        return nil
    }

    // MARK: - Menu actions (right-click menu, page07 plate 2)

    @objc func menuOpenAlias(_ sender: NSMenuItem) {
        guard let name = sender.representedObject as? String,
              let alias = controller.aliases.first(where: { $0.name == name }),
              let url = controller.humanUrl(for: alias) else { return }
        controller.openInBrowser(url)
    }

    @objc func menuCopyUrl() {
        if let endpoint = controller.activeEndpoint {
            controller.copyString(endpoint)
        }
    }

    @objc func menuSetVisibility(_ sender: NSMenuItem) {
        guard let target = sender.representedObject as? String else { return }
        controller.setExposure(target)
    }

    @objc func menuOpenStore() {
        controller.openStoreInFinder()
    }

    @objc func menuRestart() {
        controller.restartServer()
    }

    @objc func menuStop() {
        controller.setExposure("stopped")
    }

    @objc func menuCheckForUpdates() {
        panel?.close()
        updates.checkForUpdates()
    }

    @objc func menuOpenSettings() {
        openSettings()
    }

    @objc func menuQuit() {
        NSApplication.shared.terminate(nil)
    }
}
