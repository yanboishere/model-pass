// swift-tools-version:5.9
// Lets iOS apps depend on this repository directly with SwiftPM:
//   .package(url: "https://github.com/yanboishere/modelpass", branch: "main")
// The sources live in sdks/ios (which is also a standalone package with tests).
import PackageDescription

let package = Package(
    name: "ModelPassSDK",
    platforms: [.iOS(.v15), .macCatalyst(.v15), .macOS(.v12)],
    products: [.library(name: "ModelPassSDK", targets: ["ModelPassSDK"])],
    targets: [.target(name: "ModelPassSDK", path: "sdks/ios/Sources/ModelPassSDK")]
)
