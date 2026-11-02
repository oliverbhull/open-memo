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

  func show(x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat) {
    guard let primary = NSScreen.screens.first else { return }
    let bottom = primary.frame.maxY - y - height
    panel.setFrame(NSRect(x: x, y: bottom, width: width, height: height), display: false)
    panel.contentView = makeGlassView(cornerRadius: height / 2)
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
        guard values.count == 4 else { return }
        glass.show(
          x: CGFloat(values[0]),
          y: CGFloat(values[1]),
          width: CGFloat(values[2]),
          height: CGFloat(values[3])
        )
      }
    }
  }
  exit(0)
}

app.run()
