import { task } from "@trigger.dev/sdk";
import booksTarget from "../../targets/books.json" with { type: "json" };
import { parseTarget } from "../config.ts";
import { runPipeline } from "../pipeline.ts";

export const scrapeBooksDemo = task({
  id: "scrape-books-demo",
  // No task-level retry: a retry would write the Runs row and send the Telegram alert again.
  // Transient HTTP errors are already retried inside fetch.ts.
  retry: { maxAttempts: 1 },
  run: async () => {
    const result = await runPipeline(parseTarget(booksTarget, "targets/books.json"));
    // Throwing marks the run Failed in the dashboard; the details are already in the logs.
    if (!result.ok) throw new Error(result.failures.join("\n"));
    return result;
  },
});
