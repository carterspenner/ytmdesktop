import { BrowserView } from "electron";
import log from "electron-log";

import IIntegration from "../integration";
import MemoryStore from "../../memory-store";
import { MemoryStoreSchema } from "~shared/store/schema";
import { ensureUBlockOriginExtension } from "./extension-provisioner";

export default class AdBlocker implements IIntegration {
  private ytmView: BrowserView | null = null;
  private memoryStore: MemoryStore<MemoryStoreSchema> | null = null;
  private isEnabled = false;
  private loadedExtensionId: string | null = null;
  private preparePromise: Promise<string> | null = null;

  public provide(memoryStore: MemoryStore<MemoryStoreSchema>, ytmView: BrowserView): void {
    this.memoryStore = memoryStore;
    this.ytmView = ytmView;

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

      const wasAlreadyNavigated = this.ytmView.webContents.getURL().length > 0;
      const extension = await this.ytmView.webContents.session.extensions.loadExtension(extensionPath);
      this.loadedExtensionId = extension.id;
      this.memoryStore?.set("adBlockerLoadFailed", false);
      log.info(`Ad blocker: loaded uBlock Origin (${extension.version})`);

      if (wasAlreadyNavigated) {
        this.ytmView.webContents.reload();
      }
    } catch (error) {
      log.error("Ad blocker: failed to load uBlock Origin", error);
      this.memoryStore?.set("adBlockerLoadFailed", true);
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
      log.error("Ad blocker: failed to remove uBlock Origin", error);
    }

    this.loadedExtensionId = null;
    this.memoryStore?.set("adBlockerLoadFailed", false);

    if (this.ytmView.webContents.getURL().length > 0) {
      this.ytmView.webContents.reload();
    }
  }

  public getYTMScripts(): { name: string; script: string }[] {
    return [];
  }
}
