// Native window for BisMind: one WKWebView, its own Dock icon, no tabs.
// Built on demand by bin/bismind.mjs; the page URL arrives as the first argument.
import Cocoa
import WebKit

final class AppDelegate: NSObject, NSApplicationDelegate, WKUIDelegate {
  var window: NSWindow!
  var web: WKWebView!

  func applicationDidFinishLaunching(_ note: Notification) {
    let config = WKWebViewConfiguration()
    config.preferences.javaScriptCanOpenWindowsAutomatically = true
    config.preferences.setValue(true, forKey: "javaScriptCanAccessClipboard")
    config.preferences.setValue(true, forKey: "DOMPasteAllowed")
    web = WKWebView(frame: .zero, configuration: config)
    web.uiDelegate = self
    web.setValue(false, forKey: "drawsBackground")

    window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1400, height: 900),
                      styleMask: [.titled, .closable, .miniaturizable, .resizable],
                      backing: .buffered, defer: false)
    window.title = "BisMind"
    window.contentView = web
    window.isReleasedWhenClosed = false
    window.setFrameAutosaveName("BisMind")
    if !window.setFrameUsingName("BisMind") { window.center() }
    window.makeKeyAndOrderFront(nil)

    buildMenu()
    let args = CommandLine.arguments
    if args.count > 1, let url = URL(string: args[1]) { web.load(URLRequest(url: url)) } else { startAndLoad() }
    NSApp.activate(ignoringOtherApps: true)
  }

  // Opened from the Dock with no URL: start the server (`bismind up`), then load the app with the token.
  func startAndLoad() {
    let info = Bundle.main.infoDictionary ?? [:]
    guard let node = info["BisMindNode"] as? String, let cli = info["BisMindCLI"] as? String,
          let port = info["BisMindPort"] as? String, let dir = info["BisMindHome"] as? String else { return }
    DispatchQueue.global().async {
      let up = Process()
      up.executableURL = URL(fileURLWithPath: node)
      up.arguments = [cli, "up"]
      try? up.run()
      up.waitUntilExit()
      let token = (try? String(contentsOfFile: dir + "/token", encoding: .utf8))?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
      guard let url = URL(string: "http://127.0.0.1:\(port)/?t=\(token)") else { return }
      DispatchQueue.main.async { self.web.load(URLRequest(url: url)) }
    }
  }

  // Clicking the Dock icon brings the one window back; it never opens anything new.
  func applicationShouldHandleReopen(_ app: NSApplication, hasVisibleWindows: Bool) -> Bool {
    window.makeKeyAndOrderFront(nil)
    return true
  }

  // Links that want a new window open in the default browser instead.
  func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
               for action: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
    if let url = action.request.url { NSWorkspace.shared.open(url) }
    return nil
  }

  @objc func reload() { web.reload() }

  func buildMenu() {
    let main = NSMenu()
    let appItem = NSMenuItem(); main.addItem(appItem)
    let appMenu = NSMenu()
    appMenu.addItem(withTitle: "Hide BisMind", action: #selector(NSApplication.hide(_:)), keyEquivalent: "h")
    appMenu.addItem(withTitle: "Quit BisMind", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
    appItem.submenu = appMenu

    let editItem = NSMenuItem(); main.addItem(editItem)
    let edit = NSMenu(title: "Edit")
    edit.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
    edit.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
    edit.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
    edit.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
    edit.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
    editItem.submenu = edit

    let viewItem = NSMenuItem(); main.addItem(viewItem)
    let view = NSMenu(title: "View")
    view.addItem(withTitle: "Reload", action: #selector(reload), keyEquivalent: "r").target = self
    viewItem.submenu = view

    let winItem = NSMenuItem(); main.addItem(winItem)
    let win = NSMenu(title: "Window")
    win.addItem(withTitle: "Close", action: #selector(NSWindow.performClose(_:)), keyEquivalent: "w")
    win.addItem(withTitle: "Minimize", action: #selector(NSWindow.miniaturize(_:)), keyEquivalent: "m")
    winItem.submenu = win
    NSApp.mainMenu = main
  }
}

let app = NSApplication.shared
let delegate = AppDelegate()
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
