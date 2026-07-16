import { describe, expect, it, vi } from "vitest";

import type { AuthenticatedSession } from "../auth/session";
import {
  issueCustomerPortalLink,
  loadCustomerPortalLinks,
  revokeCustomerPortalLink,
  verifiedCustomerPortalUrl,
} from "./customer-portal-office-api";

const link = {
  id: "portal_11111111-1111-4111-8111-111111111111",
  roof_job_id: "JOB-A",
  created_at: "2030-01-01T12:00:00.000Z",
  expires_at: "2030-01-02T12:00:00.000Z",
  revoked_at: null,
  last_accessed_at: null,
  access_count: 0,
};
const token = "A".repeat(43);
const session = {
  version: 1,
  authenticated: true,
  user: {
    id: "appu_owner",
    email: "owner@ironwrapexteriors.com",
    display_name: "Owner",
    role: "owner",
    frappe_user_id: "owner@ironwrapexteriors.com",
  },
  tenant: {
    id: "ironwrap",
    name: "IronWrap OS",
    brand: "IronWrap",
    locale: "en-CA",
    time_zone: "America/Edmonton",
    currency: "CAD",
  },
  permissions: ["jobs:read:any"],
  allowed_actions: ["job.read"],
  csrf_token: "csrf",
  session_expires_at: "2030-01-01T13:00:00.000Z",
  source_updated_at: null,
  read_model_generated_at: "2030-01-01T12:00:00.000Z",
  stale_fields: [],
} satisfies AuthenticatedSession;

describe("customer portal office API", () => {
  it("uses only the job-scoped links collection and fixed CSRF command bodies", async () => {
    const origin = window.location.origin;
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ links: [link] }))
      .mockResolvedValueOnce(
        Response.json({
          link,
          portal_url: `${origin}/portal#token=${token}`,
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          ok: true,
          link_id: link.id,
          revoked_at: "2030-01-01T13:00:00.000Z",
        }),
      );

    await loadCustomerPortalLinks("JOB:A", fetcher);
    const issued = await issueCustomerPortalLink(
      session,
      { roofJobId: "JOB-A", expiresAt: "2030-01-02T12:00:00.000Z" },
      fetcher,
    );
    await revokeCustomerPortalLink(session, link.id, fetcher);

    expect(fetcher.mock.calls[0]?.[0]).toBe("/api/v1/customer-portal/links?roof_job_id=JOB%3AA");
    expect(fetcher.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ credentials: "same-origin", cache: "no-store", method: "GET" }),
    );
    expect(fetcher.mock.calls[1]?.[0]).toBe("/api/v1/customer-portal/links");
    expect(new Headers(fetcher.mock.calls[1]?.[1]?.headers).get("X-CSRF-Token")).toBe("csrf");
    expect(fetcher.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({ roof_job_id: "JOB-A", expires_at: "2030-01-02T12:00:00.000Z" }),
    );
    expect(fetcher.mock.calls[2]?.[0]).toBe(`/api/v1/customer-portal/links/${link.id}/revoke`);
    expect(new Headers(fetcher.mock.calls[2]?.[1]?.headers).get("X-CSRF-Token")).toBe("csrf");
    expect(fetcher.mock.calls[2]?.[1]?.body).toBeUndefined();
    expect(issued.portal_url).toBe(`${origin}/portal#token=${token}`);
  });

  it("accepts only the same-origin fixed portal fragment shape", () => {
    expect(
      verifiedCustomerPortalUrl(
        `https://app.example.com/portal#token=${token}`,
        "https://app.example.com",
      ),
    ).toBe(`https://app.example.com/portal#token=${token}`);
    expect(
      verifiedCustomerPortalUrl(
        `https://elsewhere.example/portal#token=${token}`,
        "https://app.example.com",
      ),
    ).toBeNull();
    expect(
      verifiedCustomerPortalUrl(
        `https://app.example.com/portal?next=/x#token=${token}`,
        "https://app.example.com",
      ),
    ).toBeNull();
    expect(
      verifiedCustomerPortalUrl(
        `https://app.example.com/portal#token=${token}&mode=copy`,
        "https://app.example.com",
      ),
    ).toBeNull();
    expect(
      verifiedCustomerPortalUrl(
        "https://app.example.com/portal#token=short",
        "https://app.example.com",
      ),
    ).toBeNull();
  });

  it("does not return an unvalidated bearer URL to the UI", async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      Response.json({
        link,
        portal_url: `https://elsewhere.example/portal#token=${token}`,
      }),
    );

    await expect(
      issueCustomerPortalLink(
        session,
        { roofJobId: "JOB-A", expiresAt: "2030-01-02T12:00:00.000Z" },
        fetcher,
      ),
    ).rejects.toMatchObject({ code: "invalid_portal_url" });
  });
});
