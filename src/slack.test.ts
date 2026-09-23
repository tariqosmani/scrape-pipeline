import { test } from "node:test";
import assert from "node:assert/strict";
import type { RunRecord } from "./sheets.ts";
import { digest } from "./slack.ts";

const rate = (currency: string, value: string, note = "") => ({ currency, rate: value, note });

function run(changed: [string, string, string?][], alerts = { minChangePct: 0, ignore: [] as string[] }): RunRecord {
  return {
    target: "ecb-rates",
    runAt: "",
    label: "currency",
    alerts,
    fieldNames: ["currency", "rate", "note"],
    items: [],
    fillRates: {},
    isBaseline: false,
    problems: [],
    changes: {
      added: [],
      removed: [],
      changed: changed.map(([currency, before, after]) => ({
        key: currency,
        before: rate(currency, before),
        after: after === undefined ? rate(currency, before, "revised") : rate(currency, after),
      })),
    },
  };
}

test("an alert threshold lists only big moves, biggest first, and counts the rest as minor", () => {
  const text = digest(
    run([["USD", "1.1460", "1.1463"], ["HUF", "364.28", "361.58"], ["TRY", "£55.00", "£56.10"]], { minChangePct: 0.5, ignore: [] }),
    null,
    null,
  );
  assert.equal(
    text,
    [
      "ecb-rates: 0 new, 0 removed, 3 updated",
      "",
      "Updated: TRY: rate £55.00 → £56.10 (+2.0%)",
      "Updated: HUF: rate 364.28 → 361.58 (−0.74%)",
      "…plus 1 minor update, listed in the Sheet",
    ].join("\n"),
  );
});

test("only minor or ignored updates send no alert, but a text change always does", () => {
  assert.equal(digest(run([["USD", "1.1460", "1.1463"]], { minChangePct: 0.5, ignore: [] }), null, null), null);
  assert.equal(digest(run([["USD", "1.1460"]], { minChangePct: 0, ignore: ["note"] }), null, null), null);
  assert.match(digest(run([["USD", "1.1460"]], { minChangePct: 50, ignore: [] }), null, null) ?? "", /note  → revised/);
});
