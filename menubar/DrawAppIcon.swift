import AppKit
import CoreGraphics

let output = URL(fileURLWithPath: CommandLine.arguments[1], isDirectory: true)
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)

let colorSpace = CGColorSpace(name: CGColorSpace.sRGB)!
func color(_ hex: UInt32) -> CGColor {
    CGColor(
        red: CGFloat((hex >> 16) & 255) / 255,
        green: CGFloat((hex >> 8) & 255) / 255,
        blue: CGFloat(hex & 255) / 255,
        alpha: 1
    )
}

func render(size: Int, name: String) throws {
    let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8,
                            bytesPerRow: size * 4, space: colorSpace,
                            bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    let scale = CGFloat(size) / 1024
    context.scaleBy(x: scale, y: scale)
    let tile = CGRect(x: 96, y: 96, width: 832, height: 832)
    let outline = CGPath(roundedRect: tile, cornerWidth: 188, cornerHeight: 188, transform: nil)
    context.saveGState()
    context.addPath(outline)
    context.clip()
    let gradient = CGGradient(colorsSpace: colorSpace, colors: [color(0x243860), color(0x101828)] as CFArray, locations: nil)!
    context.drawLinearGradient(gradient, start: CGPoint(x: 170, y: 880), end: CGPoint(x: 820, y: 150), options: [.drawsBeforeStartLocation, .drawsAfterEndLocation])
    context.restoreGState()
    context.addPath(outline)
    context.setStrokeColor(color(0x3C527A))
    context.setLineWidth(10)
    context.strokePath()

    func arcArrow(start: CGFloat, end: CGFloat, ink: UInt32) {
        let center = CGPoint(x: 512, y: 512)
        let radius: CGFloat = 188
        let tip = CGPoint(x: center.x + radius * cos(end), y: center.y + radius * sin(end))
        let tangent = CGPoint(x: -sin(end), y: cos(end))
        let normal = CGPoint(x: cos(end), y: sin(end))
        context.setStrokeColor(color(ink))
        context.setLineCap(.round)
        context.setLineJoin(.round)
        context.setLineWidth(64)
        context.beginPath()
        context.addArc(center: center, radius: radius, startAngle: start, endAngle: end, clockwise: false)
        context.strokePath()
        context.beginPath()
        context.move(to: CGPoint(x: tip.x - 91 * tangent.x + 61 * normal.x, y: tip.y - 91 * tangent.y + 61 * normal.y))
        context.addLine(to: tip)
        context.addLine(to: CGPoint(x: tip.x - 91 * tangent.x - 61 * normal.x, y: tip.y - 91 * tangent.y - 61 * normal.y))
        context.strokePath()
    }

    arcArrow(start: 0.20, end: 2.78, ink: 0xF2F6FF)
    arcArrow(start: .pi + 0.20, end: .pi + 2.78, ink: 0x85CBFF)
    let bitmap = NSBitmapImageRep(cgImage: context.makeImage()!)
    try bitmap.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name))
}

for base in [16, 32, 128, 256, 512] {
    try render(size: base, name: "icon_\(base)x\(base).png")
    try render(size: base * 2, name: "icon_\(base)x\(base)@2x.png")
}
