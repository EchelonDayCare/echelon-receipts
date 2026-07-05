import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// @ts-expect-error process is a nodejs global
const host = process.env.TAURI_DEV_HOST;

// https://vite.dev/config/
export default defineConfig(async () => ({
  plugins: [react()],

  build: {
    target: "esnext",
    cssCodeSplit: true,
    sourcemap: false,
    chunkSizeWarningLimit: 1100,
    // NOTE: manualChunks removed in v1.0.2. The prior regex-based split
    // (react / router / tauri / xlsx / pdf / vendor) created a circular
    // import boundary that WebKit rejects with "Cannot access uninitialized
    // variable" (TDZ) at boot on macOS. Chromium (Windows WebView2) tolerates
    // the cycle, which is why v1.0.0 and v1.0.1 opened blank only on Mac.
    // Rollup's default splitting is cycle-safe; slightly larger initial JS
    // is an acceptable trade for the app actually launching.
  },

  // Vite options tailored for Tauri development and only applied in `tauri dev` or `tauri build`
  //
  // 1. prevent Vite from obscuring rust errors
  clearScreen: false,
  // 2. tauri expects a fixed port, fail if that port is not available
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // 3. tell Vite to ignore watching `src-tauri`
      ignored: ["**/src-tauri/**"],
    },
  },
}));
