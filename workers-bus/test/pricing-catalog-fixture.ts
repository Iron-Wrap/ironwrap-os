const TENANT = "ironwrap";
export const catalogList = (revision = 1, rate = 100) => ({
  currency: "CAD",
  panel: {
    sku: "PANEL",
    unit: "sqft",
    rateCents: rate,
    sourceRef: `supplier:synthetic:${revision}`,
  },
  trims: {
    eave_drip: {
      sku: "EAVE",
      unit: "lf",
      rateCents: 20,
      sourceRef: "supplier:synthetic:eave",
    },
    ridge_cap: {
      sku: "RIDGE",
      unit: "lf",
      rateCents: 30,
      sourceRef: "supplier:synthetic:ridge",
    },
  },
  fasteners: {
    clips: { sku: "CLIP", rateCents: 1, sourceRef: "supplier:synthetic:clip" },
    clipScrews: {
      sku: "CLIP-SCREW",
      rateCents: 1,
      sourceRef: "supplier:synthetic:clip-screw",
    },
    trimScrews: {
      sku: "TRIM-SCREW",
      rateCents: 1,
      sourceRef: "supplier:synthetic:trim-screw",
    },
  },
  labor: {
    sku: "LABOR",
    ratePerSquareCents: 0,
    sourceRef: "labor:synthetic:included",
  },
  approvedPolicy: {
    schemaVersion: "ironwrap.pricing-policy.v1",
    tenantId: TENANT,
    policyId: "synthetic-metal",
    revision,
    effectiveAt: "2026-01-01T00:00:00.000Z",
    expiresAt: "2030-12-31T23:59:59.999Z",
    pricing: { method: "markup", rateBps: 2000 },
    freightCents: 0,
    contingencyRateBps: 0,
    minimumChargeCents: 0,
    taxRateBps: 500,
  },
});
