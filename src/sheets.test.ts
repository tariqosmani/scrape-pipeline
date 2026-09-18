import { test } from "node:test";
import assert from "node:assert/strict";
import { createSign, createVerify, generateKeyPairSync } from "node:crypto";
import { normalizePrivateKey } from "./sheets.ts";

// Re-signs and verifies against the real public key for each paste shape, not just that parsing
// doesn't throw — a shape that "parses" into the wrong bytes would fail silently at Google instead.
test("normalizePrivateKey survives every paste shape a dashboard can mangle a PEM into", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();

  const shapes: Record<string, string> = {
    clean: pem,
    quoted: `"${pem}"`,
    literalEscapes: pem.replace(/\n/g, "\\n"),
    crlf: pem.replace(/\n/g, "\r\n"),
    collapsed: pem.replace(/\n/g, ""), // the shape that broke Production: no line breaks survive at all
  };

  for (const [shape, mangled] of Object.entries(shapes)) {
    const normalized = normalizePrivateKey(mangled);
    assert.ok(normalized, `${shape}: normalizePrivateKey returned undefined`);

    const signature = createSign("RSA-SHA256").update("check").sign(normalized!, "base64");
    const verified = createVerify("RSA-SHA256").update("check").verify(publicPem, signature, "base64");
    assert.equal(verified, true, `${shape}: signature did not verify against the real public key`);
  }
});

test("normalizePrivateKey returns undefined for a missing or unrecognizable key", () => {
  assert.equal(normalizePrivateKey(undefined), undefined);
  assert.equal(normalizePrivateKey("not a key"), undefined);
});
