import { defineConfig } from "@trigger.dev/sdk";

export default defineConfig({
  project: "proj_rozkxmfiedxeuvegkfph",
  runtime: "node-24",
  dirs: ["./src/trigger"],
  // A healthy run takes about 15 seconds; 5 minutes leaves room for fetch.ts backing off on 429/5xx.
  maxDuration: 300,
});
