import SwiftUI

/// Entry point. The status item, the overlay panel and the right-click menu are AppKit, driven
/// from `AppDelegate`. Settings is the standard SwiftUI `Settings` scene: the system gives it
/// its window and its tab toolbar.
@main
struct CanonBarApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate

    var body: some Scene {
        Settings {
            SettingsView(controller: appDelegate.controller, updates: appDelegate.updates)
        }
        .commands {
            // The one way into Settings: ⌘, and the app menu use this item, and the panel row
            // and the right-click menu run it too (`AppDelegate.openSettings()`). It closes the
            // panel and activates the agent app before the scene opens, so Settings comes to
            // the front from a non-activating panel as well.
            CommandGroup(replacing: .appSettings) {
                SettingsCommand(prepare: { appDelegate.prepareForSettings() })
            }
            // Sparkle's standard place, under "About". The app menu shows while Settings is in
            // front; the right-click menu has the same item (MenuBuilder).
            CommandGroup(after: .appInfo) {
                CheckForUpdatesCommand(updates: appDelegate.updates)
            }
        }
    }
}

/// The app menu's "Settings…" item, ⌘,.
private struct SettingsCommand: View {
    let prepare: () -> Void
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Button("Settings…") {
            prepare()
            openSettings()
        }
        .keyboardShortcut(",", modifiers: .command)
    }
}

/// The app menu's "Check for Updates…".
private struct CheckForUpdatesCommand: View {
    @ObservedObject var updates: UpdateController

    var body: some View {
        Button("Check for Updates…") { updates.checkForUpdates() }
            .disabled(!updates.isAvailable || !updates.canCheckForUpdates)
    }
}
