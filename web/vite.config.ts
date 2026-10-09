import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL(".", import.meta.url));
const backend = `http://127.0.0.1:${process.env["PORT"] || 7340}`;

export default defineConfig({
  root,
  plugins: [react(), tailwindcss()],
  build: { outDir: fileURLToPath(new URL("../dist", import.meta.url)), emptyOutDir: true },
  server: {
    port: 5173,
    proxy: {
      "/api": backend,
      "/ws": { target: backend.replace("http", "ws"), ws: true },
    },
  },
});
