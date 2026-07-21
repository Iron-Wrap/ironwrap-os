# Staging owner test

## Live boundary

- URL: `https://ironwrap-bus-staging.yellow-rain-7498.workers.dev`
- Worker: `ironwrap-bus-staging`
- Data: dedicated staging D1, R2 bucket, and queues only.
- Production DNS, Worker, D1, R2, queues, mailboxes, Drive folders, Frappe site, JobNimbus, and approval rails are not used.

The live URL is an **infrastructure stage**, not yet the all-feature owner-acceptance environment. It safely proves the built PWA, Worker deployment, schema, static assets, and isolated Cloudflare bindings. Its BFF is intentionally off until all upstream services below are separately provisioned.

## Do not test against production

- Use synthetic contacts, addresses, photos, measurements, and estimates only.
- Do not add production credentials or real customer records.
- Keep JobNimbus, QuickBooks, Newo, the public estimator, customer portal, and approval brokers disabled unless each has a dedicated staging account and test payload.

## Full owner-acceptance gate

Before sharing the stage for end-to-end testing, provide all of the following:

1. An isolated Ubuntu x86_64 host (minimum 2 vCPU, 8 GiB RAM, 80 GiB disk; 4 vCPU/16 GiB recommended) for a separately built Frappe site.
2. A dedicated staging hostname on an active Cloudflare zone, protected by Cloudflare Access for the owner/testers.
3. A distinct Frappe site, database/Redis volumes, admin user, and read-only Worker integration user.
4. A dedicated test Gmail sender and service account with access only to staging mail/Drive resources.
5. A JobNimbus sandbox/test account if website-lead bridge delivery is part of acceptance; otherwise seed via `POST /ingest/estimate`, which does not enqueue a JobNimbus write.

Then set only the staging environment secrets and variables, enable the BFF against the exact staging origin, create synthetic role accounts (owner, office, field), and run the acceptance pass below.

## Owner acceptance pass

1. Magic-link login, logout, and origin/CSRF rejection.
2. Owner Now empty, populated, and upstream-unavailable states.
3. Sales triage and estimator workbench with synthetic measurement inputs.
4. Production runway read models and their capability-absent states.
5. Field-device pairing, offline capture, revoke, and re-pair with one disposable field user.
6. Admin/readiness evidence, D1/R2 receipts, audit events, and queue recovery with staging data only.

Approval, payment, public-estimator, portal, and external bridge write actions remain out of scope until their own staging identities and explicit acceptance criteria exist.

## Operator commands

```bash
cd workers-bus
npm run db:migrate:staging
npm run deploy:staging
```

Never run the production migration or deployment command while preparing the owner test.
