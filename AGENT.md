# YTM Desktop - Chrome Extension Integration Work

## Project Overview

YTM Desktop is an Electron 42.7.0 app that wraps YouTube Music and supports Chrome extensions via `electron-chrome-extensions` (v4.9.0). Two extensions are loaded: uBlock Origin and Better Lyrics.

## Architecture: How Chrome Extensions Work in This App

### Extension Loading
- `src/main/integrations/chrome-extension-host.ts` manages extension loading
- Extensions are fetched from GitHub releases and unpacked locally
- `electron-chrome-extensions` (the npm package) provides the Chrome extension API surface

### Three Worlds Where Extension Code Runs

1. **Extension pages** (popup, options, background/service worker):
   - Run in `chrome-extension://` URLs
   - `electron-chrome-extensions`' own preload (`node_modules/electron-chrome-extensions/dist/chrome-extension-api.preload.js`) handles API injection
   - That preload sets `sync: local` (a direct alias, line 457) for extension pages via `contextBridge.executeInMainWorld` (line 579-585)
   - The preload only runs when `process.type === "service-worker" || location.href.startsWith("chrome-extension://")` (line 594)
   - After injecting APIs, it calls `Object.freeze(chrome)` (line 570)

2. **Content scripts** (run in an isolated world on the host page, e.g., music.youtube.com):
   - The `electron-chrome-extensions` preload does NOT run here
   - Content scripts get Electron's broken `chrome.storage.sync` stub that always errors with "sync is not available in this instance of Chrome"
   - Our polyfill (`src/main/integrations/chrome-extension-api-polyfill/preload.ts`) fills the gap here

3. **The host page itself** (YouTube Music's own JavaScript):
   - Runs in the main world
   - Has no access to chrome.* APIs
   - Communicates with the preload via `webFrame.executeJavaScript()`

### Our Polyfill: `chrome-extension-api-polyfill/preload.ts`

This file polyfills two APIs:
- `chrome.alarms` - for extensions declaring the "alarms" permission (uBlock Origin needs this)
- `chrome.storage.sync` - redirects to `chrome.storage.local` (matching what `electron-chrome-extensions` does for extension pages)

The polyfill is registered two ways (see `chrome-extension-host.ts` lines 65-74):
- As a session-wide preload for background pages/service workers
- Copied into each extension's unpacked directory and prepended to its manifest's `content_scripts`

**Key constraint**: `Object.defineProperty` is used to replace `chrome.alarms` and `chrome.storage.sync` because Electron defines them as non-writable properties. If the property is also non-configurable, the replacement silently fails (a Proxy-based fallback was tried earlier but caused Chromium renderer crashes via SIGTRAP).

### The Loading Screen Flow

The loading screen (`src/renderer/components/YTMViewLoading.vue`) displays until `ytmView:loaded` IPC fires.

**The IPC is sent from**: `src/renderer/ytmview/preload.ts` line 670 (the very last line of the `window.addEventListener("load", ...)` handler)

**The IPC is received at**: `src/main/index.ts` line 1667-1691, which sets `memoryStore.set("ytmViewLoading", false)` and adds the BrowserView to the main window.

**A 30-second timeout** at `src/main/index.ts` line 1279-1281 sets `ytmViewLoadTimedout` which shows red warning text, but does NOT dismiss the loading screen.

### What Blocks `ytmView:loaded` From Firing

The `window load` handler in `ytmview/preload.ts` does these things sequentially before sending `ytmView:loaded`:

1. **First polling loop** (line ~227): Waits for `window.__YTMD_HOOK__` to exist via `webFrame.executeJavaScript`. The hook is set up by an IIFE at the top of the file that patches into YouTube Music's Polymer framework.

2. **Material Symbols font load** (line ~260): Creates a `<link>` element for Google Fonts material symbols. Sets `materialSymbolsLoaded = true` on load/error.

3. **Second polling loop** (line ~271): Waits for BOTH `materialSymbolsLoaded === true` AND `document.querySelector("ytmusic-app-layout>ytmusic-player-bar").playerApi.isReady() === true`.

4. **Setup functions** (line ~301): `createStyleSheet()`, `createNavigationMenuArrows()`, `createKeyboardNavigation()`, `createAdditionalPlayerBarControls()`, `hideChromecastButton()`, `hookPlayerApiEvents()`, `overrideHistoryButtonDisplay()`.

5. **Integration scripts and state restoration** (line ~313): Fetches integration scripts via IPC, reads stored state, handles "continue where you left off" logic, sets up volume slider. All of this accesses DOM elements like `ytmusic-player-bar` and `#volume-slider` directly.

6. **Event handler registration** (line ~372): Registers `remoteControl:execute`, `ytmView:getPlaylists`, `ytmView:executeScript`, `ytmView:refitPopups` IPC handlers.

7. **`ipcRenderer.send("ytmView:loaded")`** (line 670): The final line.

**Any uncaught exception or permanently-hanging await in steps 1-6 prevents step 7 from executing.**

## Changes Made (Branch: `claude/chrome-extension-embed-wjiuov`)

### Commit 1: `17e242c` - Fix Better Lyrics theme not loading by adding chrome.storage.onChanged support
- Added `onChanged` listener tracking to the sync polyfill
- Used a namespace-based approach (`__chromeStorageSyncPolyfill__` prefix)
- This was later superseded by commit 2

### Commit 2: `fc1ecea` - Fix sync polyfill to use local storage directly instead of namespace key
- **Root cause**: Extension popup pages wrote to `chrome.storage.local.customCSS` (via the library's `sync: local` alias in the main world), but content scripts read from `chrome.storage.local.__chromeStorageSyncPolyfill__.customCSS` (via our namespace-based polyfill). Different keys = theme data invisible to content script after reboot.
- **Fix**: Removed the `__chromeStorageSyncPolyfill__` namespace entirely. Made `chrome.storage.sync` a direct passthrough to `chrome.storage.local` (matching what `electron-chrome-extensions` already does for extension pages). Kept synthetic `onChanged` events with `areaName: "sync"` for extensions that branch on area name.

### Commit 3: `9251075` - Fix loading screen hang by adding timeouts and error handling to preload
- Added 30-second timeouts to both polling loops
- Added try/catch around `webFrame.executeJavaScript` calls
- Changed `playerApi.isReady()` access to null-safe: `el && el.playerApi && el.playerApi.isReady()`
- Added `onerror` handler on material symbols font link
- Wrapped setup functions (step 4 above) in try/catch

### Commit 4: `90c2b24` - Wrap post-timeout initialization in try/catch to guarantee ytmView:loaded fires
- **Root cause of continued hang**: The code in step 5 above (lines 313-370) accesses DOM elements that don't exist when the timeout fires (because YouTube Music didn't fully initialize). Null-access crashes abort the async handler before `ytmView:loaded`.
- **Fix**: Wrapped that entire section in try/catch.

### What's Still Broken
The loading screen STILL hangs on Arch Linux despite all the above fixes. This means the issue is likely NOT in the `window load` handler's sequential steps, or there's something even earlier preventing the handler from running at all.

## Hypotheses for the Remaining Hang (Not Yet Investigated)

1. **The `window load` event never fires**: If YouTube Music's page never finishes loading (e.g., a resource hangs indefinitely), the `load` event won't fire and none of the code in the handler runs. Check if `DOMContentLoaded` fires but `load` doesn't.

2. **The IIFE at the top of preload.ts throws or hangs**: The immediately-invoked code at lines 1-217 (the Polymer hook setup) runs before the `load` event listener is even registered. If it crashes, the listener might never get added. This code does `webFrame.executeJavaScript` synchronously and patches `Object.defineProperty` on `window` — if YouTube Music changed its Polymer initialization, this could fail.

3. **The `ytmView` BrowserView itself isn't loading the page**: Check `src/main/index.ts` for how `ytmView` is created and what URL it loads. If the URL never loads (network issue, certificate issue on Arch), the `load` event never fires.

4. **A different preload script crashes first**: The ytmView has multiple preloads (the extension polyfill, the extension API preload, and the ytmview preload itself). If an earlier preload crashes, Electron may skip subsequent ones.

5. **Electron/Chromium version incompatibility on Arch**: Arch uses rolling releases and may have system libraries (especially GPU/graphics related) that conflict with Electron 42.7.0's bundled Chromium. GPU acceleration issues can cause BrowserViews to never paint or load.

6. **The `webFrame.executeJavaScript` calls in the IIFE hang**: The top-of-file IIFE calls `webFrame.executeJavaScript` to set up the Polymer hook. If the main world JavaScript context isn't ready, this could hang forever, and since it's awaited at the top level before the `load` listener is registered, everything blocks.

## Debugging Tips

### Useful Log Locations
- Electron's console output should show `[ytmView preload]` prefixed warnings/errors from our new logging
- `[chrome-extension-api-polyfill]` prefixed messages come from the polyfill
- Electron's `--enable-logging` flag helps capture renderer process output

### How to Verify Which Step Hangs
Add `console.log` breadcrumbs at each stage of the `window load` handler:
```typescript
console.log("[ytmView preload] load event fired");
// ... after first poll
console.log("[ytmView preload] __YTMD_HOOK__ ready (or timed out)");
// ... after second poll
console.log("[ytmView preload] playerApi ready (or timed out)");
// ... after setup
console.log("[ytmView preload] setup complete");
// ... after integration scripts
console.log("[ytmView preload] initialization complete, sending ytmView:loaded");
```

If "load event fired" never appears, the problem is before the handler (IIFE crash, page not loading, preload abort). If it appears but later messages don't, the problem is in that specific step.

### How to Check if the Page Even Loads
In `src/main/index.ts`, the ytmView's `webContents` has events like `did-finish-load`, `did-fail-load`, `did-start-loading`. Logging these would reveal if the page itself is the problem.

### Key Files to Read
- `src/renderer/ytmview/preload.ts` - the preload that gates `ytmView:loaded`
- `src/main/index.ts` - main process, creates ytmView, handles `ytmView:loaded` IPC
- `src/main/integrations/chrome-extension-host.ts` - extension loading and preload registration
- `src/main/integrations/chrome-extension-api-polyfill/preload.ts` - our chrome.* polyfill
- `node_modules/electron-chrome-extensions/dist/chrome-extension-api.preload.js` - the library's preload
- `src/renderer/components/YTMViewLoading.vue` - the loading screen component

### Better Lyrics Specifics
- Source repo: `github.com/better-lyrics/better-lyrics`
- `src/modules/ui/styleInjector.ts`: `subscribeToCustomStyles()` listens to `chrome.storage.onChanged` checking `(area === "sync" || area === "local") && changes.customCSS`
- `src/core/storage.ts`: `getSyncStorage` = `chrome.storage.sync.get(keys)`, `setStorage` = `chrome.storage.sync.set(items)`
- The extension popup shows blank for ~30 seconds before content appears - this is a Better Lyrics issue (the popup BrowserWindow has `backgroundColor: "#ffffff"` hardcoded in `electron-chrome-extensions` at `node_modules/electron-chrome-extensions/dist/cjs/index.js` line 184)

### PR History
- PR #19 (merged): Initial chrome extension embedding support
- PR #20 (merged): First sync polyfill fix (had the namespace bug)
- PR #22 (open): Loading screen hang fix + sync polyfill passthrough fix
