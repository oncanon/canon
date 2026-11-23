import AppKit

/// The plain system menu for right-click (page07, plate 2) — "for people who never open the
/// popover." Built with AppKit `NSMenu` directly (not SwiftUI) so it renders as a real system
/// menu, matching the design's distinction between the popover's own chrome and this.
@MainActor
final class MenuBuilder {
    private let controller: PublisherController
    private let updates: UpdateController
    private weak var target: AppDelegate?
    private let maxAliasItems = 8

    init(controller: PublisherController, updates: UpdateController, target: AppDelegate) {
        self.controller = controller
        self.updates = updates
        self.target = target
    }

    func build() -> NSMenu {
        let menu = NSMenu()
        menu.autoenablesItems = false

        let header = NSMenuItem(title: headerTitle, action: nil, keyEquivalent: "")
        header.isEnabled = false
        menu.addItem(header)
        menu.addItem(.separator())

        let aliases = controller.sortedAliases
        if aliases.isEmpty {
            let empty = NSMenuItem(title: "No published aliases yet", action: nil, keyEquivalent: "")
            empty.isEnabled = false
            menu.addItem(empty)
        } else {
            for alias in aliases.prefix(maxAliasItems) {
                let item = NSMenuItem(
                    title: "\(alias.displayTitle) — g\(alias.generation)",
                    action: #selector(AppDelegate.menuOpenAlias(_:)),
                    keyEquivalent: ""
                )
                item.target = target
                item.representedObject = alias.name
                item.image = fingerprintThumbnail(for: alias)
                menu.addItem(item)
            }
            if aliases.count > maxAliasItems {
                let more = NSMenuItem(title: "+\(aliases.count - maxAliasItems) more — Open store in Finder", action: nil, keyEquivalent: "")
                more.isEnabled = false
                menu.addItem(more)
            }
        }

        menu.addItem(.separator())

        let copyUrl = NSMenuItem(title: "Copy URL", action: #selector(AppDelegate.menuCopyUrl), keyEquivalent: "c")
        copyUrl.target = target
        copyUrl.isEnabled = controller.activeEndpoint != nil
        menu.addItem(copyUrl)

        let visibility = NSMenuItem(title: "Visibility", action: nil, keyEquivalent: "")
        visibility.submenu = buildVisibilitySubmenu()
        menu.addItem(visibility)

        menu.addItem(.separator())

        let openStore = NSMenuItem(title: "Open store in Finder", action: #selector(AppDelegate.menuOpenStore), keyEquivalent: "o")
        openStore.target = target
        menu.addItem(openStore)

        let restart = NSMenuItem(title: "Restart service", action: #selector(AppDelegate.menuRestart), keyEquivalent: "r")
        restart.target = target
        restart.isEnabled = !controller.isBusy && controller.profile?.exposure != "stopped"
        menu.addItem(restart)

        let stop = NSMenuItem(title: "Stop service", action: #selector(AppDelegate.menuStop), keyEquivalent: "S")
        stop.keyEquivalentModifierMask = [.command, .shift]
        stop.target = target
        stop.isEnabled = !controller.isBusy && controller.profile?.exposure != "stopped"
        menu.addItem(stop)

        menu.addItem(.separator())

        // Sparkle. Disabled in a dev build (no feed) and while a check or an install runs.
        let checkForUpdates = NSMenuItem(title: "Check for Updates…", action: #selector(AppDelegate.menuCheckForUpdates), keyEquivalent: "")
        checkForUpdates.target = target
        checkForUpdates.isEnabled = updates.isAvailable && updates.canCheckForUpdatesNow
        menu.addItem(checkForUpdates)

        let settings = NSMenuItem(title: "Settings…", action: #selector(AppDelegate.menuOpenSettings), keyEquivalent: ",")
        settings.target = target
        menu.addItem(settings)

        let quit = NSMenuItem(title: "Quit Canon", action: #selector(AppDelegate.menuQuit), keyEquivalent: "q")
        quit.target = target
        menu.addItem(quit)

        return menu
    }

    private var headerTitle: String {
        let label = controller.statusHeadline
        let count = controller.aliases.count
        let noun = count == 1 ? "alias" : "aliases"
        return "\(label) · serving \(count) \(noun)"
    }

    private func buildVisibilitySubmenu() -> NSMenu {
        let submenu = NSMenu()
        let current = controller.profile?.exposure

        let loopback = NSMenuItem(title: "Loopback", action: #selector(AppDelegate.menuSetVisibility(_:)), keyEquivalent: "")
        loopback.target = target
        loopback.representedObject = "local"
        loopback.state = current == "local" ? .on : .off
        submenu.addItem(loopback)

        let tailnet = NSMenuItem(title: "Tailnet", action: #selector(AppDelegate.menuSetVisibility(_:)), keyEquivalent: "")
        tailnet.target = target
        tailnet.representedObject = "tailscale"
        tailnet.state = current == "tailscale" ? .on : .off
        submenu.addItem(tailnet)

        let cloud = NSMenuItem(title: "Cloud…", action: nil, keyEquivalent: "")
        cloud.isEnabled = false
        submenu.addItem(cloud)

        return submenu
    }

    /// The fingerprint for the menu item's leading image: the same raster as the panel rows
    /// (FingerprintRaster), at 14pt, with 1x and 2x bitmaps so no edge is resampled.
    private func fingerprintThumbnail(for alias: AliasSummary) -> NSImage {
        FingerprintRaster.nsImage(digits: alias.fingerprintDigits, side: 14)
    }
}
