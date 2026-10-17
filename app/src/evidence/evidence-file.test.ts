import { describe, expect, it } from "vitest";

import { evidenceFileName, prepareEvidenceFile, sniffEvidenceMime } from "./evidence-file";
import { TOO_LARGE_MESSAGE, UNSUPPORTED_MESSAGE } from "./evidence-messages";
import { EVIDENCE_MAX_BYTES } from "./evidence-types";
import { evidenceFile } from "./evidence-test-harness";

const bytesOf = (...values: number[]) => new Uint8Array(values);
const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

describe("sniffEvidenceMime", () => {
  it.each([
    ["JPEG", bytesOf(255, 216, 255, 224, 0, 16), "image/jpeg"],
    ["PNG", bytesOf(137, 80, 78, 71, 13, 10, 26, 10, 0), "image/png"],
    ["WebP", bytesOf(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WEBP")), "image/webp"],
    ["PDF", bytesOf(...ascii("%PDF-1.7")), "application/pdf"],
    ["HEIC", bytesOf(0, 0, 0, 24, ...ascii("ftyp"), ...ascii("heic")), "image/heic"],
    ["HEIC (heix brand)", bytesOf(0, 0, 0, 24, ...ascii("ftyp"), ...ascii("heix")), "image/heic"],
    ["HEIF", bytesOf(0, 0, 0, 24, ...ascii("ftyp"), ...ascii("mif1")), "image/heif"],
  ] as const)("names a %s from its signature", (_label, bytes, expected) => {
    expect(sniffEvidenceMime(bytes)).toBe(expected);
  });

  it.each([
    ["an empty file", bytesOf()],
    ["plain text", bytesOf(...ascii("hello world, not a photo"))],
    ["a GIF", bytesOf(...ascii("GIF89a"), 0, 0, 0, 0, 0, 0)],
    ["an MP4 (ftyp with a video brand)", bytesOf(0, 0, 0, 24, ...ascii("ftyp"), ...ascii("isom"))],
    ["a RIFF file that is not WebP", bytesOf(...ascii("RIFF"), 0, 0, 0, 0, ...ascii("WAVE"))],
  ])("does not guess at %s", (_label, bytes) => {
    expect(sniffEvidenceMime(bytes)).toBeNull();
  });
});

describe("prepareEvidenceFile", () => {
  it("keeps a declared supported type as declared and never re-encodes the bytes", async () => {
    const file = evidenceFile("roof-south.jpg", "image/jpeg");
    const result = await prepareEvidenceFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file).toMatchObject({
      name: "roof-south.jpg",
      mime: "image/jpeg",
      size: file.size,
    });
    expect(result.file.blob.type).toBe("image/jpeg");
    expect(new Uint8Array(await result.file.blob.arrayBuffer())).toEqual(
      new Uint8Array(await file.arrayBuffer()),
    );
  });

  it("leaves a mismatch between a declared type and the bytes for the Worker to refuse", async () => {
    const result = await prepareEvidenceFile(evidenceFile("odd.png", "image/png", "image/jpeg"));
    expect(result.ok && result.file.mime).toBe("image/png");
  });

  it.each([
    ["image/jpg", "image/jpeg"],
    ["image/pjpeg", "image/jpeg"],
    ["image/x-png", "image/png"],
  ])(
    "corrects the name of %s to %s without reading or changing the bytes",
    async (declared, standard) => {
      // The bytes here are a PDF's: the Worker, not the browser, decides whether they fit the type.
      const file = evidenceFile("from-an-android-gallery", declared, "application/pdf");
      const result = await prepareEvidenceFile(file);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.file.mime).toBe(standard);
      expect(result.file.blob.type).toBe(standard);
      expect(new Uint8Array(await result.file.blob.arrayBuffer())).toEqual(
        new Uint8Array(await file.arrayBuffer()),
      );
    },
  );

  it.each([
    ["an empty type", "", "image/heic", "image/heic"],
    ["a generic type", "application/octet-stream", "application/pdf", "application/pdf"],
    ["another generic type", "binary/octet-stream", "image/png", "image/png"],
  ] as const)("names a file with %s from its signature", async (_label, type, signature, mime) => {
    const result = await prepareEvidenceFile(evidenceFile("IMG_0001", type, signature));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.file.mime).toBe(mime);
    expect(result.file.blob.type).toBe(mime);
  });

  it("refuses an untyped file whose bytes are not a photo or PDF", async () => {
    const file = new File([new Uint8Array(ascii("just some text, nothing else"))], "notes", {
      type: "",
    });
    expect(await prepareEvidenceFile(file)).toEqual({
      ok: false,
      name: "notes",
      message: UNSUPPORTED_MESSAGE,
    });
  });

  it("does not look inside a file the device typed as something else", async () => {
    const gif = evidenceFile("loop.gif", "image/gif", "image/jpeg");
    expect(await prepareEvidenceFile(gif)).toMatchObject({
      ok: false,
      message: UNSUPPORTED_MESSAGE,
    });
  });

  it("refuses an empty file before reading it", async () => {
    expect(await prepareEvidenceFile(new File([], "empty.jpg", { type: "image/jpeg" }))).toEqual({
      ok: false,
      name: "empty.jpg",
      message: "This file is empty. Choose another photo or PDF.",
    });
  });

  it("accepts a file of exactly 8 MiB and refuses one byte more, for photos and PDFs alike", async () => {
    const atLimit = new File([new Uint8Array(EVIDENCE_MAX_BYTES)], "limit.jpg", {
      type: "image/jpeg",
    });
    expect((await prepareEvidenceFile(atLimit)).ok).toBe(true);
    for (const [name, type] of [
      ["too-big.jpg", "image/jpeg"],
      ["too-big.pdf", "application/pdf"],
    ] as const) {
      const over = new File([new Uint8Array(EVIDENCE_MAX_BYTES + 1)], name, { type });
      expect(await prepareEvidenceFile(over)).toEqual({
        ok: false,
        name,
        message: TOO_LARGE_MESSAGE,
      });
    }
    expect(TOO_LARGE_MESSAGE).toBe(
      "This file is too large (max 8 MB). Choose a smaller photo or PDF.",
    );
  });
});

describe("evidenceFileName", () => {
  it("keeps an ordinary name", () => {
    expect(evidenceFileName("IMG_2041.HEIC", "image/heic")).toBe("IMG_2041.HEIC");
  });

  it("replaces characters the Worker refuses and trims the result", () => {
    expect(evidenceFileName("  south/eave\\photo\u0007.jpg ", "image/jpeg")).toBe(
      "south_eave_photo_.jpg",
    );
  });

  it("names a nameless file after its type", () => {
    expect(evidenceFileName("   ", "application/pdf")).toBe("document.pdf");
    expect(evidenceFileName("", "image/webp")).toBe("photo.webp");
  });

  it("shortens a long name to 180 characters and keeps the extension", () => {
    const name = evidenceFileName(`${"a".repeat(300)}.jpeg`, "image/jpeg");
    expect(name).toHaveLength(180);
    expect(name.endsWith(".jpeg")).toBe(true);
  });
});
