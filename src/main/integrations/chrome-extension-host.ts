import { BrowserView, BrowserWindow } from "electron";
import path from "path";
import { ElectronChromeExtensions } from "electron-chrome-extensions";

// Electron only natively implements a subset of the extension APIs our loaded extensions need
// (e.g. chrome.browserAction/chrome.action is entirely missing, which crashes a background page or
// service worker on startup before any of its own logic runs). electron-chrome-extensions fills in
// most of that gap; ensureChromeExtensionsSupport() below fills in the rest (chrome.alarms and
// chrome.storage.sync, which neither Electron nor electron-chrome-extensions implement).
//
// electron-chrome-extensions only allows a single instance per session (its constructor throws if
// one already exists), so every integration that loads an extension onto the shared ytmView session
// must go through this module rather than constructing its own.

function resolveApiPolyfillPreloadPath(): string {
  // Built as its own Vite preload target (see forge.config.ts) since it must be a real file on disk
  // for session.registerPreloadScript(), not something bundled into this file.
  return path.join(__dirname, "chrome-extension-api-polyfill", "preload.js");
}

export function ensureChromeExtensionsSupport(ytmView: BrowserView, mainWindow: BrowserWindow): ElectronChromeExtensions {
  const session = ytmView.webContents.session;

  const existing = ElectronChromeExtensions.fromSession(session);
  if (existing) return existing;

  const chromeExtensions = new ElectronChromeExtensions({
    session,
    license: "GPL-3.0",
    // electron-chrome-extensions can't locate its own preload script automatically in our bundled +
    // asar-packaged build (see viteconfig/main.ts for why), so this points it at the copy we place
    // next to this file's own compiled output at build time.
    modulePath: __dirname
  });

  chromeExtensions.addTab(ytmView.webContents, mainWindow);

  // Required for <browser-action-list> (used by the main window's titlebar) to display extension
  // icons, which it fetches through this protocol.
  ElectronChromeExtensions.handleCRXProtocol(session);

  session.registerPreloadScript({
    id: "chrome-extension-api-polyfill",
    type: "service-worker",
    filePath: resolveApiPolyfillPreloadPath()
  });
  session.registerPreloadScript({
    id: "chrome-extension-api-polyfill-frame",
    type: "frame",
    filePath: resolveApiPolyfillPreloadPath()
  });

  return chromeExtensions;
}
