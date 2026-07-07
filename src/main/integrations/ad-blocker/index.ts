import { app, BrowserView, BrowserWindow, WebContents, webContents } from "electron";
import log from "electron-log";
import { ElectronChromeExtensions } from "electron-chrome-extensions";

import IIntegration from "../integration";
import MemoryStore from "../../memory-store";
import { MemoryStoreSchema } from "~shared/store/schema";
import { ensureUBlockOriginExtension } from "./extension-provisioner";

export default class AdBlocker implements IIntegration {
  private ytmView: BrowserView | null = null;
  private mainWindow: BrowserWindow | null = null;
  private memoryStore: MemoryStore<MemoryStoreSchema> | null = null;
  private isEnabled = false;
  private loadedExtensionId: string | null = null;
  private preparePromise: Promise<string> | null = null;
  private backgroundPageWatcherAttached = false;
  private chromeExtensions: ElectronChromeExtensions | null = null;

  public provide(memoryStore: MemoryStore<MemoryStoreSchema>, ytmView: BrowserView, mainWindow: BrowserWindow): void {
    this.memoryStore = memoryStore;
    this.ytmView = ytmView;
    this.mainWindow = mainWindow;

    // The extension is loaded onto the ytmView's persistent session rather than the BrowserView
    // itself, so it stays loaded across ytmView recreation and doesn't need to be reloaded here.
    if (this.isEnabled && !this.loadedExtensionId) {
      this.enable();
    }
  }

  public async enable(): Promise<void> {
    this.isEnabled = true;
    if (!this.ytmView || this.loadedExtensionId) return;

    try {
      if (!this.preparePromise) {
        this.preparePromise = ensureUBlockOriginExtension();
      }
      const extensionPath = await this.preparePromise;

      // Electron only natively implements a subset of the extension APIs uBlock Origin needs
      // (e.g. chrome.browserAction is entirely missing, which crashes its background page on
      // startup before any filtering logic runs). electron-chrome-extensions fills in that gap.
      this.ensureChromeExtensionsSupport();

      // Deliberately not reloading ytmView here: reload() is subject to YTM's own
      // beforeunload handler (active during playback), which pops the disruptive
      // "YouTube Music is preventing navigation" dialog. The extension only takes
      // effect on the next navigation, so this setting is flagged restart-required
      // in Settings.vue instead.
      const extension = await this.ytmView.webContents.session.extensions.loadExtension(extensionPath);
      this.loadedExtensionId = extension.id;
      this.memoryStore?.set("adBlockerLoadFailed", false);
      log.info(`Ad blocker: loaded uBlock Origin (${extension.version})`);
      this.watchBackgroundPage();
    } catch (error) {
      log.error("Ad blocker: failed to load uBlock Origin", error);
      this.memoryStore?.set("adBlockerLoadFailed", true);
    } finally {
      this.preparePromise = null;
    }
  }

  private ensureChromeExtensionsSupport(): void {
    if (this.chromeExtensions || !this.ytmView) return;

    this.chromeExtensions = new ElectronChromeExtensions({
      session: this.ytmView.webContents.session,
      license: "GPL-3.0"
    });

    if (this.mainWindow) {
      this.chromeExtensions.addTab(this.ytmView.webContents, this.mainWindow);
    }
  }

  // uBlock Origin can load successfully (per Electron) while its background page still throws on
  // an unsupported chrome.* API and never finishes initializing, silently leaving it with no active
  // filters. Piping its console into our own logs is the only way to see that from outside a devtools
  // window, since Electron's own extension support gives no other feedback about background page errors.
  private watchBackgroundPage(): void {
    if (this.backgroundPageWatcherAttached) return;
    this.backgroundPageWatcherAttached = true;

    const attach = (contents: WebContents) => {
      if (contents.getType() !== "backgroundPage") return;

      log.info(`Ad blocker: uBlock Origin background page created (${contents.getURL()})`);

      // Positional (level, message) form used deliberately: the newer single-object
      // "console-message" overload varies across Electron versions, while this one is stable.
      contents.on("console-message", (_event, level, message) => {
        const logFn = level >= 3 ? log.error : level === 2 ? log.warn : log.info;
        logFn(`Ad blocker (uBlock Origin console): ${message}`);
      });

      contents.on("render-process-gone", (_event, details) => {
        log.error(`Ad blocker: uBlock Origin background page terminated (${details.reason})`);
      });
    };

    app.on("web-contents-created", (_event, contents) => attach(contents));
    for (const contents of webContents.getAllWebContents()) attach(contents);
  }

  public disable(): void {
    this.isEnabled = false;
    if (!this.ytmView || !this.loadedExtensionId) return;

    try {
      this.ytmView.webContents.session.extensions.removeExtension(this.loadedExtensionId);
    } catch (error) {
      log.error("Ad blocker: failed to remove uBlock Origin", error);
    }

    this.loadedExtensionId = null;
    this.memoryStore?.set("adBlockerLoadFailed", false);
  }

  public getYTMScripts(): { name: string; script: string }[] {
    return [];
  }
}
