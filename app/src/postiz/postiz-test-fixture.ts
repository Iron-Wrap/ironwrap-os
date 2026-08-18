import type { PostizIntentResponse } from "./postiz-contracts";

export function postizIntentFixture(): PostizIntentResponse {
  return {
    version: 1,
    adapter: { name: "postiz", expected_version: "v2.23.0" },
    enabled: true,
    connected: true,
    allowed_actions: [
      "postiz.intent.review",
      "postiz.intent.approve",
      "postiz.intent.reject",
      "postiz.intent.reconcile",
    ],
    intent: {
      id: "11111111-1111-4111-8111-111111111111",
      title: "Spring roof inspection reminder",
      content: "Book a documented spring roof inspection before the next thaw.",
      provider: "facebook",
      integration_id: "integration:facebook:001",
      scheduled_at: "2026-08-14T16:00:00.000Z",
      evidence_refs: ["evidence:campaign-brief:001"],
      citations: [
        {
          id: "citation:001",
          label: "Approved campaign brief",
          source_ref: "campaign-brief:001",
        },
      ],
      permission_scope: "marketing.social.publish.reviewed",
      state: "pending_review",
      version: 7,
      error_code: "provider_detail_not_exposed",
      created_at: "2026-08-13T08:00:00.000Z",
      updated_at: "2026-08-13T08:05:00.000Z",
    },
    reconciliation: {
      last_checked_at: "2026-08-13T08:04:00.000Z",
      remote_state: "DRAFT",
      release_url: null,
      detail_code: null,
    },
  };
}

export function submittedPostizIntentFixture(): PostizIntentResponse {
  const fixture = postizIntentFixture();
  return {
    ...fixture,
    allowed_actions: ["postiz.intent.review", "postiz.intent.stop", "postiz.intent.reconcile"],
    intent: { ...fixture.intent, state: "submitted", version: fixture.intent.version + 1 },
    reconciliation: { ...fixture.reconciliation, remote_state: "QUEUE" },
  };
}
