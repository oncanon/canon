import AppKit
import SwiftUI

/// The 8x8 content-ID fingerprint from page01: one cell per hex digit, cycling the design's
/// 5-color categorical palette (accent, muted, line-strong, line-subtle, ink) by digit value.
/// This is the simplest faithful reading of "5-color categorical palette" available without a
/// more precise per-digit mapping from Core — see docs/app/p1-fidelity.md.
///
/// Deliberate deviation from page06 (the maintainer, 2026-11-18): the plate draws 7-unit cells on an
/// 8-unit step in a 63-unit viewBox, a 1/63 gap between cells. At 28pt that gap is 0.44pt, under
/// one device pixel, and it rendered as uneven light seams. The cells now touch: the grid is one
/// bitmap at device scale, cell edges on whole pixels, no antialiasing between cells. Only the
/// outer corners are rounded.
struct FingerprintView: View {
    let digits: [UInt8]
    /// page06: a 28×28 tile.
    var side: CGFloat = 28
    @Environment(\.displayScale) private var displayScale

    var body: some View {
        let scale = max(displayScale, 1)
        Group {
            if let image = FingerprintRaster.cgImage(digits: digits, side: side, scale: scale) {
                Image(decorative: image, scale: scale).interpolation(.none)
            } else {
                Color.clear
            }
        }
        .frame(width: side, height: side)
        .accessibilityHidden(true)
    }
}

/// Draws the fingerprint once, on whole device pixels. Shared by the panel rows and the
/// right-click menu's thumbnails.
enum FingerprintRaster {
    /// Same 5-color palette and per-digit mapping as before (digit % 5).
    static let palette: [(UInt8, UInt8, UInt8)] = [
        (0x1d, 0x4e, 0xd8),
        (0x47, 0x55, 0x69),
        (0x94, 0xa3, 0xb8),
        (0xe2, 0xe8, 0xf0),
        (0x0f, 0x17, 0x2a),
    ]

    /// Outer corner radius: side/14 (2pt on the 28pt tile), the plate's rx=1 cell rounding
    /// moved to the tile's outline.
    static func cornerRadius(side: CGFloat) -> CGFloat { side / 14 }

    static func cgImage(digits: [UInt8], side: CGFloat, scale: CGFloat) -> CGImage? {
        let px = Int((side * scale).rounded())
        guard px >= 8,
              let ctx = CGContext(data: nil, width: px, height: px, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpace(name: CGColorSpace.sRGB)!,
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
        else { return nil }
        // Outer outline: the only antialiased edge.
        let radius = cornerRadius(side: side) * scale
        ctx.addPath(CGPath(roundedRect: CGRect(x: 0, y: 0, width: px, height: px),
                           cornerWidth: radius, cornerHeight: radius, transform: nil))
        ctx.clip()
        // Cells: edges at round(i * px / 8), so neighbours share an edge on a whole pixel.
        ctx.setShouldAntialias(false)
        let edges = (0...8).map { Int((Double($0) * Double(px) / 8).rounded()) }
        for index in 0..<64 {
            let digit = index < digits.count ? digits[index] : 0
            let (r, g, b) = palette[Int(digit) % palette.count]
            ctx.setFillColor(red: CGFloat(r) / 255, green: CGFloat(g) / 255, blue: CGFloat(b) / 255, alpha: 1)
            let row = index / 8, col = index % 8
            // CG's origin is bottom-left; row 0 is the top row.
            let y0 = px - edges[row + 1], y1 = px - edges[row]
            ctx.fill(CGRect(x: edges[col], y: y0, width: edges[col + 1] - edges[col], height: y1 - y0))
        }
        return ctx.makeImage()
    }

    /// An NSImage with 1x and 2x bitmaps, so AppKit (the menu) picks the one for the screen
    /// instead of resampling.
    static func nsImage(digits: [UInt8], side: CGFloat) -> NSImage {
        let image = NSImage(size: NSSize(width: side, height: side))
        for scale in [1, 2] as [CGFloat] {
            guard let cg = cgImage(digits: digits, side: side, scale: scale) else { continue }
            let rep = NSBitmapImageRep(cgImage: cg)
            rep.size = NSSize(width: side, height: side)
            image.addRepresentation(rep)
        }
        return image
    }
}
