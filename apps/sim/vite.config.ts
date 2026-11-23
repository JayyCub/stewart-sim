import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/** Dev server: /flight → /flight/ (302 so browsers don't cache it) (GitHub Pages does this redirect itself). */
const flightRedirect: Plugin = {
  name: "flight-redirect",
  configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === "/flight" || req.url?.startsWith("/flight?")) {
        res.statusCode = 302;
        res.setHeader("Location", req.url.replace("/flight", "/flight/"));
        res.end();
        return;
      }
      next();
    });
  },
};

// Relative base so the build works on GitHub Pages under /<repo>/ and as a published preview.
// Two pages: the rig designer (index.html) and the flight game (flight/index.html).
export default defineConfig({
  base: "./",
  plugins: [react(), flightRedirect],
  build: {
    chunkSizeWarningLimit: 1500,
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        flight: resolve(import.meta.dirname, "flight/index.html"),
      },
    },
  },
});
