import AppKit

// Draws the pill-shaped glass behind Memo's transparent overlay window. Electron
// vibrancy always fills the whole rectangular window, so the shape lives here.
// Commands arrive on stdin: "show <x> <y> <width> <height>" (top-left origin) or
// "hide". The helper exits when Memo closes its stdin.

final class GlassPanel {
  private let panel: NSPanel

  init() {
    panel = NSPanel(
      contentRect: .zero,
      styleMask: [.borderless, .nonactivatingPanel],
      backing: .buffered,
      defer: false
    )
    panel.isOpaque = false
    panel.backgroundColor = .clear
    panel.hasShadow = true
    panel.ignoresMouseEvents = true
    panel.hidesOnDeactivate = false
    panel.isReleasedWhenClosed = false
    // Memo's overlay window sits at the screen-saver level, above this panel.
    panel.level = .popUpMenu
    panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary, .ignoresCycle]
  }

  private func makeGlassView(cornerRadius: CGFloat) -> NSView {
    #if compiler(>=6.2)
    if #available(macOS 26.0, *) {
      let glass = NSGlassEffectView()
      glass.style = .clear
      glass.cornerRadius = cornerRadius
      glass.contentView = NSView()
      return glass
    }
    #endif
    let blur = NSVisualEffectView()
    blur.appearance = NSAppearance(named: .aqua)
    blur.material = .hudWindow
    blur.blendingMode = .behindWindow
    blur.state = .active
    blur.wantsLayer = true
    blur.layer?.cornerRadius = cornerRadius
    blur.layer?.masksToBounds = true
    return blur
  }

  func show(pill: CGRect) {
    guard let primary = NSScreen.screens.first else { return }
    #if compiler(>=6.2)
    if #available(macOS 26.0, *) {
      let accessibility = NSWorkspace.shared
      let useOpaqueMaterial = accessibility.accessibilityDisplayShouldReduceTransparency
        || accessibility.accessibilityDisplayShouldIncreaseContrast
      // Let the actual desktop detail show through the native backdrop blur.
      panel.alphaValue = useOpaqueMaterial ? 1 : 0.5
    }
    #endif
    let rect = NSRect(x: pill.minX, y: primary.frame.maxY - pill.maxY, width: pill.width, height: pill.height)
    // Give the glass its own view inside the clear panel so AppKit can composite its edges.
    let padding: CGFloat = 8
    let frame = rect.insetBy(dx: -padding, dy: -padding)
    panel.setFrame(frame, display: false)
    let container = NSView(frame: NSRect(origin: .zero, size: frame.size))
    let glass = makeGlassView(cornerRadius: pill.height / 2)
    glass.frame = container.bounds.insetBy(dx: padding, dy: padding)
    container.addSubview(glass)
    panel.contentView = container
    panel.orderFrontRegardless()
    panel.invalidateShadow()
  }

  func hide() {
    panel.orderOut(nil)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let glass = GlassPanel()

DispatchQueue.global(qos: .userInitiated).async {
  while let line = readLine() {
    let parts = line.split(separator: " ")
    DispatchQueue.main.async {
      if parts.first == "hide" {
        glass.hide()
      } else if parts.first == "show", parts.count == 5 {
        let values = parts.dropFirst().compactMap { Double($0) }
        guard values.count == 4, values.allSatisfy(\.isFinite) else { return }
        glass.show(pill: CGRect(x: values[0], y: values[1], width: values[2], height: values[3]))
      }
    }
  }
  exit(0)
}

app.run()
