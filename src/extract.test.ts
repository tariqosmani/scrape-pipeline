import { test } from "node:test";
import assert from "node:assert/strict";
import { parseTarget } from "./config.ts";
import { extractPage } from "./extract.ts";
import { itemRow, type RunRecord } from "./sheets.ts";

// The shape of the ECB's eurofxref-daily.xml: values are attributes on the item element itself, and the
// capitalised tag name only matches in XML mode.
const ECB_XML = `<?xml version="1.0" encoding="UTF-8"?>
<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">
  <gesmes:subject>Reference rates</gesmes:subject>
  <Cube><Cube time='2026-09-18'>
    <Cube currency='USD' rate='1.1460'/>
    <Cube currency='JPY' rate='180.94'/>
  </Cube></Cube>
</gesmes:Envelope>`;

const ecb = parseTarget(
  {
    name: "ecb-rates",
    format: "xml",
    startUrl: "https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml",
    userAgent: "test",
    itemSelector: "Cube[currency]",
    fields: { currency: { attr: "currency" }, rate: { attr: "rate" } },
    key: "currency",
  },
  "test",
);

test("an XML target reads attributes from the item element itself", () => {
  const { items } = extractPage(ECB_XML, ecb.startUrl, ecb);
  assert.deepEqual(items, [
    { currency: "USD", rate: "1.1460" },
    { currency: "JPY", rate: "180.94" },
  ]);
});

test("an HTML target still reads fields through their selectors", () => {
  const html = `<div class="q"><span class="t">Hello</span><meta class="k" content="a,b"></div>`;
  const target = parseTarget(
    {
      name: "html-test",
      startUrl: "https://example.com/",
      userAgent: "test",
      itemSelector: "div.q",
      fields: { text: { selector: "span.t" }, tags: { selector: "meta.k", attr: "content" } },
      key: "text",
    },
    "test",
  );
  assert.deepEqual(extractPage(html, target.startUrl, target).items, [{ text: "Hello", tags: "a,b" }]);
});

test("sheet cells: prices and decimals become numbers, whole numbers stay text", () => {
  const run = { fieldNames: ["v"], target: "t" } as unknown as RunRecord;
  const cell = (v: string) => itemRow({ v }, run, 0)[0];
  assert.equal(cell("£51.77"), 51.77);
  assert.equal(cell("1.1460"), 1.146);
  assert.equal(cell("1984"), "1984");
  assert.equal(cell("“A quote.”"), "“A quote.”");
});
