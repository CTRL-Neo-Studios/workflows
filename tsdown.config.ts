import { defineConfig } from "tsdown";
import Vue from "unplugin-vue/rolldown";

export default defineConfig({
  // Shared code is split into common chunks, so every subpath shares one copy of each class.
  entry: {
    "core/index": "src/core/index.ts",
    "core/std/index": "src/core/std.ts",
    "core/testing/index": "src/core/testing.ts",
    "vue/index": "src/vue/index.ts",
  },
  plugins: [Vue({ isProduction: true })],
  // `vue` needs vue-tsc, which needs the TypeScript 6 API.
  dts: { vue: true },
  copy: [{ from: "src/vue/style.css", to: "dist/vue" }],
  // Hand-written in package.json, so subpaths stay explicit.
  exports: false,
});
