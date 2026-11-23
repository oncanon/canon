import SwiftUI

// Values copied from src/presentation/variant-a.css (the shared design tokens).
// Keep in sync by hand until Core exposes a single token source for app + docs + web.
enum Theme {
    struct Scheme {
        let paper: Color
        let card: Color
        let surface: Color
        let surfaceSubtle: Color
        let ink: Color
        let inkSecondary: Color
        let muted: Color
        let line: Color
        let lineStrong: Color
        let lineSubtle: Color
        let accent: Color
        let accentWash: Color
        let accentBorder: Color
        let provenBar: Color
        let provenBg: Color
        let provenBd: Color
        let sevMedBar: Color
        let sevMedBg: Color
        let sevMedBd: Color
    }

    static let light = Scheme(
        paper: Color(hex: 0xf4f6f9),
        card: Color(hex: 0xffffff),
        surface: Color(hex: 0xeaedf2),
        surfaceSubtle: Color(hex: 0xf8fafc),
        ink: Color(hex: 0x0f172a),
        inkSecondary: Color(hex: 0x1e293b),
        muted: Color(hex: 0x475569),
        line: Color(hex: 0xcbd5e1),
        lineStrong: Color(hex: 0x94a3b8),
        lineSubtle: Color(hex: 0xe2e8f0),
        accent: Color(hex: 0x1d4ed8),
        accentWash: Color(hex: 0xeff6ff),
        accentBorder: Color(hex: 0xbfdbfe),
        provenBar: Color(hex: 0x059669),
        provenBg: Color(hex: 0xecfdf5),
        provenBd: Color(hex: 0x6ee7b7),
        sevMedBar: Color(hex: 0xca8a04),
        sevMedBg: Color(hex: 0xfefce8),
        sevMedBd: Color(hex: 0xfde047)
    )

    static let dark = Scheme(
        paper: Color(hex: 0x0b0f17),
        card: Color(hex: 0x111827),
        surface: Color(hex: 0x1b2434),
        surfaceSubtle: Color(hex: 0x141c2b),
        ink: Color(hex: 0xf1f5f9),
        inkSecondary: Color(hex: 0xe2e8f0),
        muted: Color(hex: 0x9ca3af),
        line: Color(hex: 0x293548),
        lineStrong: Color(hex: 0x475569),
        lineSubtle: Color(hex: 0x1e293b),
        accent: Color(hex: 0x60a5fa),
        accentWash: Color(hex: 0x172554),
        accentBorder: Color(hex: 0x1e3a8a),
        provenBar: Color(hex: 0x34d399),
        provenBg: Color(hex: 0x0d2920),
        provenBd: Color(hex: 0x065f46),
        sevMedBar: Color(hex: 0xeab308),
        sevMedBg: Color(hex: 0x2b210b),
        sevMedBd: Color(hex: 0x713f12)
    )

    // Fonts — the plates' CSS names exactly three families (see Resources/Fonts/SOURCE.md):
    //   font-family: Inter, …                 → UI text, weights 400/500/600/700
    //   font-family: 'JetBrains Mono', mono   → paths, IDs, shortcuts, weights 400/700
    //   font-family: Libron, …; weight 700    → serif headings
    // Sizes are CSS px; at the same backing scale 1 CSS px == 1 pt, so every call site passes
    // the CSS value verbatim. `fixedSize` keeps them out of any text-size scaling.
    enum Weight { case regular, medium, semibold, bold }

    static func sans(_ size: CGFloat, _ weight: Weight = .regular) -> Font {
        let name: String
        switch weight {
        case .regular: name = "Inter-Regular"
        case .medium: name = "Inter-Medium"
        case .semibold: name = "Inter-SemiBold"
        case .bold: name = "Inter-Bold"
        }
        return .custom(name, fixedSize: size)
    }

    static func mono(_ size: CGFloat, bold: Bool = false) -> Font {
        .custom(bold ? "JetBrainsMono-Bold" : "JetBrainsMono-Regular", fixedSize: size)
    }

    // The design's serif headings are all weight 700 — Libron-Bold (embedded OFL font,
    // registered at launch by FontRegistrar) is the only serif cut this app ships.
    static func serifBold(_ size: CGFloat) -> Font {
        .custom("Libron-Bold", fixedSize: size)
    }
}

/// Draws the switch as plain shapes from Theme tokens instead of `.toggleStyle(.switch)`, whose
/// native `NSSwitch` backing renders as a missing-image placeholder under `ImageRenderer`
/// (offscreen, no window) — the yellow/🚫 box seen in the Settings exports.
struct ThemeSwitchToggleStyle: ToggleStyle {
    let theme: Theme.Scheme

    func makeBody(configuration: Configuration) -> some View {
        let isOn = configuration.isOn
        Button {
            configuration.isOn.toggle()
        } label: {
            ZStack(alignment: isOn ? .trailing : .leading) {
                Capsule()
                    .fill(isOn ? theme.accent : theme.line)
                Circle()
                    .fill(Color.white)
                    .shadow(color: .black.opacity(0.35), radius: 1, y: 0.5)
                    .padding(2)
            }
            .frame(width: 34, height: 20)
        }
        .buttonStyle(.plain)
    }
}

extension Color {
    init(hex: UInt32) {
        let r = Double((hex >> 16) & 0xFF) / 255
        let g = Double((hex >> 8) & 0xFF) / 255
        let b = Double(hex & 0xFF) / 255
        self.init(.sRGB, red: r, green: g, blue: b, opacity: 1)
    }
}
