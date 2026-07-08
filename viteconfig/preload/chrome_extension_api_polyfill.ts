import { defineConfig } from "vite";

// https://vitejs.dev/config
export default defineConfig({
  build: {
    // Referenced at runtime from chrome-extension-host.ts as a sibling of the main bundle
    // (`.vite/main`), since it must be a real file on disk for session.registerPreloadScript().
    outDir: ".vite/main/chrome-extension-api-polyfill"
  }
});
