import { app, BrowserView, BrowserWindow, WebContents, webContents } from "electron";
import log from "electron-log";

import IIntegration from "../integration";
import MemoryStore from "../../memory-store";
import { MemoryStoreSchema } from "~shared/store/schema";
import { ensureUBlockOriginExtension } from "./extension-provisioner";
import { addYtmViewTab, injectApiPolyfillContentScript } from "../chrome-extension-host";

export default class AdBlocker implements IIntegration {
  private ytmView: BrowserView | null = null;
  private mainWindow: BrowserWindow | null = null;
  private memoryStore: MemoryStore<MemoryStoreSchema> | null = null;
  private isEnabled = false;
  private loadedExtensionId: string | null = null;
  private preparePromise: Promise<string> | null = null;
  private backgroundPageWatcherAttached = false;

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

      addYtmViewTab(this.ytmView, this.mainWindow);
      await injectApiPolyfillContentScript(extensionPath);

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

  // uBlock Origin's background page normally runs invisibly; the only failure mode worth
  // surfacing outside a devtools window is its render process dying outright.
  private watchBackgroundPage(): void {
    if (this.backgroundPageWatcherAttached) return;
    this.backgroundPageWatcherAttached = true;

    const attach = (contents: WebContents) => {
      if (contents.getType() !== "backgroundPage") return;

      contents.on("render-process-gone", (_event, details) => {
        log.error(`Ad blocker: uBlock Origin background page terminated (${details.reason})`);
      });
    };

    app.on("web-contents-created", (_event, contents) => attach(contents));
    for (const contents of webContents.getAllWebContents()) attach(contents);
  }

  // Opens uBlock Origin's own background page devtools, so its actual console output (filter list
  // load failures, webRequest errors, etc.) is inspectable - useful for diagnosing ad-blocking
  // issues that don't throw anywhere in *our* code, since uBlock's background page otherwise runs
  // completely invisibly with no way to see what it's doing.
  public openBackgroundPageDevTools(): void {
    if (!this.loadedExtensionId) return;

    const backgroundPageUrl = `chrome-extension://${this.loadedExtensionId}/`;
    const backgroundPage = webContents
      .getAllWebContents()
      .find(contents => contents.getType() === "backgroundPage" && contents.getURL().startsWith(backgroundPageUrl));

    backgroundPage?.openDevTools({ mode: "detach" });
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
