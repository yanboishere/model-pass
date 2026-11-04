// swift-tools-version: 5.9
// Interop harness: drives the iOS/macOS SDK against a live hub (npm run hub) with a headless wallet.
//   cd scripts/interop/swift && swift run
import PackageDescription

let package = Package(
    name: "Interop",
    platforms: [.macOS(.v13)],
    dependencies: [.package(path: "../../../sdks/ios")],
    targets: [
        .executableTarget(name: "Interop", dependencies: [.product(name: "ModelPassSDK", package: "ios")])
    ]
)
