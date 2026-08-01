// Proposal-doc action tests: auth, CSRF, config gates, payload contract, and a
// full happy path against a mocked Google surface (real RSA key so the token
// mint exercises the production signing code). Fixtures synthetic throughout.
import assert from "node:assert/strict";
import { test } from "node:test";
import { handleProposalDocAction, parseProposalDocRequest } from "../src/proposal-doc-action.ts";
import type { AppRole, AuthContext } from "../src/app-types.ts";

function auth(role: AppRole): AuthContext {
  return {
    rawSessionToken: "s".repeat(43),
    csrfToken: "csrf",
    permissions: role === "field" ? ["session:read"] : ["session:read", "estimator:read"],
    session: {
      session_hash: "a".repeat(64),
      session_created_at: "2026-08-01T12:00:00.000Z",
      session_expires_at: "2026-08-02T12:00:00.000Z",
      revoked_at: null,
      user_id: `appu_${role}`,
      tenant_id: "ironwrap",
      email_normalized: `${role}@example.com`,
      display_name: role,
      role,
      frappe_user_id: "ops@example.com",
      active: 1,
      created_by: "owner@example.com",
      created_at: "2026-08-01T12:00:00.000Z",
      updated_at: "2026-08-01T12:00:00.000Z",
      device_id: null,
      device_proof_hash: null,
    },
  };
}

function request(body: unknown, csrf = "csrf"): Request {
  return new Request("https://bus.example/api/v1/estimator/proposal-doc", {
    method: "POST",
    headers: { "content-type": "application/json", "x-csrf-token": csrf },
    body: JSON.stringify(body),
  });
}

async function syntheticServiceAccount(): Promise<string> {
  const keys = await crypto.subtle.generateKey(
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", keys.privateKey));
  let bin = "";
  for (const byte of pkcs8) bin += String.fromCharCode(byte);
  const pem = `-----BEGIN PRIVATE KEY-----\n${btoa(bin)}\n-----END PRIVATE KEY-----`;
  return JSON.stringify({ client_email: "sa@example.invalid", private_key: pem });
}

test("proposal-doc: payload contract accepts bounded shapes and rejects junk", () => {
  assert.ok(parseProposalDocRequest({ job_number: "26-0007", replacements: { total: 3257.1, customer_name: "Dana" } }));
  assert.equal(parseProposalDocRequest({}), null);
  assert.equal(parseProposalDocRequest({ job_number: "x".repeat(200) }), null);
  assert.equal(parseProposalDocRequest({ job_number: "26-1", replacements: { "bad key!": "v" } }), null);
  assert.equal(parseProposalDocRequest({ job_number: "26-1", replacements: { note: { nested: true } } }), null);
});

test("proposal-doc: permission, CSRF, and configuration gates fire in order", async () => {
  const env = {} as never;
  const forbidden = await handleProposalDocAction(request({ job_number: "26-1" }), env, auth("field"));
  assert.equal(forbidden.status, 403);
  const badCsrf = await handleProposalDocAction(request({ job_number: "26-1" }, "wrong"), env, auth("ops"));
  assert.equal(badCsrf.status, 403);
  const unconfigured = await handleProposalDocAction(request({ job_number: "26-1" }), env, auth("ops"));
  assert.equal(unconfigured.status, 503);
  assert.deepEqual(await unconfigured.json(), { error: "proposal_doc_not_configured" });
});

test("proposal-doc: happy path copies the template, merges, and audits", async (t) => {
  const audits: unknown[] = [];
  const env = {
    GOOGLE_SERVICE_ACCOUNT_JSON: await syntheticServiceAccount(),
    SHARED_DRIVE_ID_JOBS: "drive-jobs",
    FROM_EMAIL: "sales@example.invalid",
    PROPOSAL_TEMPLATE_DOC_ID: "template-doc-1",
    DB: {
      prepare: () => ({
        bind: (...args: unknown[]) => ({
          run: async () => {
            audits.push(args);
            return { success: true, meta: { changes: 1 } };
          },
        }),
      }),
    },
  } as never;

  const fetches: string[] = [];
  t.mock.method(globalThis, "fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    fetches.push(url);
    if (url.startsWith("https://oauth2.googleapis.com/token"))
      return Response.json({ access_token: "tok" });
    if (url.includes("/drive/v3/files?q=")) {
      // First lookup: job folder search; second: contract subfolder search.
      const q = decodeURIComponent(url);
      if (q.includes("05 Contract %26 Estimates") || q.includes("05 Contract & Estimates"))
        return Response.json({ files: [{ id: "folder-contract" }] });
      return Response.json({ files: [{ id: "folder-job", name: "26-0007 Dana" }] });
    }
    if (url.includes("/drive/v3/files/template-doc-1/copy"))
      return Response.json({ id: "doc-new", webViewLink: "https://docs.google.com/document/d/doc-new" });
    if (url.includes("docs.googleapis.com/v1/documents/doc-new:batchUpdate")) {
      const body = JSON.parse(String(init?.body));
      assert.equal(body.requests[0].replaceAllText.containsText.text, "{{customer_name}}");
      return Response.json({ replies: [] });
    }
    throw new Error(`unexpected fetch ${url}`);
  });

  const response = await handleProposalDocAction(
    request({ job_number: "26-0007", customer: "Dana Example", title: "Metal re-roof", replacements: { customer_name: "Dana Example", total: 3257.1 } }),
    env,
    auth("ops"),
  );
  assert.equal(response.status, 200);
  const body = (await response.json()) as { doc_id: string; url: string; folder_id: string };
  assert.equal(body.doc_id, "doc-new");
  assert.equal(body.folder_id, "folder-contract");
  assert.equal(audits.length, 1); // one audit row recorded
  assert.ok(fetches.some((u) => u.includes(":batchUpdate")));
});
