import AppKit
import SwiftUI

/// Popover home — design-v2 surfaces page06 ("Canon.app v2.1 — menu-bar popover",
/// dbc89149….html). Every size, padding and color below is the CSS value from that file, quoted
/// in the comment next to it; 1 CSS px == 1 pt.
///
/// Verify state and Activity come from Core's status/v1, alias-verify/v1 and activity/v1
/// (`docs/core/app-status-v1.md`, branch core/app-status). Where the CLI reports nothing (an older
/// CLI, or a transient read error) the pill's slot stays empty rather than showing a guess.
struct PopoverView: View {
    @ObservedObject var controller: PublisherController
    var onOpenSettings: () -> Void

    private let list = ListPalette.page06

    /// page09 "Twelve aliases — past 8 rows": the home list's overflow threshold.
    static let maxAliasRows = 8
    /// Width reserved for the Verified/Drift pill (CSS: 9px glyph + 4 gap + Inter 11/600
    /// "Verified" + 6+6 padding + 1+1 border ≈ 72).
    static let pillSlot: CGFloat = 72

    var body: some View {
        Group {
            switch controller.panelRoute {
            case .home:
                VStack(spacing: 0) {
                    header
                    visibility
                    aliasList
                    if let drifted = controller.driftedAliases.first {
                        // margin: 6px 16px 0 (the list above ends with its own 6px padding)
                        DriftCard(controller: controller, alias: drifted,
                                  othersInDrift: controller.driftedAliases.count - 1)
                            .padding(.top, 6)
                            .padding(.horizontal, 16)
                    }
                    actions
                    footer
                }
            case .activity:
                ActivityView(controller: controller)
            }
        }
        .frame(width: 392) // width: 392px
        .background(list.card)
        // page06 has one appearance (light body, dark chrome band), and the panel draws it
        // whatever the system appearance; native controls inside follow this too.
        .environment(\.colorScheme, .light)
    }

    // MARK: Header — background: #0f172a; padding: 14px 16px

    private var header: some View {
        HStack(alignment: .center) {
            HStack(alignment: .center, spacing: 10) { // gap: 10px
                CanonMark().frame(width: 28, height: 28) // svg 28×28
                VStack(alignment: .leading, spacing: 1) { // gap: 1px
                    Text("canon")
                        .font(Theme.serifBold(20)) // Libron 700 20px
                        .foregroundStyle(Color(hex: 0xf1f5f9))
                    Text("Workstation")
                        .font(Theme.sans(12)) // 12px #9ca3af
                        .foregroundStyle(Color(hex: 0x9ca3af))
                }
            }
            Spacer(minLength: 8)
            StatusBadge(status: status)
        }
        .padding(.vertical, 14)
        .padding(.horizontal, 16)
        .background(Color(hex: 0x0f172a))
    }

    private var status: StatusBadge.Status {
        if controller.isBusy { return .reconciling }
        if controller.lastError != nil { return .needsYou }
        if controller.service?.state == "running" { return .healthy }
        return .stopped
    }

    // MARK: Visibility — background: #1b2434; padding: 14px 16px 16px; gap: 12px;
    // border-top: 1px solid #293548

    private var visibility: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                Text("Visibility").font(Theme.sans(12, .semibold)).foregroundStyle(Color(hex: 0xe2e8f0))
                Spacer()
                Text(visNote).font(Theme.sans(12)).foregroundStyle(Color(hex: 0x9ca3af))
            }

            // grid 3 cols, gap 3px, padding 3px, background #0b0f17, border 1px #293548, radius 6.4px
            HStack(spacing: 3) {
                segment("Loopback", id: "local")
                segment("Tailnet", id: "tailscale")
                segment("Cloud…", id: "cloud")
            }
            .padding(3)
            .background(Color(hex: 0x0b0f17))
            .overlay(RoundedRectangle(cornerRadius: 6.4).strokeBorder(Color(hex: 0x293548), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 6.4))

            urlRow

            reachability
        }
        .padding(.top, 14)
        .padding(.horizontal, 16)
        .padding(.bottom, 16)
        .background(Color(hex: 0x1b2434))
        .overlay(Rectangle().fill(Color(hex: 0x293548)).frame(height: 1), alignment: .top)
    }

    private var visNote: String {
        switch controller.profile?.exposure {
        case "tailscale": return "your tailnet"
        case "local": return "this Mac only"
        default: return "stopped"
        }
    }

    /// base: height 32px; radius 4.5px; font-size 13px.
    /// on.loopback: #f1f5f9 / #0f172a / 600 · on.tailnet: #60a5fa / #0b0f17 / 600 ·
    /// on.cloud: #b45309 / #ffffff / 600 · off: transparent / #e2e8f0 / 500.
    /// Cloud… is the P4 gate: it keeps the plate's off styling but has no action until the maintainer
    /// authorizes a public target.
    private func segment(_ title: String, id: String) -> some View {
        let selected = controller.profile?.exposure == id
        let (bg, fg): (Color, Color) = {
            guard selected else { return (.clear, Color(hex: 0xe2e8f0)) }
            switch id {
            case "tailscale": return (Color(hex: 0x60a5fa), Color(hex: 0x0b0f17))
            case "cloud": return (Color(hex: 0xb45309), .white)
            default: return (Color(hex: 0xf1f5f9), Color(hex: 0x0f172a))
            }
        }()
        return Button {
            guard id != "cloud", !controller.isBusy else { return }
            controller.setExposure(id)
        } label: {
            Text(title)
                .font(Theme.sans(13, selected ? .semibold : .medium))
                .foregroundStyle(fg)
                .frame(maxWidth: .infinity)
                .frame(height: 32)
                .background(bg)
                .clipShape(RoundedRectangle(cornerRadius: 4.5))
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(selected ? .isSelected : [])
    }

    /// gap 8px; background #0b0f17; border 1px #293548; radius 6.4px; padding 5px 5px 5px 12px.
    private var urlRow: some View {
        HStack(spacing: 8) {
            Text(controller.activeEndpoint ?? "—")
                .font(Theme.mono(12.5)) // JetBrains Mono 12.5px #f1f5f9, ellipsis
                .foregroundStyle(Color(hex: 0xf1f5f9))
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            Button {
                if let endpoint = controller.activeEndpoint { controller.copyString(endpoint) }
            } label: {
                CopyGlyph()
                    .stroke(Color(hex: 0xf1f5f9), style: StrokeStyle(lineWidth: 1.4 * 14 / 16))
                    .frame(width: 14, height: 14)
                    .frame(width: 44, height: 32) // 44×32
                    .background(Color(hex: 0x111827))
                    .overlay(RoundedRectangle(cornerRadius: 5).strokeBorder(Color(hex: 0x475569), lineWidth: 1))
                    .clipShape(RoundedRectangle(cornerRadius: 5))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Copy URL")
            .disabled(controller.activeEndpoint == nil)
        }
        .padding(EdgeInsets(top: 5, leading: 12, bottom: 5, trailing: 5))
        .background(Color(hex: 0x0b0f17))
        .overlay(RoundedRectangle(cornerRadius: 6.4).strokeBorder(Color(hex: 0x293548), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 6.4))
    }

    /// 12px #9ca3af; tailnet variant puts the pin in JetBrains Mono #e2e8f0. The hostname is
    /// never split: address and hostname each stay on one line, and the hostname middle-truncates
    /// when the row is too narrow.
    @ViewBuilder private var reachability: some View {
        if controller.service?.state == "running", controller.service?.visibility == "tailscale",
           let pin = controller.profile?.tailscale {
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                Text("Pinned to ").font(Theme.sans(12)).foregroundStyle(Color(hex: 0x9ca3af))
                    .fixedSize()
                Text(verbatim: "\(pin.address) · ").font(Theme.mono(12)).foregroundStyle(Color(hex: 0xe2e8f0))
                    .fixedSize()
                Text(verbatim: pin.name).font(Theme.mono(12)).foregroundStyle(Color(hex: 0xe2e8f0))
                    .lineLimit(1)
                    .truncationMode(.middle)
            }
            .accessibilityElement(children: .combine)
        } else {
            Text(controller.reachabilityCaption)
                .font(Theme.sans(12))
                .foregroundStyle(Color(hex: 0x9ca3af))
        }
    }

    // MARK: Live aliases — padding: 14px 16px 6px

    private var aliasList: some View {
        let rows = Array(controller.sortedAliases.prefix(Self.maxAliasRows))
        return VStack(alignment: .leading, spacing: 0) {
            // border-bottom: 2px solid #0f172a; padding-bottom: 8px
            HStack(alignment: .firstTextBaseline) {
                Text("Live aliases").font(Theme.serifBold(17)).foregroundStyle(list.ink)
                Spacer()
                Text(verbatim: "\(controller.aliases.count)").font(Theme.mono(12)).foregroundStyle(list.muted)
            }
            .padding(.bottom, 8)
            .overlay(Rectangle().fill(list.ink).frame(height: 2), alignment: .bottom)

            if rows.isEmpty {
                Text(controller.service == nil ? "Loading…" : "Your first alias appears here, with its fingerprint.")
                    .font(Theme.sans(12.5))
                    .foregroundStyle(list.muted)
                    .padding(.vertical, 11)
            } else {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, alias in
                    aliasRow(alias, highlighted: index == 0, last: index == rows.count - 1)
                }
                // page09 long list: <a> 12.5px/600, padding 8px 0 2px, link color #1d4ed8.
                if controller.aliases.count > Self.maxAliasRows {
                    Button {
                        controller.openStoreInFinder()
                    } label: {
                        Text(verbatim: "\(controller.aliases.count - Self.maxAliasRows) more →")
                            .font(Theme.sans(12.5, .semibold))
                            .foregroundStyle(list.link)
                            .padding(.top, 8)
                            .padding(.bottom, 2)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(.top, 14)
        .padding(.horizontal, 16)
        .padding(.bottom, 6)
    }

    /// <a>: gap 12px; padding 11px 8px; margin 0 -8px (so every row — highlighted or not —
    /// keeps its content on the list's 16px edge and only the row background bleeds 8px);
    /// first row background #f4f6f9; border-bottom 1px #e2e8f0 except the last.
    private func aliasRow(_ alias: AliasSummary, highlighted: Bool, last: Bool) -> some View {
        HStack(alignment: .center, spacing: 12) {
            FingerprintView(digits: alias.fingerprintDigits) // 28×28, viewBox 0 0 63 63
            VStack(alignment: .leading, spacing: 2) { // gap 2px
                Text(alias.name)
                    .font(Theme.sans(14, .semibold)) // 14px / 600
                    .foregroundStyle(list.ink)
                    .lineLimit(1)
                    .truncationMode(.tail)
                // JetBrains Mono 11.5px #475569; ID <b> 700 #1e40af
                (
                    Text(verbatim: "\(alias.kindLabel) · ")
                    + Text(verbatim: alias.shortId).font(Theme.mono(11.5, bold: true)).foregroundColor(list.id)
                    + Text(verbatim: " · g\(alias.generation)")
                )
                .font(Theme.mono(11.5))
                .foregroundStyle(list.muted)
                .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // Verified/Drift pill in a fixed-width slot, so titles end in the same place whether
            // or not a row has one. No `verify` from the CLI: the slot stays empty.
            ZStack(alignment: .trailing) {
                Color.clear.frame(width: Self.pillSlot, height: 1)
                if let state = VerifyPill.State(alias: alias) {
                    VerifyPill(state: state)
                }
            }
        }
        .padding(.vertical, 11)
        .padding(.horizontal, 8)
        .background(highlighted ? list.rowHighlight : Color.clear)
        .overlay(alignment: .bottom) {
            if !last { Rectangle().fill(list.rowRule).frame(height: 1) }
        }
        .padding(.horizontal, -8)
        .contentShape(Rectangle())
        .onTapGesture {
            if let url = controller.humanUrl(for: alias) { controller.openInBrowser(url) }
        }
    }

    // MARK: Actions — margin-top 12px; border-top 1px #cbd5e1; padding 6px 8px

    private var actions: some View {
        VStack(spacing: 0) {
            // page08 "Activity · header · ⌘2": the drill-in, from Core's activity/v1.
            actionRow("Activity", shortcut: "⌘2", key: KeyboardShortcut("2")) { controller.showActivity() }
            actionRow("Open store in Finder", shortcut: "⌘O", key: KeyboardShortcut("o")) { controller.openStoreInFinder() }
            actionRow("Restart service", shortcut: "⌘R", key: KeyboardShortcut("r"),
                      enabled: !controller.isBusy && controller.profile?.exposure != "stopped") {
                controller.restartServer()
            }
            actionRow("Stop service", shortcut: "⇧⌘S", key: KeyboardShortcut("s", modifiers: [.command, .shift]),
                      enabled: !controller.isBusy && controller.profile?.exposure != "stopped") {
                controller.setExposure("stopped")
            }
            actionRow("Settings…", shortcut: "⌘,") { onOpenSettings() } // ⌘, is the app command (CanonBarApp)
            // identity page01 "In place → Menu-bar popover" (newer than page06): a last row,
            // border-top 1px #e2e8f0, 14px label, ⌘Q in JetBrains Mono 12px #475569.
            Rectangle().fill(list.rowRule).frame(height: 1).padding(.horizontal, -8).padding(.vertical, 4)
            actionRow("Quit Canon", shortcut: "⌘Q", key: KeyboardShortcut("q")) { NSApp.terminate(nil) }
        }
        .padding(.vertical, 6)
        .padding(.horizontal, 8)
        .overlay(Rectangle().fill(list.actionsRule).frame(height: 1), alignment: .top)
        .padding(.top, 12)
    }

    /// height 36px; padding 0 10px; radius 5px; 14px #0f172a; shortcut JetBrains Mono 12px #475569.
    ///
    /// `key` binds the shortcut the row displays to the row's own button, so pressing it while the
    /// panel is key runs exactly the row's action, and a disabled row's shortcut is disabled too.
    /// page06 draws no disabled row; a disabled one is dimmed to 0.45, the deck's treatment for
    /// unavailable content (page09's unselectable rows).
    private func actionRow(_ title: String, shortcut: String, key: KeyboardShortcut? = nil, enabled: Bool = true,
                           action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack {
                Text(title).font(Theme.sans(14)).foregroundStyle(list.ink)
                Spacer()
                Text(shortcut).font(Theme.mono(12)).foregroundStyle(list.muted)
            }
            .padding(.horizontal, 10)
            .frame(height: 36)
            .contentShape(Rectangle())
            .opacity(enabled ? 1 : 0.45)
        }
        .buttonStyle(ActionRowStyle(hover: list.rowHighlight))
        .keyboardShortcut(key)
        .disabled(!enabled)
    }

    // MARK: Footer — background #f4f6f9; border-top 1px #e2e8f0; padding 9px 16px;
    // JetBrains Mono 11px #475569

    private var footer: some View {
        HStack {
            Text(verbatim: "\(StoreFacts.tildePath(ShellRunner.canonHome)) · :\(controller.profile?.port ?? 8791)")
            Spacer()
            Text(controller.healthzStatus.map { "/healthz \($0)" } ?? "/healthz —")
        }
        .font(Theme.mono(11))
        .foregroundStyle(list.muted)
        .padding(.vertical, 9)
        .padding(.horizontal, 16)
        .background(list.footer)
        .overlay(Rectangle().fill(list.rowRule).frame(height: 1), alignment: .top)
    }
}

// MARK: - Palette for the list/actions/footer half

/// page06's CSS for the light list half. The panel has no dark variant: the plate draws none,
/// and the maintainer chose to keep the panel identical to page06 in every system appearance.
struct ListPalette {
    let card, ink, muted, id, link, rowHighlight, rowRule, actionsRule, footer: Color

    static let page06 = ListPalette(
        card: Color(hex: 0xffffff), ink: Color(hex: 0x0f172a), muted: Color(hex: 0x475569),
        id: Color(hex: 0x1e40af), link: Color(hex: 0x1d4ed8), rowHighlight: Color(hex: 0xf4f6f9),
        rowRule: Color(hex: 0xe2e8f0), actionsRule: Color(hex: 0xcbd5e1), footer: Color(hex: 0xf4f6f9)
    )
}

private struct ActionRowStyle: ButtonStyle {
    let hover: Color
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background(configuration.isPressed ? hover : Color.clear)
            .clipShape(RoundedRectangle(cornerRadius: 5))
    }
}

/// The header status badge. "Healthy" is page06's CSS exactly: inline-flex, gap 5px, 12px/600,
/// color #a7f3d0, background #0d2920, border 1px #065f46, radius 3.5px, padding 2px 8px, and a
/// 10×10 check (M1.5 5.5 L4 8 L8.5 2, stroke 1.8). The other states reuse the same shape.
struct StatusBadge: View {
    enum Status { case healthy, stopped, needsYou, reconciling }
    let status: Status

    var body: some View {
        let (label, fg, bg, bd): (String, UInt32, UInt32, UInt32) = {
            switch status {
            case .healthy: return ("Healthy", 0xa7f3d0, 0x0d2920, 0x065f46)
            case .needsYou: return ("Needs you", 0xfca5a5, 0x2a1215, 0x7f1d1d)
            case .stopped: return ("Stopped", 0xcbd5e1, 0x111827, 0x475569)
            case .reconciling: return ("Reconciling…", 0xcbd5e1, 0x111827, 0x475569)
            }
        }()
        HStack(spacing: 5) {
            if status == .healthy {
                CheckGlyph()
                    .stroke(Color(hex: fg), style: StrokeStyle(lineWidth: 1.8))
                    .frame(width: 10, height: 10)
            }
            Text(label).font(Theme.sans(12, .semibold))
        }
        .foregroundStyle(Color(hex: fg))
        .padding(.vertical, 2)
        .padding(.horizontal, 8)
        .background(Color(hex: bg))
        .overlay(RoundedRectangle(cornerRadius: 3.5).strokeBorder(Color(hex: bd), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 3.5))
    }
}

/// `<path d="M1.5 5.5 L4 8 L8.5 2">` in a 10×10 viewBox.
struct CheckGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let s = rect.width / 10
        var p = Path()
        p.move(to: CGPoint(x: 1.5 * s, y: 5.5 * s))
        p.addLine(to: CGPoint(x: 4 * s, y: 8 * s))
        p.addLine(to: CGPoint(x: 8.5 * s, y: 2 * s))
        return p
    }
}

/// page06 copy button glyph, viewBox 0 0 16 16: `<rect x=5 y=5 w=9 h=9 rx=1.5>` +
/// `M11 5 V3 A1 1 0 0 0 10 2 H3 A1 1 0 0 0 2 3 V10 A1 1 0 0 0 3 11 H5`.
struct CopyGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let s = rect.width / 16
        var p = Path(roundedRect: CGRect(x: 5 * s, y: 5 * s, width: 9 * s, height: 9 * s), cornerRadius: 1.5 * s)
        p.move(to: CGPoint(x: 11 * s, y: 5 * s))
        p.addLine(to: CGPoint(x: 11 * s, y: 3 * s))
        p.addArc(center: CGPoint(x: 10 * s, y: 3 * s), radius: s, startAngle: .degrees(0), endAngle: .degrees(-90), clockwise: true)
        p.addLine(to: CGPoint(x: 3 * s, y: 2 * s))
        p.addArc(center: CGPoint(x: 3 * s, y: 3 * s), radius: s, startAngle: .degrees(-90), endAngle: .degrees(-180), clockwise: true)
        p.addLine(to: CGPoint(x: 2 * s, y: 10 * s))
        p.addArc(center: CGPoint(x: 3 * s, y: 10 * s), radius: s, startAngle: .degrees(180), endAngle: .degrees(90), clockwise: true)
        p.addLine(to: CGPoint(x: 5 * s, y: 11 * s))
        return p
    }
}

// MARK: - Verified / Drift pill

/// page06 pill: inline-flex, gap 4px, 11px/600, border 1px, radius 3.5px, padding 1px 6px, and a
/// 9×9 glyph (viewBox 10). Verified #065f46 on #ecfdf5, border #6ee7b7, check
/// `M1.5 5.5 L4 8 L8.5 2`. Drift #991b1b on #fef2f2, border #fca5a5, cross `M2 2 L8 8 M8 2 L2 8`.
/// Both strokes 1.8.
///
/// The word stays the plate's "Verified", but status/v1 only checks to `verifyDepth: "manifest"`
/// (content ID and manifest digest; file bodies are not re-hashed). So the tooltip and the
/// accessibility label say exactly that, and never "re-hashed".
struct VerifyPill: View {
    enum State: Equatable {
        case verified(depth: String)
        case drift(reasons: [String], refusals: AliasRefusals?)

        init?(alias: AliasSummary) {
            switch alias.verify {
            case "verified": self = .verified(depth: alias.verifyDepth ?? "manifest")
            case "drift": self = .drift(reasons: alias.driftReasons ?? [], refusals: alias.refusedToServe)
            default: return nil // absent (transient error, or an older CLI): show nothing
            }
        }
    }

    let state: State

    var body: some View {
        let isDrift: Bool = { if case .drift = state { return true } else { return false } }()
        let fg = Color(hex: isDrift ? 0x991b1b : 0x065f46)
        HStack(spacing: 4) {
            Group {
                if isDrift {
                    CrossGlyph().stroke(fg, style: StrokeStyle(lineWidth: 1.8 * 0.9))
                } else {
                    CheckGlyph().stroke(fg, style: StrokeStyle(lineWidth: 1.8 * 0.9))
                }
            }
            .frame(width: 9, height: 9)
            Text(isDrift ? "Drift" : "Verified").font(Theme.sans(11, .semibold))
        }
        .foregroundStyle(fg)
        .padding(.vertical, 1)
        .padding(.horizontal, 6)
        .background(Color(hex: isDrift ? 0xfef2f2 : 0xecfdf5))
        .overlay(RoundedRectangle(cornerRadius: 3.5).strokeBorder(Color(hex: isDrift ? 0xfca5a5 : 0x6ee7b7), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 3.5))
        .help(tooltip)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(tooltip)
    }

    var tooltip: String {
        switch state {
        case .verified(let depth) where depth == "manifest":
            return "Manifest verified: the content ID and manifest digest match. File bodies were not re-hashed by this check."
        case .verified(let depth):
            return "Verified (\(depth) check)."
        case .drift(let reasons, let refusals):
            // Core puts `refused-to-serve` in the same list as the manifest reasons, but it is
            // the service's finding on read, not the manifest check's.
            let manifestReasons = reasons.filter { $0 != RefusalText.reason }
            var parts: [String] = []
            if reasons.contains(RefusalText.reason) {
                parts.append(RefusalText.tooltip(refusals))
            }
            if !manifestReasons.isEmpty || parts.isEmpty {
                let list = manifestReasons.isEmpty ? "" : ": " + manifestReasons.joined(separator: ", ")
                parts.append("Drift found by the manifest check\(list).")
            }
            return parts.joined(separator: " ")
        }
    }
}

/// `<path d="M2 2 L8 8 M8 2 L2 8">` in a 10×10 viewBox.
struct CrossGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let s = rect.width / 10
        var p = Path()
        p.move(to: CGPoint(x: 2 * s, y: 2 * s))
        p.addLine(to: CGPoint(x: 8 * s, y: 8 * s))
        p.move(to: CGPoint(x: 8 * s, y: 2 * s))
        p.addLine(to: CGPoint(x: 2 * s, y: 8 * s))
        return p
    }
}

// MARK: - Drift card

/// page06 drift card: margin 6px 16px 0; background #fff; border 1px #cbd5e1 with
/// border-left 4px #b91c1c; radius 6.4px; padding 12px 14px; column gap 6px.
/// Title 13/600; right label JetBrains Mono 11 #475569; body 12.5/1.5 #1e293b with file names in
/// JetBrains Mono 11.5; link 12.5/600 #1d4ed8, padding 4px 0.
///
/// The plate's card reports a failed read re-hash. status/v1 only knows the manifest-depth
/// reasons, so the title and body say what that check found, the right label names the depth
/// until Verify now has run, and then shows that run's exit status. Verify now
/// (`canon alias verify --json`, full re-hash) lists its errors inside the card; the verify
/// report drill-in (page08) is P2.
struct DriftCard: View {
    @ObservedObject var controller: PublisherController
    let alias: AliasSummary
    let othersInDrift: Int

    private let ink = Color(hex: 0x0f172a)
    private let body2 = Color(hex: 0x1e293b)
    private let muted = Color(hex: 0x475569)
    private let crimson = Color(hex: 0xb91c1c)

    private var run: VerifyRun? { controller.verifyRuns[alias.name] }

    /// `refused-to-serve` is the only reason: the service re-hashed a file on read and refused
    /// it, which is the case page06's card draws, so the card uses the plate's title.
    private var refusedOnly: Bool { alias.driftReasons == [RefusalText.reason] }

    private var title: String {
        refusedOnly ? "\(alias.name) failed re-hash on read" : "\(alias.name) failed its manifest check"
    }
    private var verifying: Bool { controller.verifyingAlias == alias.name }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: 6.4)
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .center, spacing: 8) {
                Text(verbatim: title)
                    .font(Theme.sans(13, .semibold)).foregroundStyle(ink)
                    .lineLimit(1).truncationMode(.middle)
                Spacer(minLength: 0)
                Text(verbatim: run.map { "exit \($0.exitCode)" } ?? (refusedOnly ? "on read" : "manifest"))
                    .font(Theme.mono(11)).foregroundStyle(muted)
            }
            reasonsText
                .font(Theme.sans(12.5)).foregroundStyle(body2)
                .lineSpacing(3.5) // line-height 1.5 at 12.5px
                .fixedSize(horizontal: false, vertical: true)
            if let run { verifyResult(run) }
            HStack(spacing: 0) {
                Button {
                    controller.verifyNow(alias)
                } label: {
                    Text(verifying ? "Verifying…" : (run == nil ? "Verify now →" : "Verify again →"))
                        .font(Theme.sans(12.5, .semibold))
                        .foregroundStyle(Color(hex: 0x1d4ed8))
                        .underline(!verifying)
                        .padding(.vertical, 4)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(verifying)
                Spacer(minLength: 8)
                if othersInDrift > 0 {
                    Text(verbatim: "+\(othersInDrift) more in drift")
                        .font(Theme.sans(12)).foregroundStyle(muted)
                }
            }
        }
        // padding 12px 14px inside a 1px border, 4px on the left.
        .padding(EdgeInsets(top: 13, leading: 18, bottom: 13, trailing: 15))
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.white)
        .overlay(shape.strokeBorder(Color(hex: 0xcbd5e1), lineWidth: 1))
        .overlay(alignment: .leading) { crimson.frame(width: 4) }
        .clipShape(shape)
        .accessibilityElement(children: .contain)
    }

    private func mono(_ s: String) -> Text {
        Text(verbatim: s).font(Theme.mono(11.5))
    }

    /// One sentence per status/v1 drift reason, then what Canon did about it (nothing).
    private var reasonsText: Text {
        let reasons = alias.driftReasons ?? []
        var text = Text("")
        for (i, reason) in reasons.enumerated() {
            if i > 0 { text = text + Text(" ") }
            switch reason {
            case "manifest-hash-mismatch":
                text = text + mono("manifest.json") + Text(" no longer matches the digest in ") + mono("checksums.json") + Text(".")
            case "manifest-unreadable":
                text = text + mono("manifest.json") + Text(" can't be read.")
            case "checksums-unreadable":
                text = text + mono("checksums.json") + Text(" can't be read.")
            case "packet-missing":
                text = text + Text("The edition's packet is missing from the store.")
            case "content-id-mismatch":
                text = text + Text("The packet's content ID isn't the one the alias points to.")
            case RefusalText.reason:
                // page06: "‹path› failed its re-hash on read …", when Core names the file.
                if let path = alias.refusedToServe?.lastPath, !path.isEmpty, (alias.refusedToServe?.count ?? 0) > 0 {
                    text = text + mono(path) + Text(" failed its re-hash on read. ")
                }
                text = text + Text(verbatim: RefusalText.sentence(alias.refusedToServe))
            default:
                text = text + mono(reason) + Text(".")
            }
        }
        if reasons.isEmpty { text = Text("The manifest check reported drift.") }
        return text + Text(" Nothing was repaired.")
    }

    /// The full re-hash's findings: path in JetBrains Mono 11.5, message 12/1.45 #475569, one per
    /// row with #e2e8f0 rules (the Activity rows' metrics; the card on page06 has no list).
    @ViewBuilder private func verifyResult(_ run: VerifyRun) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Rectangle().fill(Color(hex: 0xe2e8f0)).frame(height: 1)
            if let result = run.result {
                let errors = result.errors ?? []
                Text(verbatim: result.verify == "verified"
                     ? "Full re-hash passed: \(result.fileCount ?? 0) files match the manifest."
                     : "Full re-hash: \(errors.count) \(errors.count == 1 ? "problem" : "problems") in \(result.fileCount.map(String.init) ?? "?") files.")
                    .font(Theme.sans(12.5, .semibold)).foregroundStyle(ink)
                    .padding(.top, 8).padding(.bottom, errors.isEmpty ? 2 : 4)
                if result.verify == "verified", (alias.driftReasons ?? []).contains(RefusalText.reason) {
                    // Core counts refusals since the later of this generation going live and the
                    // service start (f5dc2df), so a fix clears the Drift only after a restart.
                    Text(verbatim: RefusalText.restartNote)
                        .font(Theme.sans(12)).foregroundStyle(muted)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(.bottom, 2)
                }
                ForEach(Array(errors.enumerated()), id: \.offset) { index, error in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: "\(error.path) · \(error.code)")
                            .font(Theme.mono(11.5)).foregroundStyle(body2)
                            .lineLimit(1).truncationMode(.middle)
                        Text(verbatim: error.message)
                            .font(Theme.sans(12)).foregroundStyle(muted)
                            .lineSpacing(2.4)
                            .lineLimit(3).truncationMode(.middle)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.vertical, 5)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .overlay(alignment: .bottom) {
                        if index < errors.count - 1 { Rectangle().fill(Color(hex: 0xe2e8f0)).frame(height: 1) }
                    }
                }
            } else {
                Text(verbatim: run.message ?? "canon alias verify exited \(run.exitCode) with no report.")
                    .font(Theme.sans(12)).foregroundStyle(muted)
                    .padding(.top, 8)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Wording for status/v1's `refused-to-serve` drift reason and the alias's `refusedToServe`
/// account (core/app-status `7cb5d7a`; `lastPath` and the restart anchor from `f5dc2df`). The
/// app only words what Core reports; it never counts refusals itself.
enum RefusalText {
    static let reason = "refused-to-serve"

    /// After a passed full re-hash: the files match, but the recorded refusal counts until the
    /// service restarts (Core's `since` anchor).
    static let restartNote = "The files match again. Restart the service to clear the recorded refusal."

    /// "The service refused to serve it 3 times, last at 11:42." `since` is the later of this
    /// generation going live and the service start, so the sentence names neither.
    static func sentence(_ refusals: AliasRefusals?) -> String {
        guard let refusals, refusals.count > 0 else {
            return "The service refused to serve this edition on read."
        }
        let last = refusals.lastAt.flatMap(ActivityItem.parse).map(timeLabel)
        if refusals.count == 1 {
            return "The service refused to serve it once" + (last.map { ", at \($0)" } ?? "") + "."
        }
        return "The service refused to serve it \(refusals.count) times"
            + (last.map { ", last at \($0)" } ?? "") + "."
    }

    static func tooltip(_ refusals: AliasRefusals?) -> String {
        guard let refusals, refusals.count > 0 else { return "Drift: the service refused to serve this edition on read." }
        let times = refusals.count == 1 ? "once" : "\(refusals.count) times"
        return "Drift: the service refused to serve this edition \(times), after a file failed its re-hash on read."
    }

    /// "11:42" today, "17 Nov 11:42" otherwise.
    private static func timeLabel(_ date: Date) -> String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = Calendar.current.isDateInToday(date) ? "HH:mm" : "d MMM HH:mm"
        return f.string(from: date)
    }
}
