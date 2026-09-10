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

### Commit 5: `2026-09-08` - Restore playerApi on the player-bar element (YTM moved the API to `el.inst`)

- **Root cause**: YouTube Music changed server-side between Sep 5 and Sep 8 2026 (installed binary unchanged since Jul 19; zero `isReady` errors in 6 weeks of logs before Sep 8, 454 on Sep 8): the player API moved off the player-bar element onto its Polymer instance - `el.playerApi` is now `el.inst.playerApi`. A CDP probe found `playerApi` on **zero** of 5,581 DOM elements.
- **Effect**: the `playerApi.isReady()` ready-gate never passed, so every launch sat on the loading screen for the full 30-second timeout, and post-timeout setup then threw on missing `#history-link` (a knock-on of the late path).
- **Fix**: preload defines `window.__YTMD_INSTALL_PLAYER_API_SHIM__` at top level and invokes it from both ready-poll loops (installing at preload top-level alone proved unreliable - custom element registration can land after preload code runs). The installer defines a `playerApi` alias getter on the `ytmusic-player-bar` class prototype (`return this.inst ? this.inst.playerApi : undefined`), so all ~30 existing call sites across the preload and injected scripts work unmodified. If Google restores a native definition, it shadows the shim and the shim becomes inert.
- **Verified** via CDP probes (`scripts/probe-ytm-*.py`, debug port + copied profile): `playerApi: true, isReady: true` ~2s after page load (previously never), playback works (track titles, `getVolume()` returns real values), zero `isReady` errors, no timeout warning, no post-load setup error in the fixed run.

**YTM DOM watch item (for future breakage)**: the page now renders TWO player bars - the classic `ytmusic-app-layout>ytmusic-player-bar` (still present, targeted by all our queries, but computed `display: grid` with `height: 0` - effectively retired) and a new `div>ytmusic-player-bar.top-player-bar` (Google's "mweb player bar modernization" experiment). Both expose `inst.playerApi` today and the shim covers both. If Google deletes the classic bar entirely, every `ytmusic-app-layout>ytmusic-player-bar` query in this preload and the scripts fails wholesale and ytmd will need to retarget.

## Resolution (2026-09-08): The Fixes Were Never In The Running App

**Root cause of the "still broken" hang: the installed app never contained commits 3 and 4.**

Evidence (all verified on the live system):

- The app Carter launches is the pacman package at `/usr/lib/youtube-music-desktop-app` (Electron 42.7.0), whose `resources/app.asar` was built **2026-07-19 14:39** - i.e. from the fork state at commit `2d1c354` (the Electron 42.7.0 upgrade), **before** the `claude/chrome-extension-embed-wjiuov` commits existed.
- Grepping that asar: it contains `ytmd-diag` and `__chromeStorageSyncPolyfill__` (pre-Sep-8 fork additions) but **zero** occurrences of `Timed out waiting for playerApi`, `ytmView preload`, or the post-timeout try/catch strings from commits `9251075`/`90c2b24`. Same for `main.old.log` (Jul 19 build, zero breadcrumbs).
- Its preload still has the raw `document.querySelector("ytmusic-app-layout>ytmusic-player-bar").playerApi.isReady()` polling expression. `main.log` shows the result: `Uncaught (in promise) Error: Cannot read properties of undefined (reading 'isReady')` thrown every ~1s from launch onward, forever - the polling loop's `webFrame.executeJavaScript(...)` promise rejects, the interval callback dies before `clearInterval`, `ytmView:loaded` never sends, the loading screen never dismisses. The commits were correct; they just weren't in the binary.

**Fix verified by building and running the packaged output:**

1. `yarn install --immutable` then `yarn package` (Electron Forge + Vite; output in `out/YouTube Music Desktop App-linux-x64/`).
2. Verified the fresh asar contains all fix strings and no longer contains `__chromeStorageSyncPolyfill__`.
3. Killed the stale instance, ran the fresh build: user confirmed the app loaded past the loading screen. Log breadcrumbs show the timeout path working as designed:
   ```
   [ytmView preload] Timed out waiting for playerApi.isReady(), continuing anyway
   [ytmView preload] Error during post-load setup (app will still load): ... 'addEventListener'
   ```
   then `ytmView:loaded` fired and the UI appeared. The old once-per-second `isReady` spam is gone.

**Remaining known issues (non-fatal, observed on the fresh build / in recent logs):**

1. On this machine YTM's `playerApi` often doesn't signal ready within 30s, so startup routinely takes the timeout path (~30s to load). The app still works; worth investigating why `isReady()` stays false (network slowness, GPU/paint on Wayland+Arch) if startup feels sluggish.
2. When the timeout path fires early, `overrideHistoryButtonDisplay()` / nav-arrow setup can throw `Cannot read properties of undefined (reading 'addEventListener')` (missing `#history-link`) - already caught and harmless, but could be null-guarded later.
3. `TypeError [ERR_INVALID_ARG_VALUE] ... createRequire ... Received undefined` from `.vite/main/index.js:29` on every launch (pre-dates Sep 8; non-fatal, window still creates). Some integration constructs a require from an undefined filename in the asar build. Separate issue, uninvestigated.
4. `MaxListenersExceededWarning: 11 destroyed listeners on [WebContents]` - minor leak around context menu re-creation in uBlock's background page.

**How to run the fixed build (until it replaces the system package):**

- Dev: `yarn start` from the repo root (needs `node_modules`, `yarn install --immutable` first).
- Packaged: `yarn package`, then run `out/"YouTube Music Desktop App"-linux-x64/youtube-music-desktop-app`.
- To make it the system app (what pacman owns at `/usr/lib/youtube-music-desktop-app`): follow the recipe in `packaging/arch/PKGBUILD` comments - `yarn package --arch x64 --platform linux`, tar `out/<name>-linux-x64` as `app`, then `makepkg -f` and `pacman -U`.

## DO NOT Merge Upstream Electron Bumps Blindly (2026-09-10 incident)

**Rule: upstream Electron version bumps must be reverted or re-validated in this fork before merging. Upstream staying on/advancing Electron 44 (Chromium 152) is a known breakage for this app's extension support.**

Incident: upstream PR merged Electron 42 → 44 (Chromium 150 → 152). On the installed build this broke extensions two ways:

1. uBlock Origin 1.72.0 (MV2, loaded via `chromium` zip release) failed at startup on Chromium 152:
   its background page threw `Cannot read properties of undefined (reading 'setBadgeBackgroundColor')`
   and our polyfill logged `chrome.alarms is locked down in this context and could not be replaced`
   (Chromium no longer manufactures several MV2-era APIs the same way). Background never installed
   its webRequest listeners → **ads showed again**.
2. Extension popups rendered as a small blank/gray box with content collapsed: `electron-chrome-extensions`
   4.9.0 (July 2025) predates Chromium 152's popup preferred-size changes; uBlock's popup preferred size
   collapsed 252×437 → 288×140 right as its own popup JS threw `undefined (reading 'split')`.
   (Both popups' computed `anchorRect`/`updatePosition` values were actually correct — the geometry code
   is fine; don't chase popup positioning math first.)

Fix applied (commit in this branch): `package.json` electron bumped back to `^42.7.0` (resolves 42.11.3),
full `yarn install → yarn lint → yarn package → makepkg → pacman -U` cycle. Verified on relaunch: no
polyfill lock-down error, no badge error, uBlock popup renders normally, user confirmed blocking works.

When re-attempting the 44 bump, gate it on ALL of:
- electron-chrome-extensions publishing a release that handles Chromium 152 (check their GitHub after Jul 2025);
- uBlock 1.72.x background page starting clean under Chromium 152 (no `Failed to create API on Chrome object`,
  no polyfill "locked down" errors in its console);
- popup preferred-size behaving (open uBlock's popup, confirm it hugs its content and anchors under the toolbar icon);
- no SIGTRAP app-wide crashes (Electron 43/44 landmine: MV3 service workers re-woken via
  `startWorkerForScope` can NOTREACHED-abort the whole browser process — electron issue #52644).

Diagnosis recipe that cracked it: launch installed app with `DEBUG='electron-chrome-extensions:*'`,
click each extension icon, then grep the log for `updatePreferredSize` / `updatePosition` (popup geometry,
from the library's PopupView) alongside renderer `Uncaught TypeError` lines (from the extension's own JS).
Popup geometry values were the red herring; the extension-side TypeErrors were the real signal.

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
