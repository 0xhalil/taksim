// swift-tools-version: 5.9
// CodeEditApp/CodeEditSourceEditor 0.15.2 (MIT, see LICENSE), kept here so taksim can draw parts of it its own
// way: the folding ribbon is PyCharm's (a chevron where a block starts; on hover its end and a thin guide)
// instead of Xcode's filled column (LineFolding/View/LineFoldRibbonView+Draw.swift). The SwiftLint plugin and
// the tests are left out; CodeEditSymbols is the stand-in next to it.

import PackageDescription

let package = Package(
    name: "CodeEditSourceEditor",
    platforms: [.macOS(.v13)],
    products: [.library(name: "CodeEditSourceEditor", targets: ["CodeEditSourceEditor"])],
    dependencies: [
        .package(url: "https://github.com/CodeEditApp/CodeEditTextView.git", from: "0.12.1"),
        .package(url: "https://github.com/CodeEditApp/CodeEditLanguages.git", exact: "0.1.20"),
        .package(path: "../CodeEditSymbols"),
        .package(url: "https://github.com/ChimeHQ/TextFormation", from: "0.8.2"),
    ],
    targets: [
        .target(name: "CodeEditSourceEditor", dependencies: ["CodeEditTextView", "CodeEditLanguages", "TextFormation", "CodeEditSymbols"]),
    ]
)
