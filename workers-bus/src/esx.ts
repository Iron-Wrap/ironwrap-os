// esx.ts - minimal ZIP reader for ESX (Xactimate) and other zip-wrapped exports.
//
// An ESX file is a small flat zip around XML. This module opens that wrapper so
// the intake pipeline can feed whatever XML is inside to the geometry verifier:
// zip bytes -> entries -> XML text -> parseAppliCadGeometry (when the payload is
// an AppliCad-format export). Reading is EOCD-based: locate the End Of Central
// Directory record, walk the central directory (its sizes are reliable even when
// local headers defer to data descriptors), slice each local entry, inflate
// deflate entries via DecompressionStream("deflate-raw") and pass stored entries
// through. Zero-dep, Workers-safe (DecompressionStream/Blob/Response are
// runtime globals in Workers and Node 18+).
//
// Nothing is silently dropped: every entry name is reported, and entries that
// cannot be extracted carry a reason.
//
// Ceilings, named:
// ponytail: no zip64, no encryption, no multi-disk; a real ESX is a small flat
//   zip, anything outside that surface returns null instead of guessing.
// ponytail: CRC32 is not checked; integrity of the payload that matters is
//   re-derived downstream by the geometry recompute (needs_review on deviation).
// ponytail: entry names decoded as UTF-8 regardless of the cp437 flag.

import { isAppliCadXml } from "./geometry.ts";

export interface ZipEntry { name: string; bytes: Uint8Array }
export interface ZipSkipped { name: string; reason: string }
export interface ZipContents { files: ZipEntry[]; skipped: ZipSkipped[] }

export interface EsxExtraction {
  /** Every entry name in the archive, extracted or not (evidence inventory). */
  entries: string[];
  skipped: ZipSkipped[];
  xmlEntries: { name: string; text: string }[];
  /** First XML entry our verifier recognizes; feed .text to parseAppliCadGeometry. */
  appliCadXml: { name: string; text: string } | null;
}

const EOCD_SIG = 0x06054b50;
const CDIR_SIG = 0x02014b50;
const LOCAL_SIG = 0x04034b50;
const MAX_ENTRY_BYTES = 32 * 1024 * 1024;

export function isZip(bytes: Uint8Array): boolean {
  return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04;
}

async function inflateRaw(data: Uint8Array): Promise<Uint8Array | null> {
  try {
    // Copy the view: Blob may retain the source, and the slice must not pin the whole archive.
    const stream = new Blob([new Uint8Array(data)]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch {
    return null;
  }
}

/** Open a flat zip. Returns null when the container itself cannot be trusted. */
export async function unzip(bytes: Uint8Array): Promise<ZipContents | null> {
  if (!isZip(bytes)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // EOCD sits within the trailing 64KB comment window.
  let eocd = -1;
  const stop = Math.max(0, bytes.length - 22 - 65535);
  for (let i = bytes.length - 22; i >= stop; i--) {
    if (view.getUint32(i, true) === EOCD_SIG) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const entryCount = view.getUint16(eocd + 10, true);
  const cdOffset = view.getUint32(eocd + 16, true);
  if (cdOffset >= bytes.length) return null;

  const decoder = new TextDecoder();
  const files: ZipEntry[] = [];
  const skipped: ZipSkipped[] = [];
  let p = cdOffset;
  for (let n = 0; n < entryCount; n++) {
    if (p + 46 > bytes.length || view.getUint32(p, true) !== CDIR_SIG) return null;
    const method = view.getUint16(p + 10, true);
    const compSize = view.getUint32(p + 20, true);
    const uncompSize = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const localOffset = view.getUint32(p + 42, true);
    const name = decoder.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;

    if (name.endsWith("/")) continue; // directory marker
    if (uncompSize > MAX_ENTRY_BYTES || compSize > MAX_ENTRY_BYTES) {
      skipped.push({ name, reason: `entry exceeds ${MAX_ENTRY_BYTES} bytes` });
      continue;
    }
    if (localOffset + 30 > bytes.length || view.getUint32(localOffset, true) !== LOCAL_SIG) {
      skipped.push({ name, reason: "bad local header" });
      continue;
    }
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    if (dataStart + compSize > bytes.length) {
      skipped.push({ name, reason: "entry data out of bounds" });
      continue;
    }
    const raw = bytes.subarray(dataStart, dataStart + compSize);
    if (method === 0) {
      files.push({ name, bytes: raw });
    } else if (method === 8) {
      const inflated = await inflateRaw(raw);
      if (inflated === null) skipped.push({ name, reason: "deflate stream failed" });
      else files.push({ name, bytes: inflated });
    } else {
      skipped.push({ name, reason: `unsupported compression method ${method}` });
    }
  }
  return { files, skipped };
}

/** Looks like text markup once BOM/whitespace is stripped. */
function sniffXml(name: string, text: string): boolean {
  return /\.xml$/i.test(name) || text.replace(/^﻿/, "").trimStart().startsWith("<");
}

/** Unwrap a zip export and surface any XML payloads for the geometry verifier. */
export async function extractZipXml(bytes: Uint8Array): Promise<EsxExtraction | null> {
  const zip = await unzip(bytes);
  if (!zip) return null;
  const decoder = new TextDecoder();
  const xmlEntries: { name: string; text: string }[] = [];
  let appliCadXml: { name: string; text: string } | null = null;
  const entries: string[] = [];
  for (const f of zip.files) {
    entries.push(f.name);
    const text = decoder.decode(f.bytes);
    if (!sniffXml(f.name, text)) continue;
    xmlEntries.push({ name: f.name, text });
    if (!appliCadXml && isAppliCadXml(text)) appliCadXml = { name: f.name, text };
  }
  for (const s of zip.skipped) entries.push(s.name);
  return { entries, skipped: zip.skipped, xmlEntries, appliCadXml };
}
