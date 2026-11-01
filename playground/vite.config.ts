import vue from "@vitejs/plugin-vue";
import ui from "@nuxt/ui/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [
    vue(),
    // `root` puts the generated theme (`#build/ui/*`) in the repo's node_modules, where vue-tsc finds it.
    ui({ router: false, dts: false, root: fileURLToPath(new URL("..", import.meta.url)) }),
  ],
  // A dev playground: one bundle is fine.
  build: { chunkSizeWarningLimit: 4096 },
});
