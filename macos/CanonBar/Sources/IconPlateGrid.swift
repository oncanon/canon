import AppKit
import SwiftUI

/// Evidence view only (DebugExport): the shipping status icon laid out exactly like page07
/// Plate 1 — container #eaedf2, padding 22px 26px; header 12px #475569 with a 1px #94a3b8 rule;
/// rows on columns 96 96 52 52 1fr, column-gap 14, padding 10px 0, 1px #e2e8f0 dividers.
struct IconPlateGrid: View {
    struct Row {
        let file: String, title: String, note: String
        let state: IconVisibilityState, needsYou: Bool
    }

    static let rows: [Row] = [
        Row(file: "loopback", title: "Loopback", note: "Serving to this Mac only. Solid dot.", state: .loopback, needsYou: false),
        Row(file: "tailnet", title: "Tailnet", note: "Reachable on your tailnet. Ring around the dot.", state: .tailnet, needsYou: false),
        Row(file: "cloud", title: "Cloud · gated", note: "Editions on a public target. Four ticks, like exposure.", state: .cloud, needsYou: false),
        Row(file: "needs-you", title: "Needs you", note: "Drift, or a join request. Dot in the top corner; the visibility badge stays.", state: .loopback, needsYou: true),
        Row(file: "stopped", title: "Stopped", note: "Service not running. The tile goes hollow; no badge.", state: .stopped, needsYou: false),
    ]

    static let lightTile = Color(hex: 0xE4E4E6), darkTile = Color(hex: 0x2A2A2D)
    static let lightInk = NSColor(srgbRed: 0x1D / 255, green: 0x1D / 255, blue: 0x1F / 255, alpha: 1)
    static let darkInk = NSColor(srgbRed: 0xF5 / 255, green: 0xF5 / 255, blue: 0xF7 / 255, alpha: 1)

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            grid {
                Text("Light · 2×"); Text("Dark · 2×"); Text("1×"); Text("1×"); Text("State")
            }
            .font(Theme.sans(12))
            .foregroundStyle(Color(hex: 0x475569))
            .padding(.bottom, 8)
            .overlay(Rectangle().fill(Color(hex: 0x94a3b8)).frame(height: 1), alignment: .bottom)

            ForEach(Array(Self.rows.enumerated()), id: \.offset) { i, row in
                grid {
                    // 2× columns: the plate's 36px magnification, drawn at the export's 2× density
                    // (72 px) so it lines up pixel-for-pixel with a 2× crop of the plate.
                    tile(row, pixels: 72, points: 36, size: CGSize(width: 88, height: 52), radius: 8, dark: false)
                    tile(row, pixels: 72, points: 36, size: CGSize(width: 88, height: 52), radius: 8, dark: true)
                    // 1× columns: the true 18-pixel menu-bar raster, upscaled without smoothing.
                    tile(row, pixels: 18, points: 18, size: CGSize(width: 44, height: 26), radius: 5, dark: false)
                    tile(row, pixels: 18, points: 18, size: CGSize(width: 44, height: 26), radius: 5, dark: true)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(row.title).font(Theme.sans(14, .semibold)).foregroundStyle(Color(hex: 0x0f172a))
                        Text(row.note).font(Theme.sans(12.5)).lineSpacing(12.5 * 0.24) // CSS line-height 1.45 − Inter 1.21.foregroundStyle(Color(hex: 0x1e293b))
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .padding(.vertical, 10)
                .overlay(alignment: .bottom) {
                    if i < Self.rows.count - 1 { Rectangle().fill(Color(hex: 0xe2e8f0)).frame(height: 1) }
                }
            }
        }
        .padding(.vertical, 22)
        .padding(.horizontal, 26)
        .frame(width: 752) // page07 Plate 1 box width (752 CSS px at the board's layout)
        .background(Color(hex: 0xeaedf2))
    }

    private func grid<C: View>(@ViewBuilder _ content: () -> C) -> some View {
        // CSS grid 96 96 52 52 1fr / gap 14 — emulated with fixed-width cells.
        let views = content()
        return _VariadicView.Tree(GridColumns()) { views }
    }

    private func tile(_ row: Row, pixels: Int, points: CGFloat, size: CGSize, radius: CGFloat, dark: Bool) -> some View {
        let raster = Self.rasterize(row, pixels: pixels, ink: dark ? Self.darkInk : Self.lightInk)
        return ZStack {
            RoundedRectangle(cornerRadius: radius).fill(dark ? Self.darkTile : Self.lightTile)
            Image(nsImage: raster)
                .interpolation(.none)
                .resizable()
                .frame(width: points, height: points)
        }
        .frame(width: size.width, height: size.height)
    }

    /// The template icon drawn at exactly `pixels`×`pixels` device pixels and tinted `ink`.
    static func rasterize(_ row: Row, pixels: Int, ink: NSColor) -> NSImage {
        let template = StatusIconRenderer.icon(for: row.state, needsAttention: row.needsYou, pointSize: CGFloat(pixels))
        let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: pixels, pixelsHigh: pixels,
                                   bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                   colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
        rep.size = NSSize(width: pixels, height: pixels)
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
        let rect = NSRect(x: 0, y: 0, width: pixels, height: pixels)
        template.draw(in: rect)
        ink.setFill()
        rect.fill(using: .sourceAtop)
        NSGraphicsContext.restoreGraphicsState()
        let image = NSImage(size: rep.size)
        image.addRepresentation(rep)
        return image
    }
}

/// Lays children on page07's column template: 96, 96, 52, 52, then the rest; gap 14, centered
/// vertically (align-items: center).
private struct GridColumns: _VariadicView_MultiViewRoot {
    static let widths: [CGFloat?] = [96, 96, 52, 52, nil]
    func body(children: _VariadicView.Children) -> some View {
        HStack(alignment: .center, spacing: 14) {
            ForEach(Array(children.enumerated()), id: \.offset) { i, child in
                if let w = Self.widths[min(i, 4)] {
                    child.frame(width: w, alignment: .leading)
                } else {
                    child.frame(maxWidth: .infinity, alignment: .leading)
                }
            }
        }
    }
}
