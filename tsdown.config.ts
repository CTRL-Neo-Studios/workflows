import { defineConfig } from "tsdown";

export default defineConfig({
  entry: { "core/index": "src/core/index.ts" },
  dts: true,
  // Hand-written in package.json: with one entry tsdown maps it to "." instead of "./core".
  exports: false,
});
