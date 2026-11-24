import AppKit
import SwiftUI

/// The five Settings tabs, in order. Only General is built in P1; the other tabs say so.
///
/// Settings follows native macOS, not the design plates: system colours, system fonts and
/// stock controls only. The overlay (StatusPanel, PopoverView) keeps the plates' theme.
enum SettingsTab: String, CaseIterable, Identifiable {
    case general, server, visibility, notifications, about
    var id: String { rawValue }

    var label: String {
        switch self {
        case .general: return "General"
        case .server: return "Server"
        case .visibility: return "Visibility"
        case .notifications: return "Notifications"
        case .about: return "About"
        }
    }

    var symbol: String {
        switch self {
        case .general: return "gearshape"
        case .server: return "server.rack"
        case .visibility: return "eye"
        case .notifications: return "bell"
        case .about: return "info.circle"
        }
    }
}

/// The content of the `Settings` scene: a stock `TabView`, which the scene shows as the standard
/// toolbar of tabs with the window title following the tab, and a grouped `Form` per tab.
///
/// The design's "not settings" are not here on purpose: no switch for verify-on-read, no saved
/// grants, no repair and no delete.
struct SettingsView: View {
    @ObservedObject var controller: PublisherController
    @ObservedObject var updates: UpdateController
    /// In memory only, as in pass 12: a new launch opens on General.
    @State private var tab: SettingsTab = .general

    static let width: CGFloat = 520

    var body: some View {
        TabView(selection: $tab) {
            ForEach(SettingsTab.allCases) { tab in
                Group {
                    if tab == .general {
                        GeneralSettings(controller: controller, updates: updates)
                    } else {
                        NotBuiltSettings(tab: tab)
                    }
                }
                .tabItem { Label(tab.label, systemImage: tab.symbol) }
                .tag(tab)
            }
        }
        .frame(width: Self.width)
    }
}

/// Settings › General.
private struct GeneralSettings: View {
    @ObservedObject var controller: PublisherController
    @ObservedObject var updates: UpdateController
    @AppStorage("showVisibilityBadge") private var showVisibilityBadge: Bool = true

    var body: some View {
        let cli = StoreFacts.cli()
        Form {
            Section("Canon") {
                Toggle("Launch at login", isOn: Binding(
                    get: { controller.launchAtLoginEnabled },
                    set: { _ in controller.toggleLaunchAtLogin() }
                ))
                LabeledContent {
                    Text("⌃⌥C").monospaced()
                } label: {
                    Text("Open popover")
                    Text("Works from any app.")
                }
                Toggle(isOn: $showVisibilityBadge) {
                    Text("Show visibility badge")
                    Text("On the menu-bar icon.")
                }
                Toggle(isOn: Binding(
                    get: { updates.automaticallyChecksForUpdates },
                    set: { updates.setAutomaticallyChecksForUpdates($0) }
                )) {
                    Text("Automatically check for updates")
                    Text(updates.isAvailable ? "From oncanon.dev, signed by Canon." : "Not available in development builds.")
                }
                .disabled(!updates.isAvailable)
            }

            Section("Store") {
                LabeledContent("Location") {
                    Text(verbatim: StoreFacts.tildePath(ShellRunner.canonHome))
                        .monospaced()
                        .textSelection(.enabled)
                }
                HStack {
                    Spacer()
                    // Store relocation is not built (P2); the control is shown, disabled.
                    Button("Change…") {}.disabled(true)
                    Button("Reveal in Finder") {
                        NSWorkspace.shared.open(URL(fileURLWithPath: ShellRunner.canonHome))
                    }
                }
                LabeledContent {
                    Text(verbatim: contentsLine)
                } label: {
                    Text("Contents")
                    Text("Editions are never deleted by Canon.")
                }
            }

            Section("Command-line tool") {
                LabeledContent {
                    Text(verbatim: cli.map { "\($0.version ?? "?") · \(StoreFacts.tildePath($0.path))" } ?? "Not installed")
                        .monospaced()
                        .lineLimit(1)
                        .truncationMode(.middle)
                        .textSelection(.enabled)
                } label: {
                    Text("canon")
                    Text(cliCaption(cli))
                }
                HStack {
                    Spacer()
                    // The installer is P3; shown, disabled.
                    Button("Reinstall…") {}.disabled(true)
                }
            }
        }
        .formStyle(.grouped)
        .fixedSize(horizontal: false, vertical: true)
    }

    private var contentsLine: String {
        let aliases = controller.aliases.count
        let root = controller.profile?.storeRoot ?? (ShellRunner.canonHome as NSString).appendingPathComponent("store")
        let editions = StoreFacts.editionCount(storeRoot: root)
        let a = "\(aliases) \(aliases == 1 ? "alias" : "aliases")"
        guard let editions else { return a }
        return a + " · \(editions) \(editions == 1 ? "edition" : "editions")"
    }

    private func cliCaption(_ cli: (path: String, version: String?)?) -> String {
        guard let cli else { return "canon was not found on PATH." }
        guard let v = cli.version else { return "Version unknown." }
        return v == StoreFacts.appVersion ? "Same version as the app." : "App is \(StoreFacts.appVersion ?? "?")."
    }
}

/// A tab that is not built yet.
private struct NotBuiltSettings: View {
    let tab: SettingsTab

    var body: some View {
        Form {
            Section {
                LabeledContent {
                    EmptyView()
                } label: {
                    Text("Not built yet")
                    Text("This tab arrives in a later phase.")
                }
            }
        }
        .formStyle(.grouped)
        .fixedSize(horizontal: false, vertical: true)
    }
}
