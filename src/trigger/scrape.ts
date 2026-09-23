import { schedules, task } from "@trigger.dev/sdk";
import { runPipeline } from "../pipeline.ts";
import { sheetsConfigFromEnv } from "../sheets.ts";
import { targets } from "../targets.ts";

// The CLI treats these as optional, but a cloud run without them keeps its snapshot on a disk that is
// thrown away, so every run is a "first run" that writes nothing and alerts no one, yet shows Completed.
const REQUIRED_ENV = [
  "SCRAPE_PIPELINE_SERVICE_ACCOUNT_EMAIL",
  "SCRAPE_PIPELINE_SERVICE_ACCOUNT_PRIVATE_KEY",
  "SCRAPE_PIPELINE_SHEET_ID",
  "SCRAPE_PIPELINE_SLACK_WEBHOOK_URL",
];

function requireEnv(): void {
  const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`Not set in this Trigger.dev environment: ${missing.join(", ")}`);
  }
  if (!sheetsConfigFromEnv()) {
    throw new Error("SCRAPE_PIPELINE_SERVICE_ACCOUNT_PRIVATE_KEY is set but has no BEGIN/END PRIVATE KEY markers");
  }
}

/** One site. Payload: { "target": "<name from targets/*.json>" }. */
export const scrapeTarget = task({
  id: "scrape-target",
  // No task-level retry: a retry would write the Runs row and send the Slack alert again.
  // Transient HTTP errors are already retried inside fetch.ts.
  retry: { maxAttempts: 1 },
  run: async (payload: { target: string }) => {
    requireEnv();
    const target = targets.find((t) => t.name === payload.target);
    if (!target) {
      throw new Error(`Unknown target "${payload.target}". Registered: ${targets.map((t) => t.name).join(", ")}`);
    }
    const result = await runPipeline(target);
    // Throwing marks the run Failed in the dashboard; the details are already in the logs.
    if (!result.ok) throw new Error(result.failures.join("\n"));
    return result;
  },
});

/**
 * Every registered site at the same time, one child run each, so each site has its own logs and
 * status. Scheduled after the ECB's ~16:00 CET rate publish so ecb-rates sees the day's change.
 */
export const scrapeAll = schedules.task({
  id: "scrape-all",
  retry: { maxAttempts: 1 },
  cron: { pattern: "0 17 * * 1-5", timezone: "Europe/Berlin", environments: ["PRODUCTION"] },
  run: async () => {
    requireEnv();
    const { runs } = await scrapeTarget.batchTriggerAndWait(targets.map((t) => ({ payload: { target: t.name } })));
    // Results come back in the order the payloads went in.
    const summary = Object.fromEntries(targets.map((t, i) => [t.name, runs[i]?.ok ? "passed" : "FAILED"]));
    const failed = Object.keys(summary).filter((name) => summary[name] !== "passed");
    if (failed.length > 0) throw new Error(`Failed: ${failed.join(", ")} (open each child run for details)`);
    return summary;
  },
});
