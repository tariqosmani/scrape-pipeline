import type { Target } from "./config.ts";
import { crawlDelayMs, isAllowed, politeFetch, sleep } from "./fetch.ts";
import { extractPage, fillRates, type Item } from "./extract.ts";
import { loadSnapshot, pushRun, saveSnapshot, sheetsConfigFromEnv, type RunRecord } from "./sheets.ts";
import { diff, loadPrevious, save, type Snapshot } from "./store.ts";
import { digest, sendMessage, slackWebhookFromEnv } from "./slack.ts";

const FILL_RATE_DROP_LIMIT = 0.5;

export type PipelineResult = {
  ok: boolean;
  failures: string[];
  items: number;
  baseline: boolean;
  added: number;
  removed: number;
  updated: number;
};

/** One full run: crawl, health checks, snapshot, Sheets, Slack. Returns failures instead of exiting, so the CLI and the Trigger.dev task each decide what a failure means. */
export async function runPipeline(target: Target): Promise<PipelineResult> {
  const fieldNames = Object.keys(target.fields);
  const sheets = sheetsConfigFromEnv();
  // With Google credentials the snapshot lives in the sheet, because Trigger.dev runs keep no files.
  // Loaded before crawling, and a failed load throws: treating it as a first run would silently
  // swallow every change since the last snapshot.
  const previous = sheets ? await loadSnapshot(sheets, target.name) : await loadPrevious(target.name);
  const delayMs = await crawlDelayMs(target.startUrl, target.userAgent, target.requestDelayMs);

  console.log(`\n${target.name} — starting at ${target.startUrl}`);
  console.log(`  robots.txt respected, ${delayMs}ms between requests, max ${target.maxPages} page(s)\n`);

  const items: Item[] = [];
  const failures: string[] = [];
  let url: string | null = target.startUrl;
  let pagesFetched = 0;

  while (url && pagesFetched < target.maxPages) {
    if (!(await isAllowed(url, target.userAgent))) {
      console.warn(`  robots.txt disallows ${url} — stopping.`);
      break;
    }

    try {
      const html = await politeFetch(url, target.userAgent);
      const page = extractPage(html, url, target);
      items.push(...page.items);
      pagesFetched++;
      console.log(`  page ${pagesFetched}: ${page.items.length} items`);
      url = page.nextUrl;
    } catch (error) {
      // One bad page must not kill the run; it is reported and the crawl stops cleanly.
      failures.push(`${url}: ${error instanceof Error ? error.message : String(error)}`);
      console.warn(`  page failed: ${url}`);
      break;
    }

    if (url) await sleep(delayMs);
  }

  const rates = fillRates(items, fieldNames);
  const changes = diff(previous?.items ?? [], items, target.key);

  const problems: string[] = [];
  // A partial crawl would make every item on the missing pages look "Removed".
  if (failures.length > 0) problems.push(`${failures.length} page(s) failed to load: ${failures.join("; ")}`);
  if (items.length === 0) problems.push("zero items extracted");
  if (items.length > 0 && items.length < target.minItemsExpected) {
    problems.push(`only ${items.length} items, expected at least ${target.minItemsExpected}`);
  }
  for (const field of fieldNames) {
    const now = rates[field] ?? 0;
    const before = previous?.fillRates?.[field];
    if (items.length > 0 && now === 0) {
      problems.push(`field "${field}" is empty on every item (check the selector)`);
    } else if (before !== undefined && before - now > FILL_RATE_DROP_LIMIT) {
      problems.push(`field "${field}" fill rate fell ${pct(before)} → ${pct(now)} (likely selector drift)`);
    }
  }

  const runAt = new Date().toISOString();
  const healthy = problems.length === 0;
  const snapshot: Snapshot = { target: target.name, runAt, itemCount: items.length, fillRates: rates, items };
  // An unhealthy run keeps the last good snapshot, so the next healthy run diffs against real data.
  const keptNote = "not saved (unhealthy run, last good snapshot kept)";

  console.log(`\n  items:      ${items.length}`);
  console.log(`  fill rates: ${fieldNames.map((f) => `${f} ${pct(rates[f] ?? 0)}`).join(", ")}`);
  console.log(
    previous
      ? `  changes:    +${changes.added.length} new, -${changes.removed.length} gone, ~${changes.changed.length} updated`
      : `  changes:    first run, nothing to compare against yet`,
  );

  const run: RunRecord = {
    target: target.name,
    runAt,
    key: target.key,
    fieldNames,
    items,
    fillRates: rates,
    isBaseline: previous === null,
    changes,
    problems,
  };

  let exportError: string | null = null;
  if (sheets) {
    try {
      await pushRun(sheets, run);
      console.log(`  sheet:      updated (${healthy ? "Items, Changes, Runs" : "Runs only, run was unhealthy"})`);
      // Saved only after the export succeeds: if it failed, the next run reports these changes again
      // (a duplicate Changes row) instead of never reporting them.
      if (healthy) await saveSnapshot(sheets, snapshot);
      console.log(`  snapshot:   ${healthy ? "saved to the sheet's Snapshot tab" : keptNote}`);
    } catch (error) {
      exportError = error instanceof Error ? error.message : String(error);
      console.log(`  sheet:      FAILED (snapshot not advanced)`);
    }
  } else {
    console.log(`  snapshot:   ${healthy ? await save(snapshot) : keptNote}`);
    console.log(`  sheet:      skipped (SCRAPE_PIPELINE_* Google credentials not set)`);
  }

  let alertError: string | null = null;
  const slack = slackWebhookFromEnv();
  const message = digest(run, sheets && `https://docs.google.com/spreadsheets/d/${sheets.sheetId}/edit`, exportError);
  if (!slack) {
    console.log(`  slack:      skipped (SCRAPE_PIPELINE_SLACK_WEBHOOK_URL not set)\n`);
  } else if (!message) {
    console.log(`  slack:      nothing to report\n`);
  } else {
    try {
      await sendMessage(slack, message);
      console.log(`  slack:      alert sent\n`);
    } catch (error) {
      alertError = error instanceof Error ? error.message : String(error);
      console.log(`  slack:      FAILED\n`);
    }
  }

  for (const change of changes.changed.slice(0, 10)) {
    const fields = fieldNames.filter((f) => change.before[f] !== change.after[f]);
    console.log(`  ~ ${change.key}: ${fields.map((f) => `${f} ${change.before[f]} → ${change.after[f]}`).join(", ")}`);
  }

  if (!healthy) {
    console.error(`\nHEALTH CHECK FAILED:`);
    for (const problem of problems) console.error(`  - ${problem}`);
    console.error("");
  }
  if (exportError) console.error(`\nGOOGLE SHEETS EXPORT FAILED: ${exportError}\n`);
  if (alertError) console.error(`\nSLACK ALERT FAILED: ${alertError}\n`);

  const allFailures = [...problems];
  if (exportError) allFailures.push(`Google Sheets export failed: ${exportError}`);
  if (alertError) allFailures.push(`Slack alert failed: ${alertError}`);
  if (allFailures.length === 0) console.log("Health check passed.\n");

  return {
    ok: allFailures.length === 0,
    failures: allFailures,
    items: items.length,
    baseline: previous === null,
    added: changes.added.length,
    removed: changes.removed.length,
    updated: changes.changed.length,
  };
}

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
