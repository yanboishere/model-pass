#if canImport(SwiftUI)
import SwiftUI

/// The "使用 ModelPass 继续 / Continue with ModelPass" button (protocol §14): brand color #5B5BF7,
/// 12 pt continuous corner radius, 50 pt height. The title follows the SwiftUI environment locale.
///
/// ```swift
/// ModelPassButton(isLoading: modelPass.isAuthorizing) {
///     Task { try? await modelPass.authorize() }
/// }
/// ```
public struct ModelPassButton: View {
    public enum Style: Sendable {
        /// White text on the brand color.
        case filled
        /// Brand-colored text and border on a clear background.
        case outlined
    }

    /// ModelPass brand color, #5B5BF7.
    public static let brandColor = Color(red: 91 / 255, green: 91 / 255, blue: 247 / 255)

    private let title: String?
    private let style: Style
    private let isLoading: Bool
    private let action: () -> Void

    @Environment(\.locale) private var locale

    /// - Parameters:
    ///   - title: Custom title; defaults to "使用 ModelPass 继续" for Chinese locales, "Continue with ModelPass" otherwise.
    ///   - style: `.filled` (default) or `.outlined`.
    ///   - isLoading: Shows a spinner and disables the button (e.g. bind to `modelPass.isAuthorizing`).
    public init(_ title: String? = nil, style: Style = .filled, isLoading: Bool = false, action: @escaping () -> Void) {
        self.title = title
        self.style = style
        self.isLoading = isLoading
        self.action = action
    }

    private var resolvedTitle: String {
        if let title { return title }
        return locale.identifier.lowercased().hasPrefix("zh") ? "使用 ModelPass 继续" : "Continue with ModelPass"
    }

    private var foreground: Color { style == .filled ? .white : Self.brandColor }

    public var body: some View {
        Button(action: action) {
            HStack(spacing: 10) {
                if isLoading {
                    ProgressView()
                        .progressViewStyle(.circular)
                        .tint(foreground)
                        .frame(width: 22, height: 22)
                } else {
                    ModelPassLogo(ticketColor: foreground, markColor: style == .filled ? Self.brandColor : .white)
                        .frame(width: 22, height: 22)
                }
                Text(resolvedTitle)
                    .font(.system(size: 17, weight: .semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
            }
            .padding(.horizontal, 16)
            .frame(maxWidth: .infinity, minHeight: 50)
            .contentShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
        .buttonStyle(ModelPassButtonStyle(style: style, isLoading: isLoading))
        .disabled(isLoading)
        .accessibilityLabel(Text(resolvedTitle))
    }
}

private struct ModelPassButtonStyle: ButtonStyle {
    let style: ModelPassButton.Style
    let isLoading: Bool
    @Environment(\.isEnabled) private var isEnabled

    private func opacity(pressed: Bool) -> Double {
        if isLoading { return 1 } // busy, not disabled: keep full color behind the spinner
        if !isEnabled { return 0.5 }
        return pressed ? 0.85 : 1
    }

    func makeBody(configuration: Configuration) -> some View {
        let shape = RoundedRectangle(cornerRadius: 12, style: .continuous)
        return configuration.label
            .foregroundColor(style == .filled ? .white : ModelPassButton.brandColor)
            .background(shape.fill(style == .filled ? ModelPassButton.brandColor : Color.clear))
            .overlay(shape.strokeBorder(ModelPassButton.brandColor, lineWidth: style == .outlined ? 1.5 : 0))
            .opacity(opacity(pressed: configuration.isPressed))
            .scaleEffect(configuration.isPressed ? 0.98 : 1)
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

/// The ModelPass mark: a pass (ticket) with an "M".
public struct ModelPassLogo: View {
    private let ticketColor: Color
    private let markColor: Color

    public init(ticketColor: Color = ModelPassButton.brandColor, markColor: Color = .white) {
        self.ticketColor = ticketColor
        self.markColor = markColor
    }

    public var body: some View {
        GeometryReader { proxy in
            let side = min(proxy.size.width, proxy.size.height)
            ZStack {
                PassShape().fill(ticketColor)
                MShape().stroke(markColor, style: StrokeStyle(lineWidth: side * 0.11, lineCap: .round, lineJoin: .round))
            }
            .frame(width: side, height: side)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .accessibilityHidden(true)
    }

    /// Rounded ticket with semicircular notches on the left and right edges.
    private struct PassShape: Shape {
        func path(in rect: CGRect) -> Path {
            let w = rect.width, h = rect.height * 0.78
            let top = rect.minY + (rect.height - h) / 2
            let r = min(w, h) * 0.2
            let notch = h * 0.15
            let midY = top + h / 2
            var path = Path()
            path.move(to: CGPoint(x: rect.minX + r, y: top))
            path.addLine(to: CGPoint(x: rect.maxX - r, y: top))
            path.addArc(center: CGPoint(x: rect.maxX - r, y: top + r), radius: r,
                        startAngle: .degrees(-90), endAngle: .degrees(0), clockwise: false)
            path.addLine(to: CGPoint(x: rect.maxX, y: midY - notch))
            path.addArc(center: CGPoint(x: rect.maxX, y: midY), radius: notch,
                        startAngle: .degrees(-90), endAngle: .degrees(90), clockwise: true)
            path.addLine(to: CGPoint(x: rect.maxX, y: top + h - r))
            path.addArc(center: CGPoint(x: rect.maxX - r, y: top + h - r), radius: r,
                        startAngle: .degrees(0), endAngle: .degrees(90), clockwise: false)
            path.addLine(to: CGPoint(x: rect.minX + r, y: top + h))
            path.addArc(center: CGPoint(x: rect.minX + r, y: top + h - r), radius: r,
                        startAngle: .degrees(90), endAngle: .degrees(180), clockwise: false)
            path.addLine(to: CGPoint(x: rect.minX, y: midY + notch))
            path.addArc(center: CGPoint(x: rect.minX, y: midY), radius: notch,
                        startAngle: .degrees(90), endAngle: .degrees(-90), clockwise: true)
            path.addLine(to: CGPoint(x: rect.minX, y: top + r))
            path.addArc(center: CGPoint(x: rect.minX + r, y: top + r), radius: r,
                        startAngle: .degrees(180), endAngle: .degrees(270), clockwise: false)
            path.closeSubpath()
            return path
        }
    }

    /// A stroked "M" centred in the ticket.
    private struct MShape: Shape {
        func path(in rect: CGRect) -> Path {
            let w = rect.width, h = rect.height
            var path = Path()
            path.move(to: CGPoint(x: rect.minX + w * 0.32, y: rect.minY + h * 0.64))
            path.addLine(to: CGPoint(x: rect.minX + w * 0.32, y: rect.minY + h * 0.36))
            path.addLine(to: CGPoint(x: rect.minX + w * 0.5, y: rect.minY + h * 0.54))
            path.addLine(to: CGPoint(x: rect.minX + w * 0.68, y: rect.minY + h * 0.36))
            path.addLine(to: CGPoint(x: rect.minX + w * 0.68, y: rect.minY + h * 0.64))
            return path
        }
    }
}

#if canImport(CoreImage)
/// Shows a link-flow QR code (`ModelPassLink.qrURL`) with crisp, unsmoothed modules.
public struct ModelPassQRCodeView: View {
    private let content: String

    public init(link: ModelPassLink) { content = link.qrURL.absoluteString }
    public init(url: URL) { content = url.absoluteString }

    public var body: some View {
        if let image = ModelPassQRCode.cgImage(for: content, dimension: 1024) {
            Image(decorative: image, scale: 1)
                .interpolation(.none)
                .resizable()
                .scaledToFit()
                .accessibilityLabel(Text("ModelPass QR code"))
        } else {
            Color.clear
        }
    }
}
#endif
#endif
