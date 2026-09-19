import books from "../targets/books.json" with { type: "json" };
import ecbRates from "../targets/ecb-rates.json" with { type: "json" };
import quotes from "../targets/quotes.json" with { type: "json" };
import { parseTarget, type Target } from "./config.ts";

// Imported into the bundle, not read from disk: a deployed Trigger.dev run has no targets/ folder.
// A new site is a JSON file in targets/ plus one line here.
export const targets: Target[] = [
  parseTarget(books, "targets/books.json"),
  parseTarget(quotes, "targets/quotes.json"),
  parseTarget(ecbRates, "targets/ecb-rates.json"),
];
