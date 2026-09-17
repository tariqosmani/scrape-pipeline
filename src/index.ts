import path from "node:path";
import { loadTarget } from "./config.ts";
import { runPipeline } from "./pipeline.ts";

// Local dev reads projects/scrape-pipeline/.env; a deployed host sets the same vars directly.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "..", ".env"));
} catch {}

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: node src/index.ts <path-to-target.json>");
  process.exit(2);
}

const result = await runPipeline(await loadTarget(configPath));
if (!result.ok) process.exit(1);
