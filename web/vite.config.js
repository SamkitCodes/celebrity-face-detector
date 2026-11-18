import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  // amazon-cognito-identity-js references Node's `global`.
  define: { global: "globalThis" },
  build: {
    // No inline <script>/<style> so the strict CloudFront CSP can stay strict.
    assetsInlineLimit: 0,
    modulePreload: { polyfill: false },
  },
  server: {
    // Local dev: `npm run dev` and point /api at the deployed CloudFront URL.
    proxy: process.env.VITE_API_PROXY
      ? { "/api": { target: process.env.VITE_API_PROXY, changeOrigin: true } }
      : undefined,
  },
});
