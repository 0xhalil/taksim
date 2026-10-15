// swift-tools-version: 6.0
// taksim's native macOS app. The engine stays the Node server (../src) for now; the app is a second client
// of its REST/SSE/WebSocket API and starts it when it isn't running. Open this folder in Xcode, or build
// the .app with scripts/build-app.sh.

import PackageDescription

let v5: [SwiftSetting] = [.swiftLanguageMode(.v5)]

let package = Package(
    name: "Taksim",
    platforms: [.macOS(.v15)],
    products: [
        .library(name: "TaksimKit", targets: ["TaksimKit"]),
        .executable(name: "Taksim", targets: ["Taksim"]),
        .executable(name: "taksim-computer", targets: ["TaksimComputer"]),
    ],
    dependencies: [
        // the terminal view (MIT); fed from the server's terminal WebSocket, it opens no PTY of its own
        .package(url: "https://github.com/migueldeicaza/SwiftTerm", from: "1.2.0"),
        // the IDE's editor (MIT): CodeEdit's text view with tree-sitter highlighting, find, folding, gutter;
        // a copy with our own folding ribbon (see Vendor/CodeEditSourceEditor/Package.swift)
        .package(path: "Vendor/CodeEditSourceEditor"),
    ],
    targets: [
        // models, API client, event stream, state, server launcher: no UI
        .target(name: "TaksimKit", swiftSettings: v5),
        // the app: SwiftUI + AppKit
        .executableTarget(name: "Taksim", dependencies: ["TaksimKit", "SwiftTerm",
            .product(name: "CodeEditSourceEditor", package: "CodeEditSourceEditor")], swiftSettings: v5),
        // the agents' hands and eyes on the Mac (computer_* tools): started by the engine, shipped inside the app
        .executableTarget(name: "TaksimComputer", swiftSettings: v5),
        .testTarget(name: "TaksimUITests", dependencies: ["Taksim", "TaksimKit"], swiftSettings: v5),
        .testTarget(name: "TaksimKitTests", dependencies: ["TaksimKit"], resources: [.copy("Fixtures")], swiftSettings: v5),
    ]
)
