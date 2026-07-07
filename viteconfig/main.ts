import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { defineConfig, type Plugin } from "vite";

// electron-chrome-extensions resolves its preload script at runtime via `import.meta.dirname`,
// which Rollup doesn't polyfill when bundling the package's ESM source into this CJS
// main-process bundle, leaving it undefined and crashing the app on startup. Electron Forge's
// Vite plugin also only packages the `.vite` output folder, so `node_modules` isn't available
// for the library's require.resolve fallback either. Copying the preload script next to our own
// bundled output lets ad-blocker/index.ts route around both problems by passing an explicit
// `modulePath` pointing at __dirname.
function copyChromeExtensionsPreload(): Plugin {
  const require = createRequire(__filename);
  const source = require.resolve("electron-chrome-extensions/preload");
  return {
    name: "copy-chrome-extensions-preload",
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "dist/chrome-extension-api.preload.js",
        source: readFileSync(source)
      });
    }
  };
}

let gitBranch: string = "";
try {
  gitBranch = execSync("git rev-parse --abbrev-ref HEAD").toString();
} catch (e) {
  // User has likely downloaded from the YTM Desktop via the "Download ZIP".
  // We don't plan to support this, but at least provide users with a bit of improved UX
  // by providing them with what to do rather than just leaving them in the dust.
  e.message =
    " ======= Failed to get Git Info. ======= \n" +
    "Please make sure that when building this application you are cloning the repository from GitHub rather than using the Download ZIP option.\n" +
    "Follow the instructions in the README.md file to clone the repository and build the application from there.\n" +
    " ======= Failed to get Git Info. ======= \n\n" +
    e.message;
  // Re-throw the error so that the build fails with the updated message.
  throw e;
}

// HEAD is used for production builds as they check out version tags in a detached HEAD state
const devBuild = gitBranch !== "HEAD" && process.env.NODE_ENV === "development";

// https://vitejs.dev/config
export default defineConfig({
  build: {
    outDir: ".vite/main",
    rollupOptions: {
      external: ["bufferutil", "utf-8-validate"]
    }
  },
  plugins: [copyChromeExtensionsPreload()],
  define: {
    YTMD_DISABLE_UPDATES: devBuild,
    YTMD_UPDATE_FEED_OWNER: process.env.YTMD_UPDATE_FEED_OWNER ? `'${process.env.YTMD_UPDATE_FEED_OWNER}'` : "'ytmdesktop'",
    YTMD_UPDATE_FEED_REPOSITORY: process.env.YTMD_UPDATE_FEED_REPOSITORY ? `'${process.env.YTMD_UPDATE_FEED_REPOSITORY}'` : "'ytmdesktop'"
  }
});
