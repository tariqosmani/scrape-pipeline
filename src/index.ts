import { spawn } from "node:child_process";
import path from "node:path";
import { loadTarget } from "./config.ts";
import { runPipeline } from "./pipeline.ts";
import { targets } from "./targets.ts";

// Local dev reads projects/scrape-pipeline/.env; a deployed host sets the same vars directly.
try {
  process.loadEnvFile(path.resolve(import.meta.dirname, "..", ".env"));
} catch {}

const [arg, name] = process.argv.slice(2);
if (arg === "--all") process.exit(await runAll());

const target = arg === "--target" ? targets.find((t) => t.name === name) : arg ? await loadTarget(arg) : undefined;
if (!target) {
  console.error(
    arg === "--target"
      ? `Unknown target "${name}". Registered: ${targets.map((t) => t.name).join(", ")}`
      : "Usage: node src/index.ts <path-to-target.json> | --target <name> | --all",
  );
  process.exit(2);
}

const result = await runPipeline(target);
if (!result.ok) process.exit(1);

/** Every registered target at once, each in its own process. Output is printed per target as it finishes, so logs never interleave. */
async function runAll(): Promise<number> {
  const codes = await Promise.all(
    targets.map(
      (t) =>
        new Promise<number>((resolve) => {
          const child = spawn(process.execPath, [import.meta.filename, "--target", t.name]);
          let output = "";
          child.stdout.on("data", (chunk) => (output += chunk));
          child.stderr.on("data", (chunk) => (output += chunk));
          child.on("close", (code) => {
            console.log(`━━━ ${t.name}: ${code === 0 ? "passed" : "FAILED"}${output}`);
            resolve(code ?? 1);
          });
        }),
    ),
  );
  const failed = targets.filter((_, i) => codes[i] !== 0).map((t) => t.name);
  console.log(failed.length === 0 ? `All ${targets.length} targets passed.` : `FAILED: ${failed.join(", ")}`);
  return failed.length === 0 ? 0 : 1;
}
