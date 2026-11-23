import AppKit
import Carbon.HIToolbox

/// The ⌃⌥C "Open popover" shortcut shown in Settings/General (page10). A Carbon hot key is
/// the system's registration API for app-wide shortcuts: it needs no Accessibility permission
/// and only fires for this exact chord, unlike a global key-event monitor.
@MainActor
final class GlobalHotKey {
    private var hotKeyRef: EventHotKeyRef?
    private var handlerRef: EventHandlerRef?
    private let action: () -> Void

    private static var active: GlobalHotKey?
    private static let signature: OSType = 0x43_4E_4E_42 // 'CNNB'

    init(keyCode: Int, modifiers: Int, action: @escaping () -> Void) {
        self.action = action
        var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
        InstallEventHandler(GetApplicationEventTarget(), { _, _, _ in
            DispatchQueue.main.async { GlobalHotKey.active?.action() }
            return noErr
        }, 1, &spec, nil, &handlerRef)
        let id = EventHotKeyID(signature: Self.signature, id: 1)
        let status = RegisterEventHotKey(UInt32(keyCode), UInt32(modifiers), id, GetApplicationEventTarget(), 0, &hotKeyRef)
        if status != noErr {
            NSLog("Canon: could not register the ⌃⌥C shortcut (OSStatus \(status)); another app may own it")
        }
        Self.active = self
    }

    /// ⌃⌥C, as displayed in Settings › General › Open popover.
    static func openPopover(action: @escaping () -> Void) -> GlobalHotKey {
        GlobalHotKey(keyCode: kVK_ANSI_C, modifiers: controlKey | optionKey, action: action)
    }
}
