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
    const lines = changeLines(run);
    if (lines.length > 0) {
      const { added, removed, changed } = run.changes;
      const shown = lines.slice(0, MAX_LINES);
      if (lines.length > MAX_LINES) shown.push(`…and ${lines.length - MAX_LINES} more`);
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

function changeLines(run: RunRecord): string[] {
  const lines: string[] = [];
  for (const item of run.changes.added) lines.push(`New: ${item[run.key] ?? ""}`);
  for (const item of run.changes.removed) lines.push(`Removed: ${item[run.key] ?? ""}`);
  for (const { key, before, after } of run.changes.changed) {
    const fields = run.fieldNames
      .filter((field) => before[field] !== after[field])
      .map((field) => `${field} ${before[field] ?? ""} → ${after[field] ?? ""}`);
    lines.push(`Updated: ${key}: ${fields.join(", ")}`);
  }
  return lines;
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
