import { loadTarget } from "./config.ts";
import { crawlDelayMs, isAllowed, politeFetch, sleep } from "./fetch.ts";
import { extractPage, fillRates, type Item } from "./extract.ts";
import { diff, loadPrevious, save } from "./store.ts";

const FILL_RATE_DROP_LIMIT = 0.5;

const configPath = process.argv[2];
if (!configPath) {
  console.error("Usage: node src/index.ts <path-to-target.json>");
  process.exit(2);
}

const target = await loadTarget(configPath);
const fieldNames = Object.keys(target.fields);
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
const previous = await loadPrevious(target.name);
const changes = diff(previous?.items ?? [], items, target.key);

const problems: string[] = [];
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

const file = await save({
  target: target.name,
  runAt: new Date().toISOString(),
  itemCount: items.length,
  fillRates: rates,
  items,
});

console.log(`\n  items:      ${items.length}`);
console.log(`  fill rates: ${fieldNames.map((f) => `${f} ${pct(rates[f] ?? 0)}`).join(", ")}`);
console.log(
  previous
    ? `  changes:    +${changes.added.length} new, -${changes.removed.length} gone, ~${changes.changed.length} updated`
    : `  changes:    first run, nothing to compare against yet`,
);
if (failures.length > 0) console.log(`  failures:   ${failures.length}`);
console.log(`  snapshot:   ${file}\n`);

for (const change of changes.changed.slice(0, 10)) {
  const fields = fieldNames.filter((f) => change.before[f] !== change.after[f]);
  console.log(`  ~ ${change.key}: ${fields.map((f) => `${f} ${change.before[f]} → ${change.after[f]}`).join(", ")}`);
}

if (problems.length > 0) {
  console.error(`\nHEALTH CHECK FAILED:`);
  for (const problem of problems) console.error(`  - ${problem}`);
  console.error("");
  process.exit(1);
}

console.log("Health check passed.\n");

function pct(value: number): string {
  return `${Math.round(value * 100)}%`;
}
