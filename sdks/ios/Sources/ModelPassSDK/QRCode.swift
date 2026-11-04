#if canImport(CoreImage)
import CoreGraphics
import CoreImage
import CoreImage.CIFilterBuiltins
import Foundation
#if canImport(UIKit)
import UIKit
#endif

/// Renders QR codes with CoreImage's `CIQRCodeGenerator` (black modules on white, crisp integer scaling).
public enum ModelPassQRCode {
    /// - Parameters:
    ///   - string: The QR content, e.g. `link.qrURL.absoluteString`.
    ///   - dimension: Approximate output size in pixels (the module size is rounded down to whole pixels).
    ///   - correctionLevel: `L`, `M`, `Q` or `H`.
    public static func cgImage(for string: String, dimension: CGFloat = 512, correctionLevel: String = "M") -> CGImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(string.utf8)
        filter.correctionLevel = correctionLevel
        guard let output = filter.outputImage, output.extent.width > 0 else { return nil }
        let scale = max(1, (dimension / output.extent.width).rounded(.down))
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        return CIContext(options: [.cacheIntermediates: false]).createCGImage(scaled, from: scaled.extent)
    }

    #if canImport(UIKit)
    public static func uiImage(for string: String, dimension: CGFloat = 512) -> UIImage? {
        cgImage(for: string, dimension: dimension).map { UIImage(cgImage: $0) }
    }
    #endif
}

extension ModelPassLink {
    /// The link's QR code (`qrURL`) as a `CGImage`.
    public nonisolated func qrCodeImage(dimension: CGFloat = 512) -> CGImage? {
        ModelPassQRCode.cgImage(for: qrURL.absoluteString, dimension: dimension)
    }

    #if canImport(UIKit)
    /// The link's QR code (`qrURL`) as a `UIImage`.
    public nonisolated func qrCodeUIImage(dimension: CGFloat = 512) -> UIImage? {
        ModelPassQRCode.uiImage(for: qrURL.absoluteString, dimension: dimension)
    }
    #endif
}
#endif
