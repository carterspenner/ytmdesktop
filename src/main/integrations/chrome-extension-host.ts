import { BrowserView, BrowserWindow, Session } from "electron";
import log from "electron-log";
import fs from "fs/promises";
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

// electron-chrome-extensions has no concept of a "tab" of its own - chrome.tabs.create() (used by
// e.g. uBlock Origin's popup "Dashboard"/"Logger" links, and chrome.runtime.openOptionsPage()) is a
// host hook it expects the app to implement; without it, ExtensionStore.createTab() throws
// "createTab is not implemented", which from the caller's side just looks like nothing happened.
// This app has no tabbed-browser UI to open a "tab" in, so each request just opens a plain,
// independent window for the requested extension page (dashboard, options, etc).
function createExtensionTab(session: Session, details: { url?: string }): Promise<[Electron.WebContents, Electron.BaseWindow]> {
  const win = new BrowserWindow({
    width: 1000,
    height: 700,
    webPreferences: {
      session,
      sandbox: true,
      contextIsolation: true
    }
  });

  if (details.url) {
    win.loadURL(details.url);
  }

  return Promise.resolve([win.webContents, win]);
}

export function ensureChromeExtensionsSupport(session: Session): ElectronChromeExtensions {
  const existing = ElectronChromeExtensions.fromSession(session);
  if (existing) return existing;

  const chromeExtensions = new ElectronChromeExtensions({
    session,
    license: "GPL-3.0",
    // electron-chrome-extensions can't locate its own preload script automatically in our bundled +
    // asar-packaged build (see viteconfig/main.ts for why), so this points it at the copy we place
    // next to this file's own compiled output at build time.
    modulePath: __dirname,
    createTab: details => createExtensionTab(session, details)
  });

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

// Registers ytmView as a tracked tab so extension APIs like chrome.tabs and the titlebar's
// <browser-action-list> can address it. Split out from ensureChromeExtensionsSupport() so the
// latter can be called as soon as the ytmView session exists (via session.fromPartition(), well
// before ytmView itself is constructed) - the titlebar's first 'crx-msg-remote' IPC call otherwise
// races ahead of ytmView's creation and is never retried, leaving the toolbar icon permanently
// blank for that session. addTab() itself is idempotent, so calling this repeatedly is harmless.
export function addYtmViewTab(ytmView: BrowserView, mainWindow: BrowserWindow): void {
  const chromeExtensions = ensureChromeExtensionsSupport(ytmView.webContents.session);
  chromeExtensions.addTab(ytmView.webContents, mainWindow);
}

// Chrome (and Electron's extension loader) reject any file or directory anywhere in an extension's
// package whose name starts with "_" - that prefix is reserved for system use (e.g. _locales) - so
// this can't start with one, unlike files bundled inside our own app.
const CONTENT_SCRIPT_POLYFILL_FILENAME = "ytmd-chrome-api-polyfill.js";
// Previous name, which violated the rule above - Electron's loader was rejecting every extension
// this had ever been injected into ("Filenames starting with '_' are reserved for use by the
// system"). Cleaned up below for anyone who already has it sitting in a cached extension directory
// from an earlier run, since the loader scans the whole tree, not just what manifest.json references.
const LEGACY_CONTENT_SCRIPT_POLYFILL_FILENAME = "__ytmd_chrome_api_polyfill__.js";

interface ExtensionManifest {
  content_scripts?: { js?: string[] }[];
}

// The session-wide preload registered by ensureChromeExtensionsSupport() only reaches background
// pages and service workers - content scripts run in their own isolated world within the host page
// (e.g. music.youtube.com), which a session-registered preload script never touches. Better Lyrics
// needs a working chrome.storage.sync from its content script specifically, so the same polyfill
// script is instead injected directly into the extension's own manifest as an additional content
// script, prepended so it runs before the extension's own, in the same isolated world.
//
// extensionDir is a directory we fully control (downloaded and unpacked by extension-provisioner.ts
// into our own userData cache), so patching it here is safe and has no effect on the upstream
// source. Best-effort: any failure here just means content scripts don't get the polyfill, not that
// the extension fails to load at all.
export async function injectApiPolyfillContentScript(extensionDir: string): Promise<void> {
  const manifestPath = path.join(extensionDir, "manifest.json");

  let manifest: ExtensionManifest;
  try {
    manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as ExtensionManifest;
  } catch (error) {
    log.warn("chrome-extension-host: could not read manifest.json to inject content-script polyfill", error);
    return;
  }

  const contentScripts = manifest.content_scripts;
  if (!Array.isArray(contentScripts) || contentScripts.length === 0) return;

  let manifestChanged = false;
  for (const entry of contentScripts) {
    if (!Array.isArray(entry.js)) continue;

    const withoutLegacy = entry.js.filter(name => name !== LEGACY_CONTENT_SCRIPT_POLYFILL_FILENAME);
    if (withoutLegacy.length !== entry.js.length) {
      entry.js = withoutLegacy;
      manifestChanged = true;
    }

    if (entry.js[0] !== CONTENT_SCRIPT_POLYFILL_FILENAME) {
      entry.js.unshift(CONTENT_SCRIPT_POLYFILL_FILENAME);
      manifestChanged = true;
    }
  }

  // Best-effort: leaving the stale file behind would still get this extension rejected by the
  // loader even after manifest.json stops referencing it, since it scans the whole directory tree.
  await fs.rm(path.join(extensionDir, LEGACY_CONTENT_SCRIPT_POLYFILL_FILENAME), { force: true }).catch((): undefined => undefined);

  try {
    // Always re-copy, even when the manifest already referenced this filename from a previous
    // run and doesn't need writing again: the file's own contents can change between app
    // versions (bug fixes to the polyfill itself) even though its filename doesn't, and
    // skipping the copy in that case would silently leave a stale, possibly-buggy copy in an
    // extension's cache directory indefinitely.
    await fs.copyFile(resolveApiPolyfillPreloadPath(), path.join(extensionDir, CONTENT_SCRIPT_POLYFILL_FILENAME));
    if (manifestChanged) {
      await fs.writeFile(manifestPath, JSON.stringify(manifest), "utf8");
    }
  } catch (error) {
    log.warn("chrome-extension-host: failed to inject content-script polyfill", error);
  }
}
