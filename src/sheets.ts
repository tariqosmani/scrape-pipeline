import { createSign } from "node:crypto";
import type { Item } from "./extract.ts";
import type { Diff, Snapshot } from "./store.ts";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
// Hidden tab holding the last good run. A1 is the run metadata as JSON, A2 down one item per row as JSON.
const SNAPSHOT_TAB = "Snapshot";
// Must match the spreadsheet's timezone (Asia/Karachi, UTC+5, no DST) or run times shift.
const SHEET_UTC_OFFSET_HOURS = 5;

export type SheetsConfig = { email: string; privateKey: string; sheetId: string };

export type RunRecord = {
  target: string;
  runAt: string;
  key: string;
  fieldNames: string[];
  items: Item[];
  fillRates: Record<string, number>;
  isBaseline: boolean;
  changes: Diff;
  problems: string[];
};

type Cell = string | number;

export function sheetsConfigFromEnv(): SheetsConfig | null {
  const email = process.env.SCRAPE_PIPELINE_SERVICE_ACCOUNT_EMAIL?.trim();
  const privateKey = normalizePrivateKey(process.env.SCRAPE_PIPELINE_SERVICE_ACCOUNT_PRIVATE_KEY);
  const sheetId = process.env.SCRAPE_PIPELINE_SHEET_ID?.trim();
  if (!email || !privateKey || !sheetId) return null;
  return { email, privateKey, sheetId };
}

// A pasted PEM survives four different ways depending on the host: one line with literal \n escapes
// (this project's own .env format), real multi-line text, CRLF line endings from a Windows clipboard,
// or wrapped in the quotes .env needs but an env-var UI's bulk paste imports literally. Handle all four
// rather than trust one paste to come out clean.
function normalizePrivateKey(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let key = raw.trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1).trim();
  }
  return key.replace(/\\n/g, "\n").replace(/\r\n/g, "\n").trim();
}

/** Healthy run: replace Items, append Changes and Runs. Unhealthy run: append Runs only, so bad data never reaches the sheet. */
export async function pushRun(config: SheetsConfig, run: RunRecord): Promise<void> {
  const call = await client(config);
  const at = dateSerial(run.runAt);
  const healthy = run.problems.length === 0;

  if (healthy) {
    await call("POST", "/values:batchClear", { ranges: ["Items!A2:Z"] });
    if (run.items.length > 0) {
      await call("POST", "/values:batchUpdate", {
        valueInputOption: "RAW",
        data: [{ range: "Items!A2", values: run.items.map((item) => itemRow(item, run, at)) }],
      });
    }
    const changes = run.isBaseline ? [] : changeRows(run, at);
    if (changes.length > 0) await append(call, "Changes!A1", changes);
  }

  await append(call, "Runs!A1", [runRow(run, at, healthy)]);
}

/** The last good run from the Snapshot tab, or null when the tab is empty (the next run is a baseline). */
export async function loadSnapshot(config: SheetsConfig, target: string): Promise<Snapshot | null> {
  const call = await client(config);
  const res = (await call("GET", `/values/${encodeURIComponent(`${SNAPSHOT_TAB}!A:A`)}`)) as { values?: string[][] };
  const [metaRow, ...itemRows] = res.values ?? [];
  if (!metaRow?.[0]) return null;

  const meta = JSON.parse(metaRow[0]) as Omit<Snapshot, "items">;
  if (meta.target !== target) {
    throw new Error(
      `The ${SNAPSHOT_TAB} tab holds "${meta.target}", not "${target}". One sheet serves one target; ` +
        `clear the ${SNAPSHOT_TAB} tab only if this sheet is meant to switch targets.`,
    );
  }
  // itemCount, not the row count, bounds the read: rows left over from a longer earlier run are ignored.
  const items = itemRows.slice(0, meta.itemCount).map((row) => JSON.parse(row[0] ?? "") as Item);
  return { ...meta, items };
}

export async function saveSnapshot(config: SheetsConfig, snapshot: Snapshot): Promise<void> {
  const call = await client(config);
  const { items, ...meta } = snapshot;
  // Metadata and items land in one request, so a failure never leaves a half-written snapshot.
  await call("POST", "/values:batchUpdate", {
    valueInputOption: "RAW",
    data: [{ range: `${SNAPSHOT_TAB}!A1`, values: [[JSON.stringify(meta)], ...items.map((item) => [JSON.stringify(item)])] }],
  });
  // Tidy only: loadSnapshot already ignores anything past itemCount.
  await call("POST", "/values:batchClear", { ranges: [`${SNAPSHOT_TAB}!A${items.length + 2}:A`] });
}

export function itemRow(item: Item, run: RunRecord, at: number): Cell[] {
  return [...run.fieldNames.map((field) => toCell(item[field] ?? "")), run.target, at];
}

export function changeRows(run: RunRecord, at: number): Cell[][] {
  const rows: Cell[][] = [];
  for (const item of run.changes.added) rows.push([at, run.target, "New", item[run.key] ?? "", "", "", ""]);
  for (const item of run.changes.removed) rows.push([at, run.target, "Removed", item[run.key] ?? "", "", "", ""]);
  for (const { key, before, after } of run.changes.changed) {
    for (const field of run.fieldNames) {
      if (before[field] !== after[field]) {
        rows.push([at, run.target, "Updated", key, field, before[field] ?? "", after[field] ?? ""]);
      }
    }
  }
  return rows;
}

function runRow(run: RunRecord, at: number, healthy: boolean): Cell[] {
  const fill = run.fieldNames.map((f) => `${f} ${Math.round((run.fillRates[f] ?? 0) * 100)}%`).join(", ");
  const counts: Cell[] = healthy && !run.isBaseline
    ? [run.changes.added.length, run.changes.removed.length, run.changes.changed.length]
    : ["", "", ""];
  const notes = !healthy
    ? run.problems.join("; ")
    : run.isBaseline ? "Baseline snapshot. Change tracking starts from the next run." : "";
  return [at, run.target, run.items.length, ...counts, fill, healthy ? "Passed" : "Failed", notes];
}

// A price-like string becomes a number so the sheet can sort and format it; everything else stays text.
function toCell(value: string): Cell {
  return /^[£$€]\s?\d[\d,]*(\.\d+)?$/.test(value) ? Number(value.replace(/[^\d.]/g, "")) : value;
}

function dateSerial(iso: string): number {
  return (Date.parse(iso) + SHEET_UTC_OFFSET_HOURS * 3_600_000) / 86_400_000 + 25569;
}

type Call = (method: string, path: string, body?: unknown) => Promise<unknown>;

// RAW input: a scraped value starting with "=" must land as text, never run as a formula.
function append(call: Call, range: string, values: Cell[][]): Promise<unknown> {
  const query = "valueInputOption=RAW&insertDataOption=OVERWRITE";
  return call("POST", `/values/${encodeURIComponent(range)}:append?${query}`, { values });
}

async function client(config: SheetsConfig): Promise<Call> {
  const token = await accessToken(config);
  return async (method, path, body) => {
    const res = await fetch(`${SHEETS_API}/${config.sheetId}${path}`, {
      method,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = (await res.json()) as { error?: { message?: string } };
    if (!res.ok) throw new Error(`Sheets ${path} → ${res.status}: ${json.error?.message ?? "unknown error"}`);
    return json;
  };
}

async function accessToken({ email, privateKey }: SheetsConfig): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ alg: "RS256", typ: "JWT" })}.${encode({
    iss: email,
    scope: "https://www.googleapis.com/auth/spreadsheets",
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  })}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");

  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const json = (await res.json()) as { access_token?: string; error?: string; error_description?: string };
  if (!res.ok || !json.access_token) {
    throw new Error(`Google sign-in failed: ${json.error_description ?? json.error ?? res.status}`);
  }
  return json.access_token;
}
