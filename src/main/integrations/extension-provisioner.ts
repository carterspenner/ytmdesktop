import { app, net } from "electron";
import log from "electron-log";
import crypto from "crypto";
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";
import extractZip from "extract-zip";

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

export interface ExtensionProvisionerConfig {
  // Used in log messages.
  label: string;
  // Subdirectory of userData/extensions used for this extension's cache.
  cacheDirName: string;
  releasesApiUrl: string;
  // Matched against each release asset's filename to find the unpacked browser build.
  assetPattern: RegExp;
}

function getCacheDir(cacheDirName: string): string {
  return path.join(app.getPath("userData"), "extensions", cacheDirName);
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
        fsPromises.rm(destination, { force: true }).catch((): undefined => undefined);
        reject(error);
      });
      fileStream.on("finish", resolve);
      fileStream.on("error", error => {
        fsPromises.rm(destination, { force: true }).catch((): undefined => undefined);
        reject(error);
      });
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

// extract-zip creates symlinks from a downloaded zip without validating their target (no fixed
// release exists - https://github.com/advisories/GHSA-jmr9-qjv8-65gv), so a malicious zip could
// place a symlink inside the extraction dir pointing anywhere else on disk. Real extension
// packages have no legitimate reason to contain symlinks, so treat any as a sign of tampering
// rather than trying to validate individual targets.
async function assertNoSymlinks(dir: string): Promise<void> {
  const entries = await fsPromises.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`Refusing to use extracted extension: unexpected symlink at ${entryPath}`);
    }
    if (entry.isDirectory()) {
      await assertNoSymlinks(entryPath);
    }
  }
}

// Different extensions' release zips are packaged differently - some (e.g. uBlock Origin's chromium
// build) nest the extension inside a wrapper folder, others zip the extension's own contents directly
// at the archive root. Rather than hardcoding either layout, find manifest.json wherever it landed.
async function locateManifestDir(extractedRoot: string): Promise<string> {
  if (fs.existsSync(path.join(extractedRoot, "manifest.json"))) {
    return extractedRoot;
  }

  const entries = await fsPromises.readdir(extractedRoot, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory() && fs.existsSync(path.join(extractedRoot, entry.name, "manifest.json"))) {
      return path.join(extractedRoot, entry.name);
    }
  }

  throw new Error("Could not find manifest.json in the extracted extension package");
}

/**
 * Ensures a local unpacked copy of a browser extension is present and up to date, downloading and
 * extracting it from the latest GitHub release if needed.
 *
 * Returns the absolute path to the directory containing the extension's manifest.json.
 */
export async function ensureExtensionFromGithubRelease(config: ExtensionProvisionerConfig): Promise<string> {
  const cacheDir = getCacheDir(config.cacheDirName);
  await fsPromises.mkdir(cacheDir, { recursive: true });

  const metaPath = path.join(cacheDir, "meta.json");
  const cachedMeta = readJson<ExtensionMeta>(metaPath);

  if (cachedMeta) {
    const cachedVersionDir = path.join(cacheDir, sanitizeForPath(cachedMeta.version));
    const cachedZipPath = path.join(cachedVersionDir, `${sanitizeForPath(cachedMeta.version)}.zip`);

    if (fs.existsSync(cachedZipPath)) {
      const currentHash = await sha256File(cachedZipPath).catch((): null => null);
      const cachedManifestDir = currentHash === cachedMeta.sha256 ? await locateManifestDir(cachedVersionDir).catch((): null => null) : null;

      if (cachedManifestDir) {
        if (Date.now() - cachedMeta.lastCheckedAt < RECHECK_INTERVAL_MS) {
          return cachedManifestDir;
        }

        try {
          const release = await fetchJson<GitHubRelease>(config.releasesApiUrl);
          if (release.tag_name === cachedMeta.version) {
            cachedMeta.lastCheckedAt = Date.now();
            await fsPromises.writeFile(metaPath, JSON.stringify(cachedMeta), "utf8");
            return cachedManifestDir;
          }

          return await downloadAndExtract(config, cacheDir, metaPath, release);
        } catch (error) {
          log.warn(`${config.label}: could not check for updates, continuing with cached copy`, error);
          return cachedManifestDir;
        }
      }

      log.warn(`${config.label}: cached package is missing or failed integrity verification, re-downloading`);
    }
  }

  const release = await fetchJson<GitHubRelease>(config.releasesApiUrl);
  return downloadAndExtract(config, cacheDir, metaPath, release);
}

async function downloadAndExtract(config: ExtensionProvisionerConfig, cacheDir: string, metaPath: string, release: GitHubRelease): Promise<string> {
  const asset = release.assets.find(candidate => config.assetPattern.test(candidate.name));
  if (!asset) {
    throw new Error(`Could not find a matching release asset for ${config.label}`);
  }

  const versionDir = path.join(cacheDir, sanitizeForPath(release.tag_name));
  const zipPath = path.join(versionDir, `${sanitizeForPath(release.tag_name)}.zip`);

  await fsPromises.rm(versionDir, { recursive: true, force: true }).catch((): undefined => undefined);
  await fsPromises.mkdir(versionDir, { recursive: true });

  log.info(`${config.label}: downloading ${release.tag_name}`);
  await downloadFile(asset.browser_download_url, zipPath);
  const sha256 = await sha256File(zipPath);
  await extractZip(zipPath, { dir: versionDir });

  try {
    await assertNoSymlinks(versionDir);
  } catch (error) {
    await fsPromises.rm(versionDir, { recursive: true, force: true }).catch((): undefined => undefined);
    throw error;
  }

  const manifestDir = await locateManifestDir(versionDir);

  const meta: ExtensionMeta = {
    version: release.tag_name,
    sha256,
    lastCheckedAt: Date.now()
  };
  await fsPromises.writeFile(metaPath, JSON.stringify(meta), "utf8");

  await pruneOldVersions(cacheDir, versionDir);

  return manifestDir;
}
