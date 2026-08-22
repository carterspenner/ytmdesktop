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

      // Electron bug (electron/electron#41613, fixed in 42+ only - this app currently targets an
      // earlier Electron): an extension's Manifest V3 service worker starts correctly the very
      // first time it's ever loaded, but silently fails to auto-start on every subsequent app
      // launch, because Electron mismanages the Chromium preference that's supposed to track
      // whether the worker has started before. Whatever startup logic lives in Better Lyrics' own
      // background service worker (confirmed, via a real device log, to include reapplying a
      // previously saved theme - its chrome.storage.local data is intact after a restart, but
      // nothing ever reads it without this) then never runs. Explicitly starting the worker here
      // works around it until this app can move to Electron 42+.
      //
      // Deliberately not started immediately: a follow-up real device log showed this racing
      // Better Lyrics' own content script for its first chrome.storage.local access during the
      // same page load, and losing - Chromium's storage quota enforcer takes an exclusive LOCK
      // file on the extension's storage database while computing usage, and the loser's read comes
      // back completely empty instead of waiting. Deferring until the current ytmView page load
      // finishes (content scripts run at document_start, well before that) gives the content
      // script's own early reads a full, uncontested run first. Falls back to a fixed delay if no
      // load is in flight (e.g. this integration gets enabled mid-session, well after ytmView's
      // page already finished loading, so 'did-finish-load' would never fire again).
      const startServiceWorker = (): void => {
        this.ytmView?.webContents.session.serviceWorkers.startWorkerForScope(`chrome-extension://${extension.id}/`).catch(error => {
          log.warn("Better Lyrics: failed to explicitly start extension service worker", error);
        });
      };
      let serviceWorkerStarted = false;
      const startServiceWorkerOnce = (): void => {
        if (serviceWorkerStarted) return;
        serviceWorkerStarted = true;
        startServiceWorker();
      };
      this.ytmView.webContents.once("did-finish-load", startServiceWorkerOnce);
      setTimeout(startServiceWorkerOnce, 5000);
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
