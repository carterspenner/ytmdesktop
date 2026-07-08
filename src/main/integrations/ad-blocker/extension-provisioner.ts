import { ensureExtensionFromGithubRelease } from "../extension-provisioner";

// uBlock Origin was removed from the Chrome Web Store following Manifest V2's deprecation, so the
// unpacked Manifest V2 build is fetched directly from the upstream GitHub releases instead.
export function ensureUBlockOriginExtension(): Promise<string> {
  return ensureExtensionFromGithubRelease({
    label: "Ad blocker",
    cacheDirName: "ublock-origin",
    releasesApiUrl: "https://api.github.com/repos/gorhill/uBlock/releases/latest",
    assetPattern: /^uBlock0_.+\.chromium\.zip$/
  });
}
