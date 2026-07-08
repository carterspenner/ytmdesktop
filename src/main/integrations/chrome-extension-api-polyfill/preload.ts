// Preload script registered onto the ytmView session's extension contexts (background pages and
// service workers) to fill in two chrome.* APIs that neither Electron nor electron-chrome-extensions
// implement: chrome.alarms and chrome.storage.sync. Extensions that call these unconditionally at
// module scope (as Better Lyrics does with chrome.alarms.onAlarm.addListener) would otherwise crash
// before any of their own logic runs, the same way uBlock Origin crashed on chrome.browserAction.

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

declare const chrome: {
  alarms?: unknown;
  storage?: { local: unknown; sync?: unknown };
};

function installAlarmsPolyfill(): void {
  if (chrome.alarms) return;

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
  chrome.alarms = {
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
  };
}

function installStorageSyncPolyfill(): void {
  // This is a single-user desktop app with no concept of syncing across devices, so aliasing sync
  // to Electron's native chrome.storage.local implementation (rather than writing a separate no-op
  // store) is the pragmatic choice: extensions get a working, persisted store instead of a crash.
  if (chrome.storage && !chrome.storage.sync) {
    chrome.storage.sync = chrome.storage.local;
  }
}

if (typeof chrome !== "undefined") {
  installAlarmsPolyfill();
  installStorageSyncPolyfill();
}

// Keeps this file's ambient `chrome` declaration scoped locally instead of leaking into the global
// type-checking scope of every other file in the project.
export {};
