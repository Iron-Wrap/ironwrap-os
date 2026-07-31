// ESX/zip wrapper tests: archives are built in-test (synthetic by construction)
// so the reader is proven against exact bytes, then end-to-end into the
// geometry verifier using the sanitized AppliCad fixture.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { deflateRawSync } from "node:zlib";
import { parseAppliCadGeometry } from "../src/geometry.ts";
import { extractZipXml, isZip, unzip } from "../src/esx.ts";

const SAMPLE = readFileSync(
  fileURLToPath(new URL("../../tools/fixtures/synthetic-applicad-roof.xml", import.meta.url)),
  "utf8",
);

/** Build a flat zip: local headers + central directory + EOCD. CRC left 0 (reader ignores it). */
function makeZip(entries: { name: string; data: Buffer; method?: number }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const method = e.method ?? 8;
    const comp = method === 8 ? deflateRawSync(e.data) : e.data;
    const name = Buffer.from(e.name, "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(e.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    locals.push(local, name, comp);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(comp.length, 20);
    central.writeUInt32LE(e.data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.length + comp.length;
  }
  const cdSize = centrals.reduce((s, b) => s + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, eocd]);
}

test("esx: zip-wrapped AppliCad XML goes end-to-end into verified geometry", async () => {
  const zip = makeZip([
    { name: "reports/", data: Buffer.alloc(0), method: 0 },
    { name: "reports/summary.pdf", data: Buffer.from("%PDF-1.7 not xml") },
    { name: "reports/roof.xml", data: Buffer.from(SAMPLE) },
  ]);
  assert.equal(isZip(zip), true);
  const x = (await extractZipXml(zip))!;
  assert.deepEqual(x.skipped, []);
  assert.equal(x.entries.length, 2); // directory marker excluded
  assert.equal(x.xmlEntries.length, 1);
  assert.equal(x.appliCadXml?.name, "reports/roof.xml");
  // The unwrapped payload must survive the full verification pipeline.
  const g = parseAppliCadGeometry(x.appliCadXml!.text)!;
  assert.equal(g.needsReview, false);
  assert.equal(g.measurements.roof_area, 1942.68);
});

test("esx: stored (uncompressed) entries round-trip byte-exact", async () => {
  const body = Buffer.from("<APPLICAD_EXPORT><POINT id=\"P1\" data=\"0,0,0\"/></APPLICAD_EXPORT>");
  const zip = makeZip([{ name: "stored.xml", data: body, method: 0 }]);
  const z = (await unzip(zip))!;
  assert.equal(z.files.length, 1);
  assert.deepEqual(Buffer.from(z.files[0].bytes), body);
});

test("esx: unsupported compression is reported, never silently dropped", async () => {
  const zip = makeZip([
    { name: "weird.bin", data: Buffer.from("opaque"), method: 99 },
    { name: "ok.xml", data: Buffer.from("<a/>") },
  ]);
  const x = (await extractZipXml(zip))!;
  assert.equal(x.xmlEntries.length, 1);
  assert.deepEqual(x.skipped, [{ name: "weird.bin", reason: "unsupported compression method 99" }]);
  assert.ok(x.entries.includes("weird.bin"));
});

test("esx: non-zip and structurally broken bytes return null", async () => {
  assert.equal(await unzip(Buffer.from(SAMPLE)), null);
  assert.equal(await extractZipXml(Buffer.from("{}")), null);
  // Correct magic but no EOCD anywhere: refuse instead of guessing.
  const junk = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 7)]);
  assert.equal(await unzip(junk), null);
});
