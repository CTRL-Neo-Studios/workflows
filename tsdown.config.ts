import { defineConfig } from "tsdown";

export default defineConfig({
  // Shared code is split into common chunks, so every subpath shares one copy of each class.
  entry: {
    "core/index": "src/core/index.ts",
    "core/std/index": "src/core/std.ts",
    "core/testing/index": "src/core/testing.ts",
  },
  dts: true,
  // Hand-written in package.json, so subpaths stay explicit.
  exports: false,
});
