import AppKit

/// Draws the menu-bar template icon from design-v2 Plate 3: the serif "C" tile with a badge for
/// visibility (loopback dot / tailnet ring / cloud ticks) and an independent "needs you" corner
/// dot. Template images are a pure alpha mask — macOS tints every opaque pixel the same flat
/// color, so the tile's "C" and every badge halo are cut out of the fill rather than drawn in a
/// second color.
///
/// All geometry below is given in the plate's native 18-unit design space (1x = 18pt, matching
/// the real menu-bar size exactly) and scaled by `rect.width / 18` for other render sizes (e.g.
/// 288pt for the `--export-icons` evidence dump). Coordinates are quoted as given in the SVG
/// (top-down) source and converted once to AppKit's bottom-up convention via `y_appkit = 18 - y_svg`.
enum StatusIconRenderer {
    private static let unit: CGFloat = 18

    static func icon(for state: IconVisibilityState, needsAttention: Bool, showBadge: Bool = true, pointSize: CGFloat = 18) -> NSImage {
        let image = NSImage(size: NSSize(width: pointSize, height: pointSize), flipped: false) { rect in
            draw(state: state, needsAttention: needsAttention, showBadge: showBadge, in: rect)
            return true
        }
        image.isTemplate = true
        return image
    }

    private static func draw(state: IconVisibilityState, needsAttention: Bool, showBadge: Bool, in rect: NSRect) {
        guard let ctx = NSGraphicsContext.current?.cgContext else { return }
        let scale = rect.width / unit

        // Every coordinate passed in below is the plate's native SVG value (top-down); this
        // flips y into AppKit's bottom-up space in one place so call sites never have to.
        func p(_ xSvg: CGFloat, _ ySvg: CGFloat) -> NSPoint {
            NSPoint(x: rect.minX + xSvg * scale, y: rect.minY + (unit - ySvg) * scale)
        }
        func len(_ v: CGFloat) -> CGFloat { v * scale }

        // The "C" counter is identical in every state: center (9.2, 9.0), radius 3.2, open from
        // 48.07° to 311.93° (the long way around) so the ~96° gap faces due east, toward the
        // badge corner at bottom-right.
        let cCenter = p(9.2, 9.0)
        let cRadius = len(3.2)
        func cPath() -> NSBezierPath {
            let path = NSBezierPath()
            path.appendArc(withCenter: cCenter, radius: cRadius, startAngle: 48.07, endAngle: 311.93, clockwise: false)
            return path
        }

        if state == .stopped {
            // Stopped: hollow outline tile, no fill, no badge — stroke-only on both the frame
            // and the C, since there is nothing to punch a hole out of. Rect origin uses the
            // SVG (minX, maxY) corner, which is where AppKit's (minX, minY) lands after the flip.
            let tileRect = NSRect(x: p(2.7, 15.3).x, y: p(2.7, 15.3).y, width: len(12.6), height: len(12.6))
            let tilePath = NSBezierPath(roundedRect: tileRect, xRadius: len(2), yRadius: len(2))
            tilePath.lineWidth = max(1, len(1.4))
            NSColor.black.setStroke()
            tilePath.stroke()

            let c = cPath()
            c.lineWidth = max(1, len(1.9))
            NSColor.black.setStroke()
            c.stroke()
            return
        }

        // Filled dark tile: SVG origin (2,2), size (14,14), corner radius 2.3. Origin uses the
        // SVG (minX, maxY) corner — see the flip note on `p` above.
        let tileRect = NSRect(x: p(2, 16).x, y: p(2, 16).y, width: len(14), height: len(14))
        let tilePath = NSBezierPath(roundedRect: tileRect, xRadius: len(2.3), yRadius: len(2.3))

        ctx.saveGState()
        NSColor.black.setFill()
        tilePath.fill()
        ctx.setBlendMode(.destinationOut)
        let c = cPath()
        c.lineWidth = max(1.1, len(1.9))
        NSColor.black.setStroke()
        c.stroke()
        ctx.setBlendMode(.normal)
        ctx.restoreGState()

        // Visibility badge halos punch a transparent gap in the tile before the solid
        // dot/ring/ticks are re-filled on top, so the badge reads as separated from the tile edge.
        func punchHalo(center: NSPoint, radius: CGFloat) {
            ctx.saveGState()
            ctx.setBlendMode(.destinationOut)
            NSColor.black.setFill()
            NSBezierPath(ovalIn: NSRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)).fill()
            ctx.setBlendMode(.normal)
            ctx.restoreGState()
        }

        switch showBadge ? state : .stopped {
        case .loopback:
            let center = p(14.6, 14.6)
            punchHalo(center: center, radius: len(3.6))
            fillCircle(center: center, radius: len(2.1))
        case .tailnet:
            let center = p(14.4, 14.4)
            punchHalo(center: center, radius: len(4.3))
            fillCircle(center: center, radius: len(1.4))
            strokeCircle(center: center, radius: len(3.1), lineWidth: len(1))
        case .cloud:
            let center = p(14.4, 14.4)
            punchHalo(center: center, radius: len(4.4))
            fillCircle(center: center, radius: len(1.5))
            // Ticks are intentionally asymmetric: the badge sits in the bottom-right corner, so
            // the down/right ticks reach the canvas edge while up/left stop short.
            strokeLine(from: p(14.4, 10.5), to: p(14.4, 12), lineWidth: len(1.1))   // up
            strokeLine(from: p(14.4, 16.8), to: p(14.4, 18), lineWidth: len(1.1))   // down (reaches edge)
            strokeLine(from: p(10.5, 14.4), to: p(12, 14.4), lineWidth: len(1.1))   // left
            strokeLine(from: p(16.8, 14.4), to: p(18, 14.4), lineWidth: len(1.1))   // right (reaches edge)
        case .stopped:
            break
        }

        if needsAttention {
            // "Needs you": a second halo+dot in the opposite (top-right) corner. SVG y=3 is
            // near the top of the canvas; `p` flips it to AppKit's large-y "top".
            let center = p(15, 3)
            punchHalo(center: center, radius: len(3.7))
            fillCircle(center: center, radius: len(2.4))
        }
    }

    private static func fillCircle(center: NSPoint, radius: CGFloat) {
        let rect = NSRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
        NSColor.black.setFill()
        NSBezierPath(ovalIn: rect).fill()
    }

    private static func strokeCircle(center: NSPoint, radius: CGFloat, lineWidth: CGFloat) {
        let rect = NSRect(x: center.x - radius, y: center.y - radius, width: radius * 2, height: radius * 2)
        let path = NSBezierPath(ovalIn: rect)
        path.lineWidth = lineWidth
        NSColor.black.setStroke()
        path.stroke()
    }

    private static func strokeLine(from: NSPoint, to: NSPoint, lineWidth: CGFloat) {
        let path = NSBezierPath()
        path.move(to: from)
        path.line(to: to)
        path.lineWidth = lineWidth
        path.lineCapStyle = .round
        NSColor.black.setStroke()
        path.stroke()
    }
}
