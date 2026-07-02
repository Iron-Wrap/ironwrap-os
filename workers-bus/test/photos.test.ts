// Unit tests for the Jobsite-photo intake pure logic (node --test, type-stripped — no install).
import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePhotoSubmission, photoFileName } from "../src/photos.ts";
import { jobFolderName, safeSegment } from "../src/google.ts";

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
