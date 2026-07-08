// See the Electron documentation for details on how to use preload scripts:
// https://www.electronjs.org/docs/latest/tutorial/process-model#preload-scripts

import { contextBridge, ipcRenderer } from "electron";
import { injectBrowserAction } from "electron-chrome-extensions/browser-action";
import { WindowsEventArguments } from "~shared/types";
import { MemoryStoreSchema } from "~shared/store/schema";
import MemoryStore from "../../store-ipc/memory-store";

const memoryStore = new MemoryStore<MemoryStoreSchema>();

// Registers the <browser-action-list>/<browser-action> custom elements used by TitleBar.vue to
// show icons (and popups) for extensions loaded onto the ytmView session (ad blocker, lyrics, etc).
injectBrowserAction();

// Must match the partition ytmView itself is created with in src/main/index.ts.
const ytmViewPartition = process.env.NODE_ENV === "development" ? "persist:ytmview-dev" : "persist:ytmview";

contextBridge.exposeInMainWorld("ytmd", {
  ytmViewPartition,
  minimizeWindow: () => ipcRenderer.send("mainWindow:minimize"),
  maximizeWindow: () => ipcRenderer.send("mainWindow:maximize"),
  restoreWindow: () => ipcRenderer.send("mainWindow:restore"),
  closeWindow: () => ipcRenderer.send("mainWindow:close"),
  handleWindowEvents: (callback: (event: Electron.IpcRendererEvent, args: WindowsEventArguments) => void) =>
    ipcRenderer.on("mainWindow:stateChanged", callback),
  requestWindowState: () => ipcRenderer.send("mainWindow:requestWindowState"),
  openSettingsWindow: () => ipcRenderer.send("settingsWindow:open"),
  switchFocus: (context: string) => ipcRenderer.send("ytmView:switchFocus", context),
  ytmViewNavigateDefault: () => ipcRenderer.send("ytmView:navigateDefault"),
  ytmViewRecreate: () => ipcRenderer.send("ytmView:recreate"),
  memoryStore: {
    set: (key: string, value: unknown) => memoryStore.set(key, value),
    get: async (key: keyof MemoryStoreSchema) => await memoryStore.get(key),
    onStateChanged: (callback: (newState: MemoryStoreSchema, oldState: MemoryStoreSchema) => void) => memoryStore.onStateChanged(callback)
  },
  restartApplicationForUpdate: () => ipcRenderer.send("app:restartApplicationForUpdate")
});
