import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { test } from "node:test";
import {
  previewProposalPublicationApproval,
  ProposalPublicationApprovalBrokerError,
} from "../src/proposal-publication-approval-broker-client.ts";
import type { AppEnv } from "../src/app-types.ts";

// Publishing a proposal is the step that makes quote terms customer-visible, so
// the Worker never writes it directly: it asks a private broker, and the only
// thing it learns about a refusal is what that broker's answer says. These tests
// pin the distinction the answer has to carry - the broker decided against this
// request, versus the broker could not be reached at all (ELEC-95 process risk 3).

const NOW = Date.parse("2026-08-20T10:00:00.000Z");
const TENANT = "ironwrap";
const KEY_ID = "proposal-publication-test-key";
const SHARED_SECRET = "proposal-publication-broker-shared-secret-for-test-0001";
const NONCE = "n".repeat(32);
const PREVIEW_PATH = "/v1/proposal-publication/preview";

function env(timeoutMs = "5000"): AppEnv {
  return {
    APP_ALLOW_INSECURE_LOCAL: "true",
    APP_PROPOSAL_PUBLICATION_BROKER_URL: "http://127.0.0.1:9104",
    APP_PROPOSAL_PUBLICATION_BROKER_KEY_ID: KEY_ID,
    APP_PROPOSAL_PUBLICATION_BROKER_TIMEOUT_MS: timeoutMs,
    APP_PROPOSAL_PUBLICATION_EXECUTION_LEASE_SECONDS: "45",
    PROPOSAL_PUBLICATION_BROKER_SHARED_SECRET: SHARED_SECRET,
  } as AppEnv;
}

function previewInput() {
  return {
    approvalRequestId: "proposal-publication-approval:001",
    tenantId: TENANT,
    runId: "run:proposal-publication:001",
    roofJobId: "RJ-0001",
    proposalEvidencePackId: "proposal:CQ-0001",
    requestText: "Publish the reviewed proposal to the customer portal.",
    requestedByUserId: "appu_owner_001",
    requestedByFrappeUser: "owner@ironwrap.local",
  };
}

function preview(
  body: Record<string, unknown>,
  status: number,
  overrides: { timeoutMs?: string } = {},
): Promise<unknown> {
  return previewProposalPublicationApproval(env(overrides.timeoutMs), previewInput(), {
    now: () => NOW,
    nonce: () => NONCE,
    fetch: async (input, init) => {
      const request = input instanceof Request ? input : new Request(input, init);
      const raw = await request.text();
      return signedBrokerResponse(request, new URL(request.url).pathname, raw, body, status);
    },
  });
}

test("proposal publication broker passes a signed 422 rejection through with its own code", async () => {
  await assert.rejects(
    () => preview({ error: "broker_proposal_evidence_pack_not_draft" }, 422),
    (error: unknown) => error instanceof ProposalPublicationApprovalBrokerError &&
      error.code === "proposal_publication_broker_rejected" &&
      error.brokerErrorCode === "broker_proposal_evidence_pack_not_draft" &&
      error.brokerStatus === 422,
  );
});

test("proposal publication broker reports unavailable when it cannot be reached", async () => {
  await assert.rejects(
    () => previewProposalPublicationApproval(env(), previewInput(), {
      now: () => NOW,
      nonce: () => NONCE,
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    }),
    (error: unknown) => error instanceof ProposalPublicationApprovalBrokerError &&
      error.code === "proposal_publication_broker_unavailable" &&
      error.brokerErrorCode === null &&
      error.brokerStatus === null,
  );
});

test("proposal publication broker reports unavailable on a timeout", async () => {
  await assert.rejects(
    () => previewProposalPublicationApproval(env("1000"), previewInput(), {
      now: () => NOW,
      nonce: () => NONCE,
      fetch: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        (init?.signal as AbortSignal).addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      }),
    }),
    (error: unknown) => error instanceof ProposalPublicationApprovalBrokerError &&
      error.code === "proposal_publication_broker_unavailable",
  );
});

test("proposal publication broker still reads unavailable on a signed 5xx", async () => {
  await assert.rejects(
    () => preview({ error: "broker_internal_error" }, 502),
    (error: unknown) => error instanceof ProposalPublicationApprovalBrokerError &&
      error.code === "proposal_publication_broker_unavailable" &&
      error.brokerErrorCode === null,
  );
});

test("proposal publication broker falls back to a bounded code on a malformed 4xx body", async () => {
  await assert.rejects(
    () => preview({ error: { nested: "object" } }, 400),
    (error: unknown) => error instanceof ProposalPublicationApprovalBrokerError &&
      error.code === "proposal_publication_broker_rejected" &&
      error.brokerErrorCode === "proposal_publication_broker_rejected" &&
      error.brokerStatus === 400,
  );
});

// The passthrough must not become a way to trust an unsigned answer: an attacker
// on the loopback port cannot turn "broker down" into a business rejection.
test("proposal publication broker rejects an unsigned 422 as an invalid response", async () => {
  await assert.rejects(
    () => previewProposalPublicationApproval(env(), previewInput(), {
      now: () => NOW,
      nonce: () => NONCE,
      fetch: async () => new Response(JSON.stringify({ error: "broker_proposal_evidence_pack_not_draft" }), {
        status: 422,
        headers: { "content-type": "application/json; charset=utf-8" },
      }),
    }),
    (error: unknown) => error instanceof ProposalPublicationApprovalBrokerError &&
      error.code === "proposal_publication_broker_response_invalid",
  );
});

function signedBrokerResponse(
  request: Request,
  path: string,
  rawRequest: string,
  body: Record<string, unknown>,
  status: number,
): Response {
  const rawResponse = JSON.stringify(body);
  const requestTimestamp = request.headers.get("x-ironwrap-internal-timestamp") ?? "";
  const nonce = request.headers.get("x-ironwrap-internal-nonce") ?? "";
  const responseTimestamp = String(NOW);
  const signature = hmac([
    "1", KEY_ID, String(status), path, requestTimestamp, nonce, sha256(rawRequest), responseTimestamp,
    sha256(rawResponse),
  ].join("\n"));
  assert.equal(path, PREVIEW_PATH);
  return new Response(rawResponse, {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "x-ironwrap-internal-version": "1",
      "x-ironwrap-internal-key-id": KEY_ID,
      "x-ironwrap-internal-timestamp": responseTimestamp,
      "x-ironwrap-internal-request-timestamp": requestTimestamp,
      "x-ironwrap-internal-nonce": nonce,
      "x-ironwrap-internal-signature": signature,
    },
  });
}

function hmac(value: string): string {
  return createHmac("sha256", SHARED_SECRET).update(value).digest("base64url");
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
