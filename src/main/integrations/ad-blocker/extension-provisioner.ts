import { ensureExtensionFromGithubRelease } from "../extension-provisioner";

// uBlock Origin was removed from the Chrome Web Store following Manifest V2's deprecation, so the
// unpacked Manifest V2 build is fetched directly from the upstream GitHub releases instead.
//
// Pinned to 1.72.0 rather than tracking "latest": a real device that auto-updated from 1.72.0 to
// 1.72.2 (this app rechecks for new releases every 6 hours) started reproducibly crashing the
// entire app with a native SIGTRAP the moment the ad blocker was enabled, at a consistent address
// inside Chromium's own extension bindings code. Disabling just the ad blocker (independent of
// Better Lyrics, also loaded via this same mechanism) fully isolated it to uBlock specifically, and
// reverting to 1.72.0 is the only known-good state - 1.72.0 ran stably for a week prior. Pointing
// this at a specific tag instead of /releases/latest means an existing cached 1.72.2 install will
// be detected as stale and downgraded back to 1.72.0 automatically on next launch, the same way it
// would normally pick up a newer release.
export function ensureUBlockOriginExtension(): Promise<string> {
  return ensureExtensionFromGithubRelease({
    label: "Ad blocker",
    cacheDirName: "ublock-origin",
    releasesApiUrl: "https://api.github.com/repos/gorhill/uBlock/releases/tags/1.72.0",
    assetPattern: /^uBlock0_.+\.chromium\.zip$/
  });
}
