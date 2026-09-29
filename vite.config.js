import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "renderer",
  base: "./",
  plugins: [react()],
  define: { "process.env.IS_PREACT": JSON.stringify("false") },
  build: { outDir: "../dist", emptyOutDir: true, chunkSizeWarningLimit: 10000 },
});
