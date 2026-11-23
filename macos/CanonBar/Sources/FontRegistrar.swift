import AppKit
import CoreText

/// Registers the bundled OFL fonts (Libron, Inter, JetBrains Mono — see Resources/Fonts/SOURCE.md)
/// for this process only, so `Font.custom(...)` resolves without installing anything into the
/// user's Font Book.
enum FontRegistrar {
    static func registerBundledFonts() {
        guard let fontsDir = Bundle.main.resourceURL?.appendingPathComponent("Fonts"),
              let files = try? FileManager.default.contentsOfDirectory(at: fontsDir, includingPropertiesForKeys: nil)
        else { return }

        for file in files where ["otf", "ttf"].contains(file.pathExtension.lowercased()) {
            var error: Unmanaged<CFError>?
            CTFontManagerRegisterFontsForURL(file as CFURL, .process, &error)
        }
    }
}
