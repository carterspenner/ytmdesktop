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
// extensions that actually declare the permission, and storage.sync is its own isolated store
// rather than a raw alias to storage.local, so this can never collide with or corrupt an unrelated
// extension's own storage.local data.

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
    work().then(callback);
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
  // All sync-polyfill data lives nested under this single local storage key, rather than sharing
  // local's top-level keyspace directly - so this can't collide with or overwrite whatever the
  // extension itself stores in chrome.storage.local, regardless of what key names it happens to use.
  const NAMESPACE_KEY = "__chromeStorageSyncPolyfill__";

  function readNamespace(): Promise<Record<string, unknown>> {
    return new Promise(resolve => {
      local.get(NAMESPACE_KEY, result => resolve((result?.[NAMESPACE_KEY] as Record<string, unknown>) || {}));
    });
  }

  function writeNamespace(data: Record<string, unknown>): Promise<void> {
    return new Promise(resolve => {
      local.set({ [NAMESPACE_KEY]: data }, () => resolve());
    });
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
  const syncImpl = {
    get(keys: unknown, callback?: (items: Record<string, unknown>) => void) {
      return callbackOrPromise(callback, async () => {
        const all = await readNamespace();
        if (keys == null) return all;
        const defaults = typeof keys === "object" && !Array.isArray(keys) ? (keys as Record<string, unknown>) : {};
        const result: Record<string, unknown> = { ...defaults };
        for (const key of normalizeKeys(keys)) {
          if (key in all) result[key] = all[key];
        }
        return result;
      });
    },
    set(items: Record<string, unknown>, callback?: () => void) {
      return callbackOrPromise(callback, async () => {
        const all = await readNamespace();
        await writeNamespace({ ...all, ...items });
      });
    },
    remove(keys: string | string[], callback?: () => void) {
      return callbackOrPromise(callback, async () => {
        const all = await readNamespace();
        const next = { ...all };
        for (const key of normalizeKeys(keys)) delete next[key];
        await writeNamespace(next);
      });
    },
    clear(callback?: () => void) {
      return callbackOrPromise(callback, () => writeNamespace({}));
    }
  };

  replaceProperty(chrome.storage, "sync", syncImpl);
}

// TEMPORARY diagnostic for a report that Better Lyrics' theme CSS doesn't survive a full app
// restart even though chrome.storage.local visibly does write it out correctly (confirmed via a
// user's log). This logs what chrome.storage.local actually contains at the earliest point each
// of Better Lyrics' own execution contexts starts (its content script here, and its background
// service worker via the session-wide registration of this same file) - both run this file before
// Better Lyrics' own scripts, so this is the earliest possible observation point. Scoped to Better
// Lyrics' extension ID specifically so it doesn't add noise to every other page/frame in the
// session. Remove once the root cause is confirmed.
const BETTER_LYRICS_EXTENSION_ID = "effdbpeggelllpfkjppbokhmmiinhlmg";

// Summarizes a value's shape/size instead of its content - critical for values that might not
// actually be a plain string (e.g. a Uint8Array that lost its type across a serialization
// boundary and came back as a plain object with one entry per byte), which would otherwise blow
// this diagnostic's single log line up to the value's full size instead of a few bytes.
function summarizeValue(value: unknown): unknown {
  if (typeof value === "string") return `string(${value.length})`;
  if (Array.isArray(value)) return `array(${value.length})`;
  if (value !== null && typeof value === "object") return `object(${Object.keys(value).length} keys)`;
  return value;
}

function logStorageLocalDiagnostic(): void {
  if (chrome.runtime?.id !== BETTER_LYRICS_EXTENSION_ID) return;
  try {
    chrome.storage?.local.get(null, (all: Record<string, unknown>) => {
      const summary = Object.fromEntries(Object.entries(all || {}).map(([key, value]) => [key, summarizeValue(value)]));
      const context = typeof location !== "undefined" ? location.href : "service-worker";
      console.log(`[ytmd-diag] chrome.storage.local at startup (context=${context}):`, JSON.stringify(summary));
    });
  } catch (error) {
    console.error("[ytmd-diag] failed to read chrome.storage.local", error);
  }
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
  try {
    logStorageLocalDiagnostic();
  } catch (error) {
    console.error("[ytmd-diag] failed to run chrome.storage.local diagnostic", error);
  }
}

// Keeps this file's ambient `chrome` declaration scoped locally instead of leaking into the global
// type-checking scope of every other file in the project.
export {};
