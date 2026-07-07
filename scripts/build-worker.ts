/**
 * Builds the prebuilt Worker bundle uploaded by main.tf (`dist/worker.js`).
 */

const result = await Bun.build({
  entrypoints: ["src/worker.ts"],
  outdir: "dist",
  target: "browser",
  format: "esm",
  naming: "worker.js",
  minify: false,
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  throw new Error("takos-git worker build failed");
}

console.log("built dist/worker.js");
