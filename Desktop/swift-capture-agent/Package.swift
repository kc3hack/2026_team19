// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "SwiftCaptureAgent",
    platforms: [
        .macOS(.v14)
    ],
    products: [
        .executable(name: "swift-capture-agent", targets: ["SwiftCaptureAgent"])
    ],
    dependencies: [
        .package(url: "https://github.com/vapor/vapor.git", from: "4.111.0")
    ],
    targets: [
        .executableTarget(
            name: "SwiftCaptureAgent",
            dependencies: [
                .product(name: "Vapor", package: "vapor")
            ]
        )
    ]
)
