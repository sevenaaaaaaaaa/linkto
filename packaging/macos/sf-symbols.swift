import AppKit
import Foundation

/// LinkTo SF Symbols 渲染器（macOS 系统 API，不随包分发 Apple 图标资源）
/// 用法: sf-symbols <输出目录> <点大小> <symbol 名称...>
/// 输出: <名称去点>.png（黑字透明底，作为 CSS mask 使用）

func render(_ name: String, pointSize: CGFloat, output: String) -> Bool {
  guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil) else { return false }
  let config = NSImage.SymbolConfiguration(pointSize: pointSize, weight: .regular)
  let image = base.withSymbolConfiguration(config) ?? base
  let px = Int((pointSize * 2).rounded())
  guard px > 0, let rep = NSBitmapImageRep(
    bitmapDataPlanes: nil,
    pixelsWide: px,
    pixelsHigh: px,
    bitsPerSample: 8,
    samplesPerPixel: 4,
    hasAlpha: true,
    isPlanar: false,
    colorSpaceName: .deviceRGB,
    bytesPerRow: 0,
    bitsPerPixel: 0
  ) else { return false }
  guard let ctx = NSGraphicsContext(bitmapImageRep: rep) else { return false }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = ctx
  ctx.imageInterpolation = .high
  NSColor.clear.set()
  NSRect(x: 0, y: 0, width: px, height: px).fill()
  let size = image.size
  if size.width > 0, size.height > 0 {
    let scale = min(CGFloat(px) / size.width, CGFloat(px) / size.height)
    let w = size.width * scale
    let h = size.height * scale
    NSColor.black.set()
    image.draw(in: NSRect(x: (CGFloat(px) - w) / 2, y: (CGFloat(px) - h) / 2, width: w, height: h), from: .zero, operation: .sourceOver, fraction: 1)
  }
  NSGraphicsContext.restoreGraphicsState()
  guard let data = rep.representation(using: .png, properties: [:]) else { return false }
  return (try? data.write(to: URL(fileURLWithPath: output))) != nil
}

let args = Array(CommandLine.arguments.dropFirst())
guard args.count >= 3 else {
  FileHandle.standardError.write(Data("usage: sf-symbols <outdir> <point-size> <name...>\n".utf8))
  exit(2)
}
let dir = args[0]
let pointSize = CGFloat(Double(args[1]) ?? 18)
try? FileManager.default.createDirectory(atPath: dir, withIntermediateDirectories: true)
for name in args.dropFirst(2) {
  let file = (dir as NSString).appendingPathComponent(name.replacingOccurrences(of: ".", with: "_") + ".png")
  let ok = render(name, pointSize: pointSize, output: file)
  print("\(ok ? "ok" : "missing") \(name)")
}
