// Preload script registered onto the ytmView session's extension contexts (background pages and
// service workers) to fill in two chrome.* APIs that neither Electron nor electron-chrome-extensions
// implement: chrome.alarms and chrome.storage.sync. Extensions that call these unconditionally at
// module scope (as Better Lyrics does with chrome.alarms.onAlarm.addListener) would otherwise crash
// before any of their own logic runs, the same way uBlock Origin crashed on chrome.browserAction.
//
// This preload applies session-wide, to every extension loaded onto it (uBlock Origin included),
// not just the one that happens to need it - so both polyfills below are written defensively:
// alarms is only installed for extensions that actually declare the permission, and storage.sync
// is its own isolated store rather than a raw alias to storage.local, so this can never collide
// with or corrupt an unrelated extension's own storage.local data.

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

declare const chrome: {
  alarms?: unknown;
  storage?: { local: StorageArea; sync?: StorageArea };
  runtime?: { getManifest?: () => { permissions?: string[] } };
};

function hasPermission(name: string): boolean {
  try {
    return !!chrome.runtime?.getManifest?.().permissions?.includes(name);
  } catch {
    return false;
  }
}

// Electron defines chrome.alarms and chrome.storage.sync as non-writable (but configurable)
// properties - a plain `chrome.alarms = ...` assignment throws "Cannot assign to read only
// property" in this preload's strict-mode module scope, which aborts the entire preload script
// before anything else in it runs. redefineProperty() replaces the property descriptor instead,
// which works on non-writable properties as long as they're still configurable.
function redefineProperty(target: object, key: string, value: unknown): void {
  Object.defineProperty(target, key, { value, writable: true, configurable: true, enumerable: true });
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
  redefineProperty(chrome, "alarms", {
    create,
    get(name: string, callback?: (alarm?: Alarm) => void) {
      const timer = timers.get(name);
      callback?.(timer ? { name, scheduledTime: Date.now(), periodInMinutes: timer.periodInMinutes } : undefined);
    },
    getAll(callback?: (alarms: Alarm[]) => void) {
      callback?.(Array.from(timers.entries()).map(([name, timer]) => ({ name, scheduledTime: Date.now(), periodInMinutes: timer.periodInMinutes })));
    },
    clear(name: string, callback?: (wasCleared: boolean) => void) {
      const timer = timers.get(name);
      if (timer) {
        clearTimeout(timer.timeoutId);
        timers.delete(name);
      }
      callback?.(!!timer);
    },
    clearAll(callback?: (wasCleared: boolean) => void) {
      for (const timer of timers.values()) clearTimeout(timer.timeoutId);
      const hadAny = timers.size > 0;
      timers.clear();
      callback?.(hadAny);
    },
    onAlarm: {
      addListener: (listener: (alarm: Alarm) => void) => listeners.add(listener),
      removeListener: (listener: (alarm: Alarm) => void) => listeners.delete(listener),
      hasListener: (listener: (alarm: Alarm) => void) => listeners.has(listener)
    }
  });
}

function installStorageSyncPolyfill(): void {
  // Electron already defines chrome.storage.sync as a stub whose methods exist but always error
  // with "sync is not available in this instance of Chrome" via chrome.runtime.lastError - it's
  // truthy, not undefined, so this can't be guarded on presence and must always be replaced.
  if (!chrome.storage) return;

  const local = chrome.storage.local;
  // All sync-polyfill data lives nested under this single local storage key, rather than sharing
  // local's top-level keyspace directly - so this can't collide with or overwrite whatever the
  // extension itself stores in chrome.storage.local, regardless of what key names it happens to use.
  const NAMESPACE_KEY = "__chromeStorageSyncPolyfill__";

  function readNamespace(callback: (data: Record<string, unknown>) => void): void {
    local.get(NAMESPACE_KEY, result => callback((result?.[NAMESPACE_KEY] as Record<string, unknown>) || {}));
  }

  function writeNamespace(data: Record<string, unknown>, callback?: () => void): void {
    local.set({ [NAMESPACE_KEY]: data }, callback);
  }

  function normalizeKeys(keys: unknown): string[] {
    if (keys == null) return [];
    if (typeof keys === "string") return [keys];
    if (Array.isArray(keys)) return keys;
    return Object.keys(keys as Record<string, unknown>);
  }

  // This is a single-user desktop app with no concept of syncing across devices, so this store is
  // just chrome.storage.local's persistence under the hood - extensions get a working, persisted
  // store instead of a crash, they just don't get real multi-device sync (which isn't meaningful here).
  redefineProperty(chrome.storage, "sync", {
    get(keys: unknown, callback: (items: Record<string, unknown>) => void) {
      readNamespace(all => {
        if (keys == null) return callback(all);
        const defaults = typeof keys === "object" && !Array.isArray(keys) ? (keys as Record<string, unknown>) : {};
        const result: Record<string, unknown> = { ...defaults };
        for (const key of normalizeKeys(keys)) {
          if (key in all) result[key] = all[key];
        }
        callback(result);
      });
    },
    set(items: Record<string, unknown>, callback?: () => void) {
      readNamespace(all => writeNamespace({ ...all, ...items }, callback));
    },
    remove(keys: string | string[], callback?: () => void) {
      readNamespace(all => {
        const next = { ...all };
        for (const key of normalizeKeys(keys)) delete next[key];
        writeNamespace(next, callback);
      });
    },
    clear(callback?: () => void) {
      writeNamespace({}, callback);
    }
  });
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
