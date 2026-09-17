import type { RunRecord } from "./sheets.ts";

const TELEGRAM_API = "https://api.telegram.org";
const MAX_LINES = 15;
// Telegram rejects messages over 4096 characters.
const MAX_LENGTH = 4096;

export type TelegramConfig = { token: string; chatId: string };

export function telegramConfigFromEnv(): TelegramConfig | null {
  const token = process.env.SCRAPE_PIPELINE_TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.SCRAPE_PIPELINE_TELEGRAM_CHAT_ID?.trim();
  if (!token || !chatId) return null;
  return { token, chatId };
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

// Plain text on purpose: with a parse_mode, a scraped value containing * or < could break the message.
export async function sendMessage({ token, chatId }: TelegramConfig, text: string): Promise<void> {
  const res = await fetch(`${TELEGRAM_API}/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
  });
  const json = (await res.json()) as { ok: boolean; description?: string };
  if (!json.ok) throw new Error(`Telegram sendMessage → ${res.status}: ${json.description ?? "unknown error"}`);
}
