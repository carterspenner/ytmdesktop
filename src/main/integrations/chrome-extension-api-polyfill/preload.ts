// Fills in two chrome.* APIs that neither Electron nor electron-chrome-extensions implement:
// chrome.alarms and chrome.storage.sync. Extensions that call these unconditionally at module
// scope (as Better Lyrics does with chrome.alarms.onAlarm.addListener) would otherwise crash before
// any of their own logic runs, the same way uBlock Origin crashed on chrome.browserAction.
//
// This same compiled file is used two ways, since neither alone reaches every place a `chrome`
// object gets created for an extension:
//  - registered session-wide (see chrome-extension-host.ts) as a preload script for background
//    pages/service workers, applying to every extension loaded onto that session (uBlock Origin
//    included), not just the one that happens to need it
//  - copied into each extension's own unpacked directory and prepended to its manifest's
//    content_scripts, since content scripts run in an isolated world that a session-wide preload
//    script never reaches, and Better Lyrics needs chrome.storage.sync there specifically
//
// Both polyfills below are written defensively as a result: alarms is only installed for
// extensions that actually declare the permission, and storage.sync is a passthrough to
// storage.local (matching what electron-chrome-extensions already does for extension pages)
// with the addition of firing onChanged events with areaName "sync".

interface AlarmInfo {
  when?: number;
  delayInMinutes?: number;
  periodInMinutes?: number;
}

interface Alarm {
  name: string;
  scheduledTime: number;
  periodInMinutes?: number;
}

type StorageArea = {
  get(keys: unknown, callback: (items: Record<string, unknown>) => void): void;
  set(items: Record<string, unknown>, callback?: () => void): void;
  remove(keys: string | string[], callback?: () => void): void;
  clear(callback?: () => void): void;
};

type StorageChange = { oldValue?: unknown; newValue?: unknown };
type StorageChanges = Record<string, StorageChange>;
type OnChangedListener = (changes: StorageChanges, areaName: string) => void;

declare const chrome: {
  alarms?: unknown;
  storage?: {
    local: StorageArea;
    sync?: StorageArea;
    onChanged?: {
      addListener(callback: OnChangedListener): void;
      removeListener(callback: OnChangedListener): void;
      hasListener?(callback: OnChangedListener): boolean;
    };
  };
  runtime?: { id?: string; getManifest?: () => { permissions?: string[] } };
};

function hasPermission(name: string): boolean {
  try {
    return !!chrome.runtime?.getManifest?.().permissions?.includes(name);
  } catch {
    return false;
  }
}

// Electron defines chrome.alarms (and, in some contexts, chrome.storage) as non-writable
// properties - a plain `chrome.alarms = ...` assignment throws "Cannot assign to read only
// property" in this preload's strict-mode module scope, which aborts the entire preload script
// before anything else in it runs.
//
// Object.defineProperty() can replace a non-writable-but-configurable property, but chrome.alarms
// has also been observed non-configurable ("Cannot redefine property: alarms"), so even that
// fails. An earlier version of this function fell back to replacing `chrome` itself (or its parent)
// with a Proxy in that case - but a real device crash dump showed Chromium's own native extension
// bindings code ("Failed to create API on Chrome object" in
// extensions/renderer/native_extension_bindings_system.cc, a message also seen accompanying crashes
// in other Chromium-based browsers) failing immediately after that Proxy was installed, followed by
// the whole renderer dying with SIGTRAP. Chromium's C++ code apparently doesn't expect `chrome` to
// become a Proxy mid-flight when it later tries to add more APIs to it.
//
// Non-configurable properties are left alone as a result: whatever depends on this polyfill (e.g.
// uBlock's periodic alarm-based filter list updates) just doesn't get it in that context, which is
// a far smaller problem than crashing the entire app.
function replaceProperty(target: object, key: string, value: unknown): void {
  try {
    Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
  } catch (error) {
    console.error(`[chrome-extension-api-polyfill] chrome.${key} is locked down in this context and could not be replaced`, error);
  }
}

// Real chrome.storage.*/chrome.alarms methods support both a trailing callback and, when it's
// omitted, a returned Promise (since Chrome 88) - extensions increasingly rely on the latter
// (e.g. `await chrome.storage.sync.get(...)`). Calling the callback parameter directly without
// checking for this crashes with "callback is not a function" the first time an extension omits
// it, which is exactly what happened to Better Lyrics here. This wraps an async implementation to
// support both calling conventions instead of assuming a callback is always given.
function callbackOrPromise<T>(callback: ((result: T) => void) | undefined, work: () => Promise<T>): Promise<T> | undefined {
  if (typeof callback === "function") {
    work().then(
      result => callback(result),
      error => console.error("[chrome-extension-api-polyfill]", error)
    );
    return undefined;
  }
  return work();
}

function installAlarmsPolyfill(): void {
  // Only extensions that actually declare wanting chrome.alarms get it. Defining it unconditionally
  // for every extension in the session risks changing another extension's own feature detection
  // (e.g. "use alarms if available, otherwise poll") in ways it was never exercised against.
  //
  // Not guarded on chrome.alarms already being present: like chrome.storage.sync, Electron defines
  // it as a stub object whose methods exist but always fail, so a truthiness check would never
  // trigger our replacement.
  if (!hasPermission("alarms")) return;

  const timers = new Map<string, { timeoutId: ReturnType<typeof setTimeout>; periodInMinutes?: number }>();
  const listeners = new Set<(alarm: Alarm) => void>();

  function fire(name: string): void {
    const timer = timers.get(name);
    if (!timer) return;

    const alarm: Alarm = { name, scheduledTime: Date.now(), periodInMinutes: timer.periodInMinutes };
    for (const listener of listeners) listener(alarm);

    if (timer.periodInMinutes) {
      timer.timeoutId = setTimeout(() => fire(name), timer.periodInMinutes * 60 * 1000);
    } else {
      timers.delete(name);
    }
  }

  function create(name: string, alarmInfo?: AlarmInfo): void {
    // create(alarmInfo) form, matching real chrome.alarms, defaults the name to "".
    if (typeof name === "object") {
      alarmInfo = name;
      name = "";
    }

    const existing = timers.get(name);
    if (existing) clearTimeout(existing.timeoutId);

    const delayMs = alarmInfo?.when ? Math.max(alarmInfo.when - Date.now(), 0) : (alarmInfo?.delayInMinutes ?? alarmInfo?.periodInMinutes ?? 0) * 60 * 1000;

    const timeoutId = setTimeout(() => fire(name), delayMs);
    timers.set(name, { timeoutId, periodInMinutes: alarmInfo?.periodInMinutes });
  }

  // Note: this is a best-effort polyfill backed by setTimeout, unlike real chrome.alarms which the
  // browser tracks independently of the extension's lifecycle and can wake a terminated service
  // worker for. If Electron ever terminates an extension's service worker between alarms, scheduled
  // alarms are lost - acceptable here since this app doesn't aggressively evict extension service
  // workers the way mobile Chrome does.
  const alarmsImpl = {
    create,
    get(name: string, callback?: (alarm?: Alarm) => void) {
      return callbackOrPromise(callback, async () => {
        const timer = timers.get(name);
        return timer ? { name, scheduledTime: Date.now(), periodInMinutes: timer.periodInMinutes } : undefined;
      });
    },
    getAll(callback?: (alarms: Alarm[]) => void) {
      return callbackOrPromise(callback, async () =>
        Array.from(timers.entries()).map(([name, timer]) => ({ name, scheduledTime: Date.now(), periodInMinutes: timer.periodInMinutes }))
      );
    },
    clear(name: string, callback?: (wasCleared: boolean) => void) {
      return callbackOrPromise(callback, async () => {
        const timer = timers.get(name);
        if (timer) {
          clearTimeout(timer.timeoutId);
          timers.delete(name);
        }
        return !!timer;
      });
    },
    clearAll(callback?: (wasCleared: boolean) => void) {
      return callbackOrPromise(callback, async () => {
        for (const timer of timers.values()) clearTimeout(timer.timeoutId);
        const hadAny = timers.size > 0;
        timers.clear();
        return hadAny;
      });
    },
    onAlarm: {
      addListener: (listener: (alarm: Alarm) => void) => listeners.add(listener),
      removeListener: (listener: (alarm: Alarm) => void) => listeners.delete(listener),
      hasListener: (listener: (alarm: Alarm) => void) => listeners.has(listener)
    }
  };

  replaceProperty(chrome, "alarms", alarmsImpl);
}

function installStorageSyncPolyfill(): void {
  // Electron already defines chrome.storage.sync as a stub whose methods exist but always error
  // with "sync is not available in this instance of Chrome" via chrome.runtime.lastError - it's
  // truthy, not undefined, so this can't be guarded on presence and must always be replaced.
  if (!chrome.storage) return;

  const local = chrome.storage.local;

  // electron-chrome-extensions' own preload sets `sync: local` (a direct alias) for extension
  // pages (popup, options, background), but that only runs in the main world of chrome-extension://
  // URLs. Content scripts (which run in an isolated world on the host page) get Electron's broken
  // stub instead. This polyfill bridges the gap by making sync a passthrough to local in every
  // context, matching what the library already does for extension pages. Using the same backing
  // store means data written by the popup (via the library's alias) is visible to the content
  // script (via this polyfill) and vice versa.
  //
  // The only addition over a raw alias is firing onChanged events with areaName "sync" after
  // writes, so extensions that distinguish storage areas in their listeners (as Better Lyrics does)
  // see the events they expect.

  function localGet(keys: unknown): Promise<Record<string, unknown>> {
    return new Promise(resolve => {
      local.get(keys as string[], result => resolve(result || {}));
    });
  }

  function localSet(items: Record<string, unknown>): Promise<void> {
    return new Promise(resolve => {
      local.set(items, () => resolve());
    });
  }

  function localRemove(keys: string[]): Promise<void> {
    return new Promise(resolve => {
      local.remove(keys, () => resolve());
    });
  }

  function localClear(): Promise<void> {
    return new Promise(resolve => {
      local.clear(() => resolve());
    });
  }

  function normalizeKeys(keys: unknown): string[] {
    if (keys == null) return [];
    if (typeof keys === "string") return [keys];
    if (Array.isArray(keys)) return keys;
    return Object.keys(keys as Record<string, unknown>);
  }

  // Track onChanged listeners so we can fire synthetic "sync" area events after writes. Native
  // onChanged events from the underlying local.set/remove/clear still fire with areaName "local"
  // (which is correct — the data IS in local storage). The synthetic "sync" events are additional,
  // for extensions whose listeners branch on `area === "sync"`.
  const syncOnChangedListeners = new Set<OnChangedListener>();
  const nativeOnChanged = chrome.storage.onChanged;
  if (nativeOnChanged) {
    const nativeAddListener = nativeOnChanged.addListener.bind(nativeOnChanged);
    const nativeRemoveListener = nativeOnChanged.removeListener.bind(nativeOnChanged);

    const wrappedListeners = new Map<OnChangedListener, OnChangedListener>();

    nativeOnChanged.addListener = (listener: OnChangedListener) => {
      syncOnChangedListeners.add(listener);
      wrappedListeners.set(listener, listener);
      nativeAddListener(listener);
    };

    nativeOnChanged.removeListener = (listener: OnChangedListener) => {
      syncOnChangedListeners.delete(listener);
      wrappedListeners.delete(listener);
      nativeRemoveListener(listener);
    };

    if (nativeOnChanged.hasListener) {
      nativeOnChanged.hasListener = (listener: OnChangedListener) => wrappedListeners.has(listener);
    }
  }

  function fireSyncChanges(changes: StorageChanges) {
    if (Object.keys(changes).length === 0) return;
    for (const listener of syncOnChangedListeners) {
      try {
        listener(changes, "sync");
      } catch (error) {
        console.error("[chrome-extension-api-polyfill] onChanged listener error", error);
      }
    }
  }

  const syncImpl = {
    get(keys: unknown, callback?: (items: Record<string, unknown>) => void) {
      return callbackOrPromise(callback, () => localGet(keys));
    },
    set(items: Record<string, unknown>, callback?: () => void) {
      return callbackOrPromise(callback, async () => {
        const old = await localGet(Object.keys(items));
        const changes: StorageChanges = {};
        for (const [key, newValue] of Object.entries(items)) {
          changes[key] = { newValue };
          if (key in old) changes[key].oldValue = old[key];
        }
        await localSet(items);
        fireSyncChanges(changes);
      });
    },
    remove(keys: string | string[], callback?: () => void) {
      return callbackOrPromise(callback, async () => {
        const keyList = normalizeKeys(keys);
        const old = await localGet(keyList);
        const changes: StorageChanges = {};
        for (const key of keyList) {
          if (key in old) {
            changes[key] = { oldValue: old[key] };
          }
        }
        await localRemove(keyList);
        fireSyncChanges(changes);
      });
    },
    clear(callback?: () => void) {
      return callbackOrPromise(callback, async () => {
        const all = await localGet(null);
        const changes: StorageChanges = {};
        for (const [key, value] of Object.entries(all)) {
          changes[key] = { oldValue: value };
        }
        await localClear();
        fireSyncChanges(changes);
      });
    }
  };

  replaceProperty(chrome.storage, "sync", syncImpl);
}

// Each installer runs in its own try/catch: an uncaught error here aborts the entire preload
// script (Electron logs "Unable to load preload script" and runs none of it), which would
// silently take the other polyfill down with it.
if (typeof chrome !== "undefined") {
  try {
    installAlarmsPolyfill();
  } catch (error) {
    console.error("[chrome-extension-api-polyfill] failed to install chrome.alarms", error);
  }
  try {
    installStorageSyncPolyfill();
  } catch (error) {
    console.error("[chrome-extension-api-polyfill] failed to install chrome.storage.sync", error);
  }
}

// Keeps this file's ambient `chrome` declaration scoped locally instead of leaking into the global
// type-checking scope of every other file in the project.
export {};
