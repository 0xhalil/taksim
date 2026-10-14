// swift-tools-version: 5.9
// Stands in for CodeEditApp/CodeEditSymbols (a dependency of CodeEditSourceEditor): that package keeps its
// symbols in an asset catalog, which `swift build` can't compile. The editor only imports it, so the same API
// is kept here on system symbols. Being a local package with the same name, it overrides the remote one.

import PackageDescription

let package = Package(
    name: "CodeEditSymbols",
    platforms: [.macOS(.v13)],
    products: [.library(name: "CodeEditSymbols", targets: ["CodeEditSymbols"])],
    targets: [.target(name: "CodeEditSymbols")]
)
