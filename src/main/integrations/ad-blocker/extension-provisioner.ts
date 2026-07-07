import { app, net } from "electron";
import log from "electron-log";
import crypto from "crypto";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import extractZip from "extract-zip";

// uBlock Origin was removed from the Chrome Web Store following Manifest V2's deprecation, so the
// unpacked Manifest V2 build is fetched directly from the upstream GitHub releases instead.
const RELEASES_API_URL = "https://api.github.com/repos/gorhill/uBlock/releases/latest";
const CHROMIUM_ASSET_PATTERN = /^uBlock0_.+\.chromium\.zip$/;
// The chromium release zip is built with `zip -r uBlock0_<version>.chromium.zip uBlock0.chromium/*`,
// so the manifest ends up nested inside this folder name rather than at the zip root.
const EXTENSION_FOLDER_NAME = "uBlock0.chromium";
const RECHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  assets: GitHubReleaseAsset[];
}

interface ExtensionMeta {
  version: string;
  // Hash of the cached zip computed by us at download time. This is trust-on-first-use
  // integrity for the local cache (detects corruption/tampering between launches) -
  // it is not a signature check against a known-good upstream value.
  sha256: string;
  lastCheckedAt: number;
}

function getCacheDir(): string {
  return path.join(app.getPath("userData"), "extensions", "ublock-origin");
}

function sanitizeForPath(value: string): string {
  return value.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

function readJson<T>(filePath: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash("sha256");
    const stream = fs.createReadStream(filePath);
    stream.on("data", chunk => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
    stream.on("error", reject);
  });
}

function fetchJson<T>(url: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: "GET" });
    request.setHeader("User-Agent", "YouTube-Music-Desktop-App");
    request.setHeader("Accept", "application/vnd.github+json");

    request.on("response", response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`Request to ${url} failed with status code ${response.statusCode}`));
        return;
      }

      let data = "";
      response.on("data", chunk => (data += chunk));
      response.on("end", () => {
        try {
          resolve(JSON.parse(data) as T);
        } catch (error) {
          reject(error);
        }
      });
      response.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

function downloadFile(url: string, destination: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, method: "GET" });
    request.setHeader("User-Agent", "YouTube-Music-Desktop-App");

    request.on("response", response => {
      if (response.statusCode < 200 || response.statusCode >= 300) {
        reject(new Error(`Download of ${url} failed with status code ${response.statusCode}`));
        return;
      }

      const fileStream = fs.createWriteStream(destination);
      response.on("data", chunk => fileStream.write(chunk));
      response.on("end", () => fileStream.end());
      response.on("error", error => {
        fileStream.destroy();
        reject(error);
      });
      fileStream.on("finish", resolve);
      fileStream.on("error", reject);
    });
    request.on("error", reject);
    request.end();
  });
}

async function pruneOldVersions(cacheDir: string, keepDir: string): Promise<void> {
  let entries: fs.Dirent[] = [];
  try {
    entries = await fsPromises.readdir(cacheDir, { withFileTypes: true });
  } catch {
    return;
  }

  // Only version subdirectories are pruned here - meta.json lives directly in cacheDir and must survive.
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const entryPath = path.join(cacheDir, entry.name);
    if (entryPath === keepDir) continue;
    await fsPromises.rm(entryPath, { recursive: true, force: true }).catch((): undefined => undefined);
  }
}

function isCachedVersionIntact(versionDir: string, zipPath: string): boolean {
  const manifestPath = path.join(versionDir, EXTENSION_FOLDER_NAME, "manifest.json");
  return fs.existsSync(manifestPath) && fs.existsSync(zipPath);
}

/**
 * Ensures a local unpacked copy of the uBlock Origin (Manifest V2) chromium build is present and
 * up to date, downloading/extracting it from the latest GitHub release if needed.
 *
 * Returns the absolute path to the directory containing the extension's manifest.json.
 */
export async function ensureUBlockOriginExtension(): Promise<string> {
  const cacheDir = getCacheDir();
  await fsPromises.mkdir(cacheDir, { recursive: true });

  const metaPath = path.join(cacheDir, "meta.json");
  const cachedMeta = readJson<ExtensionMeta>(metaPath);

  if (cachedMeta) {
    const cachedVersionDir = path.join(cacheDir, sanitizeForPath(cachedMeta.version));
    const cachedZipPath = path.join(cachedVersionDir, `${sanitizeForPath(cachedMeta.version)}.zip`);

    if (isCachedVersionIntact(cachedVersionDir, cachedZipPath)) {
      const currentHash = await sha256File(cachedZipPath).catch((): null => null);
      if (currentHash === cachedMeta.sha256) {
        if (Date.now() - cachedMeta.lastCheckedAt < RECHECK_INTERVAL_MS) {
          return path.join(cachedVersionDir, EXTENSION_FOLDER_NAME);
        }

        try {
          const release = await fetchJson<GitHubRelease>(RELEASES_API_URL);
          if (release.tag_name === cachedMeta.version) {
            cachedMeta.lastCheckedAt = Date.now();
            await fsPromises.writeFile(metaPath, JSON.stringify(cachedMeta), "utf8");
            return path.join(cachedVersionDir, EXTENSION_FOLDER_NAME);
          }

          return await downloadAndExtract(cacheDir, metaPath, release);
        } catch (error) {
          log.warn("Ad blocker: could not check for uBlock Origin updates, continuing with cached copy", error);
          return path.join(cachedVersionDir, EXTENSION_FOLDER_NAME);
        }
      }

      log.warn("Ad blocker: cached uBlock Origin package is missing or failed integrity verification, re-downloading");
    }
  }

  const release = await fetchJson<GitHubRelease>(RELEASES_API_URL);
  return downloadAndExtract(cacheDir, metaPath, release);
}

async function downloadAndExtract(cacheDir: string, metaPath: string, release: GitHubRelease): Promise<string> {
  const asset = release.assets.find(candidate => CHROMIUM_ASSET_PATTERN.test(candidate.name));
  if (!asset) {
    throw new Error("Could not find a chromium release asset for uBlock Origin");
  }

  const versionDir = path.join(cacheDir, sanitizeForPath(release.tag_name));
  const zipPath = path.join(versionDir, `${sanitizeForPath(release.tag_name)}.zip`);
  const extensionDir = path.join(versionDir, EXTENSION_FOLDER_NAME);
  const manifestPath = path.join(extensionDir, "manifest.json");

  await fsPromises.rm(versionDir, { recursive: true, force: true }).catch((): undefined => undefined);
  await fsPromises.mkdir(versionDir, { recursive: true });

  log.info(`Ad blocker: downloading uBlock Origin ${release.tag_name}`);
  await downloadFile(asset.browser_download_url, zipPath);
  const sha256 = await sha256File(zipPath);
  await extractZip(zipPath, { dir: versionDir });

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Downloaded uBlock Origin package did not contain the expected ${EXTENSION_FOLDER_NAME} folder`);
  }

  const meta: ExtensionMeta = {
    version: release.tag_name,
    sha256,
    lastCheckedAt: Date.now()
  };
  await fsPromises.writeFile(metaPath, JSON.stringify(meta), "utf8");

  await pruneOldVersions(cacheDir, versionDir);

  return extensionDir;
}
