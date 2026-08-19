import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import path from "path";

const host = process.env.TAURI_DEV_HOST;
const devHost = host || "127.0.0.1";
const devPort = Number(process.env.TAURI_DEV_PORT || "1420");
const hmrPort = Number(process.env.TAURI_DEV_HMR_PORT || String(devPort + 1));

export default defineConfig(async () => ({
  // Tailwind must come before the React plugin — it needs to process CSS before
  // React's transform touches the module graph.
  plugins: [tailwindcss(), react()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
  clearScreen: false,
  server: {
    port: devPort,
    strictPort: true,
    host: devHost,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: hmrPort,
        }
      : undefined,
  },
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    // Raised from the Tauri scaffold defaults (chrome105 / safari13) because Tailwind v4
    // emits modern CSS — `@property`, `color-mix()`, cascade layers — that cannot be
    // downleveled any further. Tailwind v4's own floor is Chrome 111 / Safari 16.4, so
    // building below it produces mangled or dropped styles rather than a clear error.
    //
    // Windows is safe: Tauri requires the evergreen WebView2 runtime, which self-updates
    // and is far past Chrome 111. macOS 16.4 means Ventura 13.3 or newer.
    target:
      process.env.TAURI_ENV_PLATFORM === "windows"
        ? "chrome111"
        : "safari16.4",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
  },
}));
