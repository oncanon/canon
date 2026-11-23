import AppKit
import SwiftUI

/// The page06 card: radius 12px, `box-shadow: 0 22px 48px rgba(15, 23, 42, 0.22)`. Shared by
/// the live panel and `--export-popover`, so the evidence and the menu-bar surface can't drift
/// apart.
///
/// The edge is a hairline of rgba(15, 23, 42, 0.24) inside the card, not the plate's 1px
/// #94a3b8: on the plate's pale backdrop that grey is invisible, but on a dark desktop or over
/// the dark header band it reads as a white rim. The ink hairline still separates the card from
/// light windows and disappears on dark ones. Content is flattened and clipped once, and the
/// stroke uses the same shape, so no white body shows at the rounded corners of the dark band.
struct PopoverCard: View {
    @ObservedObject var controller: PublisherController
    var onOpenSettings: () -> Void
    /// The export draws the card on its own; the panel adds the plate's drop shadow.
    var withShadow: Bool = false

    static let cornerRadius: CGFloat = 12
    static let edge = Color(red: 15 / 255, green: 23 / 255, blue: 42 / 255).opacity(0.24)
    /// CSS blur 48px is a Gaussian with sigma 24; SwiftUI's `radius` is that sigma.
    static let shadowRadius: CGFloat = 24
    static let shadowY: CGFloat = 22
    /// Transparent margin around the card so the shadow isn't clipped by the window edge.
    static let shadowInsets = NSEdgeInsets(
        top: max(0, shadowRadius * 2 - shadowY), left: shadowRadius * 2,
        bottom: shadowRadius * 2 + shadowY, right: shadowRadius * 2
    )

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: Self.cornerRadius, style: .circular)
        let card = PopoverView(controller: controller, onOpenSettings: onOpenSettings)
            // Flatten first: clipping the layers one by one antialiases the white body and the
            // dark band separately, and the white shows as a pale ring at the band's corners.
            .compositingGroup()
            .clipShape(shape)
            .overlay(shape.strokeBorder(Self.edge, lineWidth: 1))
        if withShadow {
            card
                .shadow(color: Color(red: 15 / 255, green: 23 / 255, blue: 42 / 255).opacity(0.22),
                        radius: Self.shadowRadius, x: 0, y: Self.shadowY)
                .padding(EdgeInsets(top: Self.shadowInsets.top, leading: Self.shadowInsets.left,
                                    bottom: Self.shadowInsets.bottom, trailing: Self.shadowInsets.right))
        } else {
            card
        }
    }
}

/// Borderless, non-activating panel that replaces `NSPopover`, so the card opens without the
/// popover's arrow (page06 draws none). It can become key, so Esc and the popover's own
/// keyboard shortcuts reach it, without activating the app or stealing focus from the
/// frontmost app.
final class StatusPanel: NSPanel {
    var onCancel: (() -> Void)?

    init() {
        super.init(
            contentRect: .zero,
            styleMask: [.borderless, .nonactivatingPanel],
            backing: .buffered,
            defer: true
        )
        isOpaque = false
        backgroundColor = .clear
        hasShadow = false // the plate's shadow is drawn by `PopoverCard`
        // page06 only: light body and dark band in every system appearance, menus included.
        appearance = NSAppearance(named: .aqua)
        isFloatingPanel = true // sets .floating; the level below must come after it
        level = .statusBar
        hidesOnDeactivate = false
        isReleasedWhenClosed = false
        isMovable = false
        animationBehavior = .utilityWindow
        collectionBehavior = [.moveToActiveSpace, .fullScreenAuxiliary, .transient, .ignoresCycle]
    }

    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { false }

    /// AppKit keeps a window's frame below the menu bar. The card itself is placed below the
    /// menu bar already; only the transparent shadow margin above it reaches into the bar, so
    /// the frame is used as computed.
    override func constrainFrameRect(_ frameRect: NSRect, to screen: NSScreen?) -> NSRect {
        frameRect
    }

    override func cancelOperation(_ sender: Any?) {
        onCancel?()
    }
}

/// A hosting view that tells its owner when SwiftUI's ideal size changes. Some size changes
/// come from view-local state (the Activity list measuring itself, Verify now's results) and
/// not from the controller, so `contentDidChange()` alone would miss them.
final class FittingHostingView<Content: View>: NSHostingView<Content> {
    var onFittingSizeChange: (() -> Void)?

    override func invalidateIntrinsicContentSize() {
        super.invalidateIntrinsicContentSize()
        onFittingSizeChange?()
    }
}

/// Shows, positions and dismisses the `StatusPanel` under the status item.
@MainActor
final class StatusPanelController: NSObject, NSWindowDelegate {
    /// page06: the card sits 6px below the menu bar (`margin: 6px 12px 0 0`).
    static let gapBelowMenuBar: CGFloat = 6
    /// …and 12px from the screen edge when it would otherwise run off it.
    static let screenMargin: CGFloat = 12

    private let panel = StatusPanel()
    private let hosting: FittingHostingView<PopoverCard>
    private let controller: PublisherController
    private weak var statusButton: NSStatusBarButton?
    private var globalMonitor: Any?
    private var localMonitor: Any?

    var isShown: Bool { panel.isVisible }

    init(controller: PublisherController, statusButton: NSStatusBarButton?, onOpenSettings: @escaping () -> Void) {
        hosting = FittingHostingView(rootView: PopoverCard(controller: controller, onOpenSettings: onOpenSettings, withShadow: true))
        self.controller = controller
        self.statusButton = statusButton
        super.init()
        hosting.onFittingSizeChange = { [weak self] in self?.contentDidChange() }
        panel.contentView = hosting
        panel.delegate = self
        panel.onCancel = { [weak self] in self?.close() }
    }

    func toggle() {
        isShown ? close() : show()
    }

    func show() {
        layout()
        panel.makeKeyAndOrderFront(nil)
        // AppKit clears the button's highlight when its mouse tracking ends, so set it after.
        DispatchQueue.main.async { [weak self] in
            guard let self, self.isShown else { return }
            self.statusButton?.highlight(true)
        }
        installMonitors()
    }

    func close() {
        guard isShown else { return }
        removeMonitors()
        panel.orderOut(nil)
        statusButton?.highlight(false)
        // A drill-in is a step inside one opening of the panel; the next opening starts at home.
        controller.showHome()
    }

    /// Re-fits the panel to its content (alias list loading, visibility changes) with its top
    /// edge pinned under the menu bar.
    func contentDidChange() {
        guard isShown else { return }
        DispatchQueue.main.async { [weak self] in self?.layout() }
    }

    // MARK: Positioning

    private func layout() {
        let size = hosting.fittingSize
        let insets = PopoverCard.shadowInsets
        let cardSize = NSSize(width: size.width - insets.left - insets.right,
                              height: size.height - insets.top - insets.bottom)
        let (anchor, screen) = anchorRect()
        let visible = screen.visibleFrame

        // Left-align the card with the status item; clamp it into the visible frame of the
        // screen the status item is on (each display has its own menu bar).
        var cardX = anchor.minX
        cardX = min(cardX, visible.maxX - Self.screenMargin - cardSize.width)
        cardX = max(cardX, visible.minX + Self.screenMargin)
        let cardTop = min(anchor.minY, visible.maxY) - Self.gapBelowMenuBar
        var cardY = cardTop - cardSize.height
        cardY = max(cardY, visible.minY + Self.screenMargin) // a very long card stays on screen

        let frame = NSRect(x: cardX - insets.left, y: cardY - insets.bottom,
                           width: size.width, height: size.height)
        panel.setFrame(frame, display: true)
    }

    /// The status button's frame in screen coordinates and its screen. If the item has no
    /// on-screen frame (hidden in menu-bar overflow and opened from ⌃⌥C), falls back to the
    /// top-right corner of the screen with the menu bar.
    private func anchorRect() -> (NSRect, NSScreen) {
        if let button = statusButton, let window = button.window, let screen = window.screen {
            let rect = window.convertToScreen(button.convert(button.bounds, to: nil))
            if screen.frame.intersects(rect) {
                return (rect, screen)
            }
        }
        let screen = NSScreen.screens.first ?? NSScreen.main!
        let visible = screen.visibleFrame
        return (NSRect(x: visible.maxX, y: visible.maxY, width: 0, height: 0), screen)
    }

    /// The card's rect in the panel's own coordinates (the rest is transparent shadow margin).
    private var cardRectInWindow: NSRect {
        let insets = PopoverCard.shadowInsets
        let bounds = panel.contentView?.bounds ?? .zero
        return NSRect(x: insets.left, y: insets.bottom,
                      width: bounds.width - insets.left - insets.right,
                      height: bounds.height - insets.top - insets.bottom)
    }

    // MARK: Dismissal

    private func installMonitors() {
        removeMonitors()
        // Clicks in other apps.
        globalMonitor = NSEvent.addGlobalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] _ in
            Task { @MainActor in self?.close() }
        }
        // Clicks in this app outside the card: other windows, or the panel's shadow margin.
        // Clicks on the status button are left to its own action, which toggles or shows the
        // right-click menu.
        localMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown, .otherMouseDown]) { [weak self] event in
            guard let self else { return event }
            if self.isOnStatusButton(event) {
                return event
            }
            if event.window === self.panel, NSPointInRect(event.locationInWindow, self.cardRectInWindow) {
                return event
            }
            self.close()
            return event
        }
    }

    private func removeMonitors() {
        if let globalMonitor { NSEvent.removeMonitor(globalMonitor) }
        if let localMonitor { NSEvent.removeMonitor(localMonitor) }
        globalMonitor = nil
        localMonitor = nil
    }

    // MARK: NSWindowDelegate

    /// Focus moved elsewhere (another app, Settings, Mission Control): dismiss, as the
    /// transient popover did.
    func windowDidResignKey(_ notification: Notification) {
        // A press on the status item itself is handled by its action (toggle / right-click
        // menu); closing here too would make the toggle reopen the panel.
        if let event = NSApp.currentEvent, isOnStatusButton(event) { return }
        close()
    }

    private func isOnStatusButton(_ event: NSEvent) -> Bool {
        guard let buttonWindow = statusButton?.window else { return false }
        return event.window === buttonWindow
    }
}
