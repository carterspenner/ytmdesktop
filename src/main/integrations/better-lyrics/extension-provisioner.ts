import { ensureExtensionFromGithubRelease } from "../extension-provisioner";

// Better Lyrics publishes a prebuilt, ready-to-load Chrome/Chromium unpacked build with each
// GitHub release, so it's fetched the same way as uBlock Origin rather than built from source.
export function ensureBetterLyricsExtension(): Promise<string> {
  return ensureExtensionFromGithubRelease({
    label: "Better Lyrics",
    cacheDirName: "better-lyrics",
    releasesApiUrl: "https://api.github.com/repos/better-lyrics/better-lyrics/releases/latest",
    assetPattern: /^chrome-v.+\.zip$/
  });
}
