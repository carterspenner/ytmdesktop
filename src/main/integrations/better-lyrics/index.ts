import { BrowserView, BrowserWindow } from "electron";
import log from "electron-log";

import IIntegration from "../integration";
import MemoryStore from "../../memory-store";
import { MemoryStoreSchema } from "~shared/store/schema";
import { ensureBetterLyricsExtension } from "./extension-provisioner";
import { addYtmViewTab, injectApiPolyfillContentScript } from "../chrome-extension-host";

export default class BetterLyrics implements IIntegration {
  private ytmView: BrowserView | null = null;
  private mainWindow: BrowserWindow | null = null;
  private memoryStore: MemoryStore<MemoryStoreSchema> | null = null;
  private isEnabled = false;
  private loadedExtensionId: string | null = null;
  private preparePromise: Promise<string> | null = null;

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
        this.preparePromise = ensureBetterLyricsExtension();
      }
      const extensionPath = await this.preparePromise;

      addYtmViewTab(this.ytmView, this.mainWindow);
      await injectApiPolyfillContentScript(extensionPath);

      // Deliberately not reloading ytmView here, for the same reason as the ad blocker: reload()
      // triggers YTM's own beforeunload handler and this app's "prevent navigation" dialog. The
      // extension only takes effect on the next navigation, so this setting is flagged
      // restart-required in Settings.vue instead.
      const extension = await this.ytmView.webContents.session.extensions.loadExtension(extensionPath);
      this.loadedExtensionId = extension.id;
      this.memoryStore?.set("betterLyricsLoadFailed", false);
      log.info(`Better Lyrics: loaded (${extension.version})`);
    } catch (error) {
      log.error("Better Lyrics: failed to load", error);
      this.memoryStore?.set("betterLyricsLoadFailed", true);
    } finally {
      this.preparePromise = null;
    }
  }

  public disable(): void {
    this.isEnabled = false;
    if (!this.ytmView || !this.loadedExtensionId) return;

    try {
      this.ytmView.webContents.session.extensions.removeExtension(this.loadedExtensionId);
    } catch (error) {
      log.error("Better Lyrics: failed to remove", error);
    }

    this.loadedExtensionId = null;
    this.memoryStore?.set("betterLyricsLoadFailed", false);
  }

  public getYTMScripts(): { name: string; script: string }[] {
    return [];
  }
}
