import type { RunRecord } from "./sheets.ts";

const MAX_LINES = 15;
// Slack accepts far more, but past this an alert stops being readable; the sheet holds the full list.
const MAX_LENGTH = 4096;

/** The incoming-webhook URL, which is itself the secret: whoever holds it can post to the channel. */
export function slackWebhookFromEnv(): string | null {
  return process.env.SCRAPE_PIPELINE_SLACK_WEBHOOK_URL?.trim() || null;
}

/** The alert text, or null when there is nothing worth a message: a quiet healthy run or a baseline. */
export function digest(run: RunRecord, sheetUrl: string | null, exportError: string | null): string | null {
  const parts: string[] = [];

  if (run.problems.length > 0) {
    parts.push(
      `⚠️ ${run.target}: health check FAILED`,
      run.problems.map((problem) => `- ${problem}`).join("\n"),
      "Last good snapshot kept. Nothing was written to Items or Changes.",
    );
  } else if (!run.isBaseline) {
    // Only minor updates means no message at all: the sheet still has them.
    const { lines, minor } = changeLines(run);
    if (lines.length > 0) {
      const { added, removed, changed } = run.changes;
      const shown = lines.slice(0, MAX_LINES);
      if (lines.length > MAX_LINES) shown.push(`…and ${lines.length - MAX_LINES} more`);
      if (minor > 0) shown.push(`…plus ${minor} minor update${minor === 1 ? "" : "s"}, listed in the Sheet`);
      parts.push(
        `${run.target}: ${added.length} new, ${removed.length} removed, ${changed.length} updated`,
        shown.join("\n"),
      );
    }
  }

  if (exportError) parts.push(`⚠️ Google Sheets export failed: ${exportError}`);
  if (parts.length === 0) return null;
  if (sheetUrl) parts.push(`Sheet: ${sheetUrl}`);
  return parts.join("\n\n").slice(0, MAX_LENGTH);
}

/**
 * New and Removed always alert. An update alerts when one of its non-ignored fields changed text, or
 * moved at least alerts.minChangePct percent; updates are listed biggest move first.
 * ponytail: compares against the last run only, so a drift that stays under the threshold each run never
 * alerts; compare against the last alerted value if a client needs that.
 */
function changeLines(run: RunRecord): { lines: string[]; minor: number } {
  const lines = [
    ...run.changes.added.map((item) => `New: ${item[run.label] ?? ""}`),
    ...run.changes.removed.map((item) => `Removed: ${item[run.label] ?? ""}`),
  ];
  const updates: { text: string; weight: number }[] = [];
  let minor = 0;
  for (const { key, before, after } of run.changes.changed) {
    const fields = run.fieldNames
      .filter((field) => before[field] !== after[field] && !run.alerts.ignore.includes(field))
      .map((field) => ({ field, pct: pctChange(before[field] ?? "", after[field] ?? "") }))
      .filter(({ pct }) => pct === null || Math.abs(pct) >= run.alerts.minChangePct);
    if (fields.length === 0) {
      minor++;
      continue;
    }
    const described = fields.map(
      ({ field, pct }) => `${field} ${before[field] ?? ""} → ${after[field] ?? ""}${pct === null ? "" : ` (${formatPct(pct)})`}`,
    );
    updates.push({
      text: `Updated: ${after[run.label] || key}: ${described.join(", ")}`,
      // A text change such as "In stock" → "Out of stock" has no size, so it sorts first.
      weight: Math.max(...fields.map(({ pct }) => (pct === null ? Number.MAX_VALUE : Math.abs(pct)))),
    });
  }
  updates.sort((a, b) => b.weight - a.weight);
  return { lines: [...lines, ...updates.map((update) => update.text)], minor };
}

/** Percent change between two plain numbers, or null when either is not one (or the old value is 0). */
function pctChange(before: string, after: string): number | null {
  const from = toNumber(before);
  const to = toNumber(after);
  if (from === null || to === null || from === 0) return null;
  return ((to - from) / Math.abs(from)) * 100;
}

// "£51.77", "1,234", "-0.5" are numbers; "About 38,507" or "In stock (3 available)" are text.
function toNumber(value: string): number | null {
  return /^-?[£$€]?\s?\d[\d,]*(\.\d+)?$/.test(value) ? Number(value.replace(/[^\d.-]/g, "")) : null;
}

function formatPct(pct: number): string {
  const size = Math.abs(pct);
  return `${pct < 0 ? "−" : "+"}${size.toFixed(size < 1 ? 2 : 1)}%`;
}

// Scraped text must arrive as plain text. mrkdwn:false stops * _ ~ from formatting, and Slack requires
// & < > as entities: a raw "<!channel>" or "<https://x|y>" in a scraped title would ping or fake a link.
export async function sendMessage(webhookUrl: string, text: string): Promise<void> {
  const escaped = text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const res = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: escaped, mrkdwn: false }),
  });
  // The error names only the status and Slack's reason (e.g. "no_service"), never the URL, which is secret.
  if (!res.ok) throw new Error(`Slack webhook → ${res.status}: ${(await res.text()) || "unknown error"}`);
}
