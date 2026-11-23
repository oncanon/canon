import Foundation

/// Read-only facts the Settings "Store" and "Command-line tool" rows show. Each one is a plain
/// filesystem read — nothing here writes to `~/.canon` or talks to the server. The edition count
/// and CLI version are stopgaps until Core exposes them (docs/app/core-contract-requests.md #4/#5).
enum StoreFacts {
    /// `/Users/you/.canon` → `~/.canon`, as page10 prints it.
    static func tildePath(_ path: String) -> String {
        (path as NSString).abbreviatingWithTildeInPath
    }

    /// Editions = content-addressed packets (`store/packets/sha256-*`). Canon never deletes
    /// them, so this only grows.
    static func editionCount(storeRoot: String) -> Int? {
        let dir = (storeRoot as NSString).appendingPathComponent("packets")
        guard let names = try? FileManager.default.contentsOfDirectory(atPath: dir) else { return nil }
        return names.filter { $0.hasPrefix("sha256-") }.count
    }

    /// The resolved `canon` on PATH and its version. `canon --version` doesn't exist yet, so the
    /// version is read from the `package.json` beside the resolved CLI script (name must be
    /// "canon").
    static func cli() -> (path: String, version: String?)? {
        guard let path = ShellRunner.findExecutable("canon") else { return nil }
        let resolved = (path as NSString).resolvingSymlinksInPath
        var dir = (resolved as NSString).deletingLastPathComponent
        for _ in 0..<3 {
            let pkg = (dir as NSString).appendingPathComponent("package.json")
            if let data = FileManager.default.contents(atPath: pkg),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               json["name"] as? String == "canon" {
                return (path, json["version"] as? String)
            }
            dir = (dir as NSString).deletingLastPathComponent
        }
        return (path, nil)
    }

    static var appVersion: String? {
        Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String
    }
}
