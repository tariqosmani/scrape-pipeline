import { task } from "@trigger.dev/sdk";
import booksTarget from "../../targets/books.json" with { type: "json" };
import { parseTarget } from "../config.ts";
import { runPipeline } from "../pipeline.ts";
import { sheetsConfigFromEnv } from "../sheets.ts";

// The CLI treats these as optional, but a cloud run without them keeps its snapshot on a disk that is
// thrown away, so every run is a "first run" that writes nothing and alerts no one, yet shows Completed.
const REQUIRED_ENV = [
  "SCRAPE_PIPELINE_SERVICE_ACCOUNT_EMAIL",
  "SCRAPE_PIPELINE_SERVICE_ACCOUNT_PRIVATE_KEY",
  "SCRAPE_PIPELINE_SHEET_ID",
  "SCRAPE_PIPELINE_SLACK_WEBHOOK_URL",
];

export const scrapeBooksDemo = task({
  id: "scrape-books-demo",
  // No task-level retry: a retry would write the Runs row and send the Slack alert again.
  // Transient HTTP errors are already retried inside fetch.ts.
  retry: { maxAttempts: 1 },
  run: async () => {
    const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
    if (missing.length > 0) {
      throw new Error(`Not set in this Trigger.dev environment: ${missing.join(", ")}`);
    }
    if (!sheetsConfigFromEnv()) {
      throw new Error("SCRAPE_PIPELINE_SERVICE_ACCOUNT_PRIVATE_KEY is set but has no BEGIN/END PRIVATE KEY markers");
    }
    const result = await runPipeline(parseTarget(booksTarget, "targets/books.json"));
    // Throwing marks the run Failed in the dashboard; the details are already in the logs.
    if (!result.ok) throw new Error(result.failures.join("\n"));
    return result;
  },
});
