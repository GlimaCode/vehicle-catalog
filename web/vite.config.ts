import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root,
  plugins: [react()],
  server: {
    port: 4311,
    proxy: { "/api": "http://localhost:4310" },
  },
  build: { outDir: path.join(root, "dist"), emptyOutDir: true },
});
