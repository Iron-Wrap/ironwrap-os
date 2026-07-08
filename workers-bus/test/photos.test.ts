// Unit tests for the Jobsite-photo intake pure logic (node --test, type-stripped — no install).
import { test } from "node:test";
import assert from "node:assert/strict";
import { handlePhotoIngest, parsePhotoSubmission, photoFileName } from "../src/photos.ts";
import { jobFolderName, safeSegment } from "../src/google.ts";
import { isVoiceNoteUri } from "../src/core.ts";

test("parsePhotoSubmission: normalized shape", () => {
  const s = parsePhotoSubmission({
    job_number: "JN-1234",
    photos: ["https://x.com/a.jpg", "https://x.com/b.png"],
    caption: "north wall",
  });
  assert.equal(s.jobNumber, "JN-1234");
  assert.deepEqual(s.photos, ["https://x.com/a.jpg", "https://x.com/b.png"]);
  assert.equal(s.caption, "north wall");
});

test("parsePhotoSubmission: Jotform-ish aliases + URL-scan fallback + numeric job", () => {
  const s = parsePhotoSubmission({
    jobnimbus_job: 5512,                                  // number coerced to string
    q5_upload: "https://www.jotform.com/uploads/u/f/s/IMG_1.heic", // found by fallback scan
    notes: "leak at valley",
  });
  assert.equal(s.jobNumber, "5512");
  assert.deepEqual(s.photos, ["https://www.jotform.com/uploads/u/f/s/IMG_1.heic"]);
  assert.equal(s.caption, "leak at valley");
});

test("parsePhotoSubmission: keyed photos win; no stray non-file URLs; deduped", () => {
  const s = parsePhotoSubmission({
    job: "J9",
    website: "https://ironwrap.com",                      // ignored (photos found via keyed pass)
    photos: ["https://x/a.jpg", "https://x/a.jpg"],       // dup collapses
  });
  assert.deepEqual(s.photos, ["https://x/a.jpg"]);
});

test("parsePhotoSubmission: missing job number / no photos", () => {
  assert.equal(parsePhotoSubmission({ photos: ["https://x/a.jpg"] }).jobNumber, null);
  assert.deepEqual(parsePhotoSubmission({ job_number: "J1" }).photos, []);
});

test("parsePhotoSubmission: field voice notes and transcripts (gate 9)", () => {
  const s = parsePhotoSubmission({
    job_number: "J9",
    voice_note: "https://www.jotform.com/uploads/u/f/s/note.m4a",
    transcript: "valley flashing installed, need more screws tomorrow",
  });
  assert.deepEqual(s.photos, ["https://www.jotform.com/uploads/u/f/s/note.m4a"]);
  assert.equal(s.caption, "valley flashing installed, need more screws tomorrow");

  // Audio URL found by the fallback scan when no keyed match exists.
  const fallback = parsePhotoSubmission({ job: "J9", q9_misc: "https://x/files/memo.mp3" });
  assert.deepEqual(fallback.photos, ["https://x/files/memo.mp3"]);

  assert.equal(isVoiceNoteUri("https://x/uploads/note.m4a?t=1"), true);
  assert.equal(isVoiceNoteUri("https://x/uploads/roof.jpg"), false);
});

test("photoFileName: extension from URL, then content-type, then jpg default", () => {
  assert.equal(photoFileName("JN-1", 0, "https://x/IMG.JPG?t=1", "image/jpeg"), "JN-1-photo-01.jpg");
  assert.equal(photoFileName("JN-1", 9, "https://x/no-ext", "image/png"), "JN-1-photo-10.png");
  assert.equal(photoFileName("JN-1", 0, "https://x/no-ext", ""), "JN-1-photo-01.jpg");
});

test("safeSegment + jobFolderName", () => {
  assert.equal(safeSegment("JN/12\\34"), "JN_12_34");                     // slashes sanitized (Drive names)
  assert.equal(jobFolderName("1008", "John Smith", "IW"), "1008 John Smith (IW)");
  assert.equal(jobFolderName("1008"), "1008");                            // number-only fallback
  assert.equal(jobFolderName("1008", null, "iroof"), "1008 (iroof)");     // brand without customer
});

test("handlePhotoIngest: raw capture plus ERPNext photo Evidence Item sync without Drive", async (t) => {
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetches.push({ url, init: init ?? {} });
    if (url.includes("/api/resource/Roof%20Job?")) return json({ data: [{ name: "RJ-0001" }] });
    if (url.includes("/api/resource/Evidence%20Item?")) return json({ data: [] });
    if (url.includes("/api/resource/Field%20Check-in?")) return json({ data: [] });
    if (url.endsWith("/api/resource/Evidence%20Item")) {
      return json({ data: { name: `EV-000${fetches.filter((f) => f.url.endsWith("/api/resource/Evidence%20Item")).length}` } });
    }
    if (url.endsWith("/api/resource/Field%20Check-in")) return json({ data: { name: "FCI-0001" } });
    throw new Error(`unexpected fetch ${url}`);
  });

  const writes: Array<{ sql: string; args: unknown[] }> = [];
  const rawWrites: Array<{ key: string; body: string }> = [];
  const env = {
    ERPNEXT_ENABLED: "true",
    ERPNEXT_BASE_URL: "https://erp.example.com",
    ERPNEXT_API_KEY: "erp-key",
    ERPNEXT_API_SECRET: "erp-secret",
    RAW: { put: async (key: string, body: string) => { rawWrites.push({ key, body }); } },
    DB: {
      prepare(sql: string) {
        return {
          bind(...args: unknown[]) {
            return { run: async () => { writes.push({ sql, args }); return { success: true }; } };
          },
        };
      },
    },
  };

  const res = await handlePhotoIngest(env as never, JSON.stringify({
    job_number: "26-0001",
    photos: ["https://jotform.example/uploads/a.jpg", "https://jotform.example/uploads/b.png"],
    caption: "north wall progress",
  }), "application/json");
  const body = await res.json() as {
    erpnext_evidence_ids?: string[];
    erpnext_field_check_in_id?: string;
    erpnext_error?: string | null;
    uploaded?: number;
    note?: string;
  };

  assert.equal(res.status, 200);
  assert.equal(body.uploaded, 0);
  assert.equal(body.erpnext_error, null);
  assert.deepEqual(body.erpnext_evidence_ids, ["EV-0001", "EV-0002"]);
  assert.equal(body.erpnext_field_check_in_id, "FCI-0001");
  assert.match(body.note ?? "", /drive_not_configured/);
  assert.equal(rawWrites.length, 1);
  assert.match(rawWrites[0].key, /^raw\/photos\/\d{4}-\d{2}-\d{2}\/ow_/);

  const evidenceBodies = fetches
    .filter((f) => f.url.endsWith("/api/resource/Evidence%20Item"))
    .map((f) => JSON.parse(String(f.init.body)));
  assert.equal(evidenceBodies.length, 2);
  assert.ok(evidenceBodies.every((e) => e.roof_job === "RJ-0001"));
  assert.ok(evidenceBodies.every((e) => e.evidence_type === "Photo"));
  assert.ok(evidenceBodies.every((e) => e.source_system === "Jotform"));
  assert.ok(evidenceBodies.every((e) => e.customer_safe === 0));
  assert.ok(evidenceBodies[0].evidence_id.startsWith("evidence:photo:ow_"));
  assert.equal(evidenceBodies[0].source_uri, "https://jotform.example/uploads/a.jpg");
  assert.equal(evidenceBodies[0].summary.includes("north wall progress"), true);

  const checkIn = JSON.parse(String(fetches.find((f) => f.url.endsWith("/api/resource/Field%20Check-in"))?.init.body));
  assert.ok(checkIn.checkin_id.startsWith("field:ow_"));
  assert.equal(checkIn.roof_job, "RJ-0001");
  assert.equal(checkIn.job_number, "26-0001");
  assert.equal(checkIn.source_system, "Jotform");
  assert.equal(checkIn.status, "Received");
  assert.equal(checkIn.photo_count, 2);
  assert.deepEqual(JSON.parse(checkIn.evidence_ids_json), ["EV-0001", "EV-0002"]);
  assert.equal(checkIn.notes, "north wall progress");
  assert.match(checkIn.raw_key, /^raw\/photos\/\d{4}-\d{2}-\d{2}\/ow_/);
  assert.ok(writes.some((w) => w.sql.includes("INSERT INTO audit_log") &&
    w.args.includes("erpnext_photo") &&
    w.args.includes("evidence_item:EV-0001,evidence_item:EV-0002,field_check_in:FCI-0001")));
});

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}
