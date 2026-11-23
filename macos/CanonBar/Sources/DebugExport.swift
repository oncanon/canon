import AppKit
import SwiftUI

/// Evidence-generation flags for the P1 report. None of these mutate `~/.canon` or the running
/// server: icon export only draws shapes, and the view exports make one `canon status` read and
/// one read-only `/healthz` GET (the same calls the running popover makes). The popover is
/// rendered offscreen with `ImageRenderer`. Settings is the real window on screen, captured with
/// `screencapture` (needs Screen Recording); Light and Dark are set on this process only, never
/// on the system.
///
///   Canon --export-icons <dir>      (icon-grid.png laid out like page07 Plate 1)
///   Canon --export-popover <dir>
///   Canon --export-settings <dir>   (Light and Dark; "-increase-contrast" when the system has it on)
///   Canon --export-menu <dir>
///   Canon --window (opens the popover content in a normal NSWindow)
///   Canon --read-only (interactive launch that never writes ~/.canon or touches the service)
@MainActor
extension AppDelegate {
    /// Runs every requested export to completion before returning, so the caller can terminate
    /// the app only once all offscreen rendering (including the async popover/Settings captures)
    /// has actually finished writing its PNGs.
    func runDebugExports() async {
        let args = CommandLine.arguments
        if let dir = argumentValue(args, after: "--export-icons") {
            exportIcons(to: dir)
        }
        if let dir = argumentValue(args, after: "--export-popover") {
            await exportPopover(to: dir)
        }
        if let dir = argumentValue(args, after: "--export-settings") {
            await exportSettings(to: dir)
        }
        if let dir = argumentValue(args, after: "--export-menu") {
            await exportMenu(to: dir)
        }
    }

    private func argumentValue(_ args: [String], after flag: String) -> String? {
        guard let index = args.firstIndex(of: flag), index + 1 < args.count else { return nil }
        return args[index + 1]
    }

    /// Plate-style icon evidence (page07 Plate 1 layout: columns 96 96 52 52 1fr, gap 14): per
    /// state, Light 2× and Dark 2× tiles (88×52) and two 1× tiles (44×26), light and dark. Each
    /// icon is rasterized (72 px for the plate's 36pt 2× magnification, the true 18 px for 1×) from the shipping
    /// template image, tinted the plate's inks, then upscaled without interpolation — so the
    /// export shows exactly the pixels the menu bar draws. Also writes the raw 288pt masters.
    private func exportIcons(to dir: String) {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        for row in IconPlateGrid.rows {
            let image = StatusIconRenderer.icon(for: row.state, needsAttention: row.needsYou, pointSize: 288)
            savePNG(image, to: "\(dir)/icon-\(row.file).png")
        }
        renderAndSave(IconPlateGrid(), colorScheme: .light, to: "\(dir)/icon-grid.png")
    }

    private func exportPopover(to dir: String) async {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        await waitForFirstLoad()
        // The page06 card, shared with the live panel (`StatusPanel.swift`). Light only: the
        // panel has no dark appearance.
        renderAndSave(PopoverCard(controller: controller, onOpenSettings: {}), colorScheme: .light,
                      to: "\(dir)/popover-light.png")
        // Loopback state (page06's plate state). The export run is read-only, so this only
        // changes the in-memory copy of the status the popover draws; nothing is written to the
        // profile or sent to the service.
        if var profile = controller.profile, var service = controller.service {
            profile.exposure = "local"
            service.visibility = "local"
            service.preferredBaseUrl = "http://127.0.0.1:\(profile.port)"
            controller.profile = profile
            controller.service = service
            let card = PopoverCard(controller: controller, onOpenSettings: {})
            renderAndSave(card, colorScheme: .light, to: "\(dir)/popover-light-loopback.png")
        }
    }

    /// Captures the real `Settings` scene window — system titlebar, tab toolbar and grouped
    /// form — in Light and Dark. The appearance is set on this process only (`NSApp.appearance`
    /// and the window); the system setting is not changed. The window is
    /// opaque, so a capture of the window alone (`screencapture -l`, no shadow) shows exactly
    /// what it draws. Needs Screen Recording for the process that launched the app.
    private func exportSettings(to dir: String) async {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        await waitForFirstLoad()
        NSApp.setActivationPolicy(.accessory)
        // Light and Dark, set on this process only. AppKit has no per-process Increase
        // Contrast: `NSAppearance(named: .accessibilityHighContrast…)` returns plain Aqua or
        // Dark Aqua. The label therefore comes from the system setting, so an
        // "-increase-contrast" image exists only when the system really has it on.
        let contrast = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast ? "-increase-contrast" : ""
        let appearances: [(NSAppearance.Name, String)] = [(.aqua, "light" + contrast), (.darkAqua, "dark" + contrast)]
        // The selected tab is in memory only, so a fresh export launch shows General.
        for (name, label) in appearances {
            let appearance = NSAppearance(named: name)
            NSApp.appearance = appearance
            openSettings()
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            guard let window = NSApp.windows.first(where: {
                $0.isVisible && $0.identifier?.rawValue.contains("Settings") == true
            }) ?? NSApp.windows.first(where: { $0.isVisible && $0.title == SettingsTab.general.label }) else {
                NSLog("Canon export: no Settings window appeared")
                continue
            }
            window.appearance = appearance
            window.makeKeyAndOrderFront(nil)
            try? await Task.sleep(nanoseconds: 700_000_000)
            Self.screencapture(windowNumber: window.windowNumber, to: "\(dir)/settings-\(label).png")
            window.close()
            try? await Task.sleep(nanoseconds: 300_000_000)
        }
        NSApp.appearance = nil
    }

    private static func screencapture(windowNumber: Int, to path: String) {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
        proc.arguments = ["-x", "-o", "-l", String(windowNumber), path]
        do {
            try proc.run()
            proc.waitUntilExit()
            if proc.terminationStatus != 0 { NSLog("Canon export: screencapture exited \(proc.terminationStatus) for \(path)") }
        } catch {
            NSLog("Canon export: screencapture failed: \(error)")
        }
    }

    /// Builds the real right-click menu (page07 plate 2) off `MenuBuilder` and dumps its items,
    /// submenus and key equivalents as plain text — evidence of the actual menu contents beyond
    /// reading the source, since an `NSMenu` has no window to screenshot offscreen.
    private func exportMenu(to dir: String) async {
        try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
        await waitForFirstLoad()
        let menu = MenuBuilder(controller: controller, updates: updates, target: self).build()
        let dump = Self.dumpMenu(menu)
        try? dump.write(toFile: "\(dir)/menu.txt", atomically: true, encoding: .utf8)
        // Each item's leading image (the alias fingerprints), as the 1x and 2x bitmaps AppKit
        // draws, so the raster can be checked for seams.
        for (index, item) in menu.items.enumerated() {
            guard let image = item.image else { continue }
            for rep in image.representations.compactMap({ $0 as? NSBitmapImageRep }) {
                guard let data = rep.representation(using: .png, properties: [:]) else { continue }
                let name = item.title.replacingOccurrences(of: "/", with: "-")
                try? data.write(to: URL(fileURLWithPath: "\(dir)/menu-image-\(index)-\(name)-\(rep.pixelsWide)px.png"))
            }
        }
    }

    private static func dumpMenu(_ menu: NSMenu, indent: String = "") -> String {
        var lines: [String] = []
        for item in menu.items {
            if item.isSeparatorItem {
                lines.append("\(indent)---")
                continue
            }
            var line = indent + item.title
            let shortcut = shortcutLabel(for: item)
            if !shortcut.isEmpty {
                line += "  [\(shortcut)]"
            }
            if item.state == .on {
                line += "  (checked)"
            }
            if !item.isEnabled {
                line += "  (disabled)"
            }
            lines.append(line)
            if let submenu = item.submenu {
                lines.append(dumpMenu(submenu, indent: indent + "    "))
            }
        }
        return lines.joined(separator: "\n")
    }

    private static func shortcutLabel(for item: NSMenuItem) -> String {
        guard !item.keyEquivalent.isEmpty else { return "" }
        let mask = item.keyEquivalentModifierMask
        var symbol = ""
        if mask.contains(.control) { symbol += "\u{2303}" }
        if mask.contains(.option) { symbol += "\u{2325}" }
        if mask.contains(.shift) { symbol += "\u{21e7}" }
        if mask.contains(.command) { symbol += "\u{2318}" }
        return symbol + item.keyEquivalent.uppercased()
    }

    private func waitForFirstLoad() async {
        for _ in 0..<40 where controller.profile == nil || controller.service == nil {
            try? await Task.sleep(nanoseconds: 150_000_000)
        }
        // One more beat for the healthz round trip fired from refreshStatus().
        try? await Task.sleep(nanoseconds: 400_000_000)
    }

    private func renderAndSave<V: View>(_ view: V, colorScheme: ColorScheme, to path: String) {
        let renderer = ImageRenderer(content: view.environment(\.colorScheme, colorScheme))
        renderer.scale = 2
        guard let image = renderer.nsImage else { return }
        savePNG(image, to: path)
    }

    private func savePNG(_ image: NSImage, to path: String) {
        guard let tiff = image.tiffRepresentation,
              let rep = NSBitmapImageRep(data: tiff),
              let data = rep.representation(using: .png, properties: [:]) else { return }
        try? data.write(to: URL(fileURLWithPath: path))
    }
}
