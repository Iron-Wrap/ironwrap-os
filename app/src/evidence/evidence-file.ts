import { TOO_LARGE_MESSAGE, UNSUPPORTED_MESSAGE } from "./evidence-messages";
import { EVIDENCE_MAX_BYTES, evidenceMimeTypes, type EvidenceMimeType } from "./evidence-types";

/**
 * A selected file, checked and frozen before anything is sent. The bytes are copied once, here,
 * so every retry (and a copy kept for the offline queue) carries exactly the bytes, name and type
 * that the first attempt did. The file is never resized or re-encoded: what the person picked is
 * what the office receives.
 */
export interface PreparedEvidenceFile {
  name: string;
  size: number;
  mime: EvidenceMimeType;
  /** The exact bytes, typed with the MIME declared to the Worker. */
  blob: Blob;
  lastModified?: number;
}

export type PrepareEvidenceResult =
  { ok: true; file: PreparedEvidenceFile } | { ok: false; name: string; message: string };

const SUPPORTED = new Set<string>(evidenceMimeTypes);

/** A type the device gives when it does not really know, so the file's own signature decides. */
const GENERIC_TYPES = new Set(["", "application/octet-stream", "binary/octet-stream"]);

/**
 * Other names for a type that is supported, which some Android file providers still report. Only
 * the declared name is corrected to the standard one; the bytes are not looked at or changed, and
 * the Worker checks them for itself.
 */
const TYPE_ALIASES: Record<string, EvidenceMimeType> = {
  "image/jpg": "image/jpeg",
  "image/pjpeg": "image/jpeg",
  "image/x-png": "image/png",
};

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx"]);
const HEIF_BRANDS = new Set(["mif1", "msf1"]);

/** The Worker's own signature rules (`matchesMime`), used only to name a file the device left untyped. */
export function sniffEvidenceMime(bytes: Uint8Array): EvidenceMimeType | null {
  const ascii = (start: number, end: number) => String.fromCharCode(...bytes.subarray(start, end));
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return "image/jpeg";
  }
  if (PNG_SIGNATURE.every((byte, index) => bytes[index] === byte)) return "image/png";
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") return "image/webp";
  if (ascii(0, 5) === "%PDF-") return "application/pdf";
  if (ascii(4, 8) === "ftyp") {
    const brand = ascii(8, 12);
    if (HEIC_BRANDS.has(brand)) return "image/heic";
    if (HEIF_BRANDS.has(brand)) return "image/heif";
  }
  return null;
}

const NAME_MAX = 180;
const DEFAULT_NAMES: Record<EvidenceMimeType, string> = {
  "image/jpeg": "photo.jpg",
  "image/png": "photo.png",
  "image/webp": "photo.webp",
  "image/heic": "photo.heic",
  "image/heif": "photo.heif",
  "application/pdf": "document.pdf",
};

/**
 * A name the Worker accepts: not empty, at most 180 characters, no control characters, slashes
 * or backslashes. Chosen once per file and then kept, because the name is part of what a replay
 * is compared against.
 */
export function evidenceFileName(raw: string, mime: EvidenceMimeType): string {
  // eslint-disable-next-line no-control-regex -- the Worker refuses these characters outright.
  const cleaned = raw.replace(/[\u0000-\u001f/\\]/g, "_").trim();
  if (!cleaned) return DEFAULT_NAMES[mime];
  if (cleaned.length <= NAME_MAX) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  return `${cleaned.slice(0, NAME_MAX - extension.length)}${extension}`;
}

export async function prepareEvidenceFile(file: File): Promise<PrepareEvidenceResult> {
  const name = file.name.trim() || "This file";
  if (file.size === 0) {
    return { ok: false, name, message: "This file is empty. Choose another photo or PDF." };
  }
  if (file.size > EVIDENCE_MAX_BYTES) return { ok: false, name, message: TOO_LARGE_MESSAGE };

  const declared = (file.type.split(";")[0] ?? "").trim().toLowerCase();
  let mime: EvidenceMimeType | null = null;
  if (SUPPORTED.has(declared)) {
    mime = declared as EvidenceMimeType;
  } else if (declared in TYPE_ALIASES) {
    mime = TYPE_ALIASES[declared] ?? null;
  } else if (GENERIC_TYPES.has(declared)) {
    try {
      mime = sniffEvidenceMime(new Uint8Array(await file.slice(0, 16).arrayBuffer()));
    } catch {
      return unreadable(name);
    }
  }
  if (!mime) return { ok: false, name, message: UNSUPPORTED_MESSAGE };

  let bytes: ArrayBuffer;
  try {
    bytes = await file.arrayBuffer();
  } catch {
    return unreadable(name);
  }
  if (bytes.byteLength === 0) {
    return { ok: false, name, message: "This file is empty. Choose another photo or PDF." };
  }
  if (bytes.byteLength > EVIDENCE_MAX_BYTES) return { ok: false, name, message: TOO_LARGE_MESSAGE };

  return {
    ok: true,
    file: {
      name: evidenceFileName(file.name, mime),
      size: bytes.byteLength,
      mime,
      blob: new Blob([bytes], { type: mime }),
      ...(file.lastModified ? { lastModified: file.lastModified } : {}),
    },
  };
}

function unreadable(name: string): PrepareEvidenceResult {
  return { ok: false, name, message: "We couldn't read this file. Choose it again." };
}
