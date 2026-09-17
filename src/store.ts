import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Item } from "./extract.ts";

export type Snapshot = {
  target: string;
  runAt: string;
  itemCount: number;
  fillRates: Record<string, number>;
  items: Item[];
};

export type Diff = {
  added: Item[];
  removed: Item[];
  changed: { key: string; before: Item; after: Item }[];
};

const dataDir = path.resolve(import.meta.dirname, "..", "data");
const snapshotPath = (target: string) => path.join(dataDir, `${target}.json`);

export async function loadPrevious(target: string): Promise<Snapshot | null> {
  try {
    return JSON.parse(await readFile(snapshotPath(target), "utf8")) as Snapshot;
  } catch {
    return null;
  }
}

export async function save(snapshot: Snapshot): Promise<string> {
  await mkdir(dataDir, { recursive: true });
  const file = snapshotPath(snapshot.target);
  await writeFile(file, JSON.stringify(snapshot, null, 2));
  return file;
}

export function diff(previous: Item[], current: Item[], key: string): Diff {
  const index = (items: Item[]) => new Map(items.map((item) => [item[key] ?? "", item]));
  const before = index(previous);
  const after = index(current);

  const result: Diff = { added: [], removed: [], changed: [] };

  for (const [id, item] of after) {
    const prior = before.get(id);
    if (!prior) result.added.push(item);
    else if (JSON.stringify(prior) !== JSON.stringify(item)) {
      result.changed.push({ key: id, before: prior, after: item });
    }
  }
  for (const [id, item] of before) {
    if (!after.has(id)) result.removed.push(item);
  }

  return result;
}
