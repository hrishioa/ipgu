import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/main.ts"],
  format: ["esm"],
  target: "node18",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: false,
  minify: false,
  bundle: true,
  platform: "node",
  shims: true,
  skipNodeModulesBundle: true,
  external: [
    "@anthropic-ai/sdk",
    "@google/genai",
    "boxen",
    "chalk",
    "cli-progress",
    "commander",
  ],
});
