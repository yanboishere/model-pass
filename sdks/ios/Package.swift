// swift-tools-version:5.9
// ModelPassSDK — "Continue with ModelPass" for iOS (ModelPass Connect protocol v0.1).
// No third-party dependencies: Foundation, CryptoKit, Security, Combine and (optionally) UIKit / SwiftUI.
import PackageDescription

let package = Package(
    name: "ModelPassSDK",
    platforms: [
        .iOS(.v15),
        .macCatalyst(.v15),
        .macOS(.v12),
    ],
    products: [
        .library(name: "ModelPassSDK", targets: ["ModelPassSDK"]),
    ],
    targets: [
        .target(name: "ModelPassSDK"),
        .testTarget(name: "ModelPassSDKTests", dependencies: ["ModelPassSDK"]),
    ]
)
