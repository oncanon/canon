import SwiftUI

/// The two-leaf symbol from design-v2 page01: "one source, a leaf for people and a leaf for
/// agents, and the cobalt ID on the fold." It is logo artwork, drawn once here rather than
/// authored as SF Symbols/text, and only ever appears on the permanently-dark chrome band, so
/// its colors are fixed literals rather than `Theme` tokens.
struct CanonMark: View {
    var body: some View {
        GeometryReader { geo in
            let s = min(geo.size.width, geo.size.height) / 100

            ZStack {
                // Left leaf: dark fill, light hairline stroke.
                Path { path in
                    path.move(to: CGPoint(x: 12 * s, y: 24 * s))
                    path.addLine(to: CGPoint(x: 47 * s, y: 19 * s))
                    path.addLine(to: CGPoint(x: 47 * s, y: 81 * s))
                    path.addLine(to: CGPoint(x: 12 * s, y: 76 * s))
                    path.closeSubpath()
                }
                .fill(Color(hex: 0x0f172a))
                Path { path in
                    path.move(to: CGPoint(x: 12 * s, y: 24 * s))
                    path.addLine(to: CGPoint(x: 47 * s, y: 19 * s))
                    path.addLine(to: CGPoint(x: 47 * s, y: 81 * s))
                    path.addLine(to: CGPoint(x: 12 * s, y: 76 * s))
                    path.closeSubpath()
                }
                .stroke(Color(hex: 0xf1f5f9), lineWidth: 5 * s)

                // Right leaf: light fill.
                Path { path in
                    path.move(to: CGPoint(x: 53 * s, y: 19 * s))
                    path.addLine(to: CGPoint(x: 88 * s, y: 24 * s))
                    path.addLine(to: CGPoint(x: 88 * s, y: 76 * s))
                    path.addLine(to: CGPoint(x: 53 * s, y: 81 * s))
                    path.closeSubpath()
                }
                .fill(Color(hex: 0xf1f5f9))

                // The cobalt ID chip on the fold.
                RoundedRectangle(cornerRadius: 3 * s)
                    .fill(Color(hex: 0x60a5fa))
                    .overlay(RoundedRectangle(cornerRadius: 3 * s).strokeBorder(Color(hex: 0x0f172a), lineWidth: 4 * s))
                    .frame(width: 18 * s, height: 18 * s)
                    .position(x: (41 + 9) * s, y: (71 + 9) * s)
            }
        }
        .accessibilityHidden(true)
    }
}
