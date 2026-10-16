// Read-only, bounded Accessibility snapshot. Never reads message-body values.
import AppKit
import ApplicationServices

let deadline = ProcessInfo.processInfo.systemUptime + 0.22
var visited = 0
func attr(_ e: AXUIElement, _ name: String) -> CFTypeRef? {
    guard ProcessInfo.processInfo.systemUptime < deadline else { return nil }
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(e, name as CFString, &value) == .success else { return nil }
    return value
}
func text(_ e: AXUIElement, _ name: String) -> String { (attr(e, name) as? String) ?? "" }
func element(_ e: AXUIElement, _ name: String) -> AXUIElement? {
    guard let value = attr(e, name), CFGetTypeID(value) == AXUIElementGetTypeID() else { return nil }
    return (value as! AXUIElement)
}
func children(_ e: AXUIElement) -> [AXUIElement] { (attr(e, "AXChildren") as? [AXUIElement]) ?? [] }
func walk(_ e: AXUIElement, depth: Int, visit: (AXUIElement, String) -> Bool) {
    guard depth >= 0, visited < 250, ProcessInfo.processInfo.systemUptime < deadline else { return }
    visited += 1
    let role = text(e, "AXRole")
    // Exclude editors, quoted bodies, message lists and embedded applications.
    if ["AXTextArea", "AXWebArea", "AXList", "AXTable"].contains(role) { return }
    guard visit(e, role) else { return }
    for child in children(e) { walk(child, depth: depth - 1, visit: visit) }
}
func snapshot() -> [String: Any] {
    // Explicit bundle selection is for read-only diagnostics; dictation passes no arguments.
    let diagnosticBundle = CommandLine.arguments.count == 3 && CommandLine.arguments[1] == "--bundle" ? CommandLine.arguments[2] : nil
    let runningApp = diagnosticBundle != nil ? NSRunningApplication.runningApplications(withBundleIdentifier: diagnosticBundle!).first : NSWorkspace.shared.frontmostApplication
    guard let running = runningApp,
          let bundle = running.bundleIdentifier,
          ["com.apple.Safari", "com.apple.SafariTechnologyPreview", "com.google.Chrome", "com.google.Chrome.canary", "com.microsoft.edgemac", "com.brave.Browser", "company.thebrowser.Browser"].contains(bundle) else { return [:] }
    let app = AXUIElementCreateApplication(running.processIdentifier)
    AXUIElementSetMessagingTimeout(app, 0.03)
    guard let window = element(app, "AXFocusedWindow") else { return [:] }
    var url = text(window, "AXDocument")
    if url.isEmpty {
        // Native browser toolbar only; no scan of page text or other tabs.
        for toolbar in children(window) where text(toolbar, "AXRole") == "AXToolbar" {
            walk(toolbar, depth: 6) { e, role in
                if role == "AXTextField" {
                    let id = text(e, "AXIdentifier")
                    let label = text(e, "AXDescription")
                    if id == "WEB_BROWSER_ADDRESS_AND_SEARCH_FIELD" || label == "smart search field" || label == "Address and search bar" {
                        url = text(e, "AXValue")
                    }
                    return false
                }
                return url.isEmpty
            }
        }
    }
    var result: [String: Any] = ["bundleId": bundle, "windowTitle": text(window, "AXTitle"), "documentURL": url]
    guard let parsed = URL(string: url), parsed.host == "mail.google.com",
          let focused = element(app, "AXFocusedUIElement"), text(focused, "AXRole") == "AXTextArea",
          text(focused, "AXDescription") == "Message Body" || text(focused, "AXTitle") == "Message Body" else { return result }
    // The first enclosing region containing the editor is the active composer.
    // Do not cross into the outer message/thread when finding recipients.
    var ancestor = element(focused, "AXParent")
    var composer: AXUIElement?
    var conversation: AXUIElement?
    for _ in 0..<40 {
        guard let current = ancestor else { break }
        let role = text(current, "AXRole")
        if role == "AXWebArea" || role == "AXWindow" { break }
        if composer == nil && ["AXLandmarkRegion", "AXDialog"].contains(text(current, "AXSubrole")) {
            composer = current
        } else if composer != nil && (text(current, "AXSubrole") == "AXLandmarkMain" || (children(current).count > 1 && children(current).contains(where: { text($0, "AXRole") == "AXList" }))) {
            conversation = current
            break
        }
        ancestor = element(current, "AXParent")
    }
    guard let composer = composer else { return result }
    var header: AXUIElement?
    walk(composer, depth: 10) { e, role in
        if header != nil { return false }
        if role == "AXPopUpButton" && text(e, "AXTitle") == "Type of response",
           let parent = element(e, "AXParent"), let container = element(parent, "AXParent") {
            header = container
            return false
        }
        return true
    }
    // The response-type control and recipient chips share this header container
    // in both Safari and Chrome. Read no sibling body, warning or signature.
    var recipientLabels: [String] = []
    if let header = header {
        walk(header, depth: 6) { e, role in
            if role == "AXStaticText" {
                let label = text(e, "AXValue")
                if label.contains("@") && label.count <= 500 { recipientLabels.append(label) }
            }
            return true
        }
    }
    if !recipientLabels.isEmpty { result["recipientLabels"] = recipientLabels }
    if let conversation = conversation {
        var subjects: [String] = []
        walk(conversation, depth: 10) { e, role in
            if role == "AXHeading" {
                if (attr(e, "AXValue") as? NSNumber)?.intValue == 2 {
                    let title = text(e, "AXTitle")
                    if !title.isEmpty { subjects.append(title) }
                }
                return false
            }
            return true
        }
        if subjects.count == 1 { result["subject"] = String(subjects[0].prefix(1000)) }
    }
    result["focusedReply"] = true
    return result
}
let result = snapshot()
if let data = try? JSONSerialization.data(withJSONObject: result, options: [.sortedKeys]), let json = String(data: data, encoding: .utf8) { print(json) }
