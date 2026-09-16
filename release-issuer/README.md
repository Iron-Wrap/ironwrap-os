# Release issuer

Status: component contract
Owner: independent release custodian
Consumer: `.github/workflows/deploy.yml` admission job, through `tools/release-promotion.mjs`

The release admission job refuses to promote anything until a principal that is not the release
pipeline acknowledges the exact source under review. This Worker is that principal.

It accepts one canonical, fresh, correctly-addressed trigger and writes a durable acknowledgement
naming the run id that the eventual signed GO receipt must carry. It signs nothing, mints no
findings, publishes no receipt, and holds neither the review private key nor any deployment
credential. Those stay with the reviewer, which is what keeps the two halves independent.

## What the admission job sends

`POST https://<issuer-host>/v2/independent-issuer`, `Authorization: Bearer <trigger token>`, body
exactly the canonical `ironwrap_independent_issuer_request_v2` object that
`tools/release-promotion.mjs issuer-request` builds. The response is
`{ "acknowledgement": { … } }` in the `ironwrap_independent_issuer_ack_v1` shape, whose
`request_digest` is the SHA-256 of the canonical request and whose `issuer_run_id` is derived from
that digest.

Refusals answer with the enforcer's own vocabulary: `issuer_request_shape_invalid`,
`issuer_request_expired`, `issuer_request_principal_drift`, and the rest. The issuer validates the
trigger itself rather than trusting it; `test/contract.test.mjs` runs every case through both this
validator and the enforcer's exported one and fails if they ever disagree.

Replay is exact-or-nothing. A repeated trigger inside its five-minute window reads the ledgered
acknowledgement back without minting a second run id; a repeat after the window has closed is
refused, because re-acknowledging stale source would hand a fresh receipt binding to an old review.

## Standing it up

Deploy under an API token with no authority over the `ironwrap-bus` Workers, D1 or R2. Sharing a
token would put the reviewer and the released system back under one custodian.

```
cd release-issuer
npx wrangler d1 create ironwrap-release-issuer     # put the id into wrangler.jsonc
npx wrangler d1 migrations apply ironwrap-release-issuer --remote
npx wrangler secret put ISSUER_TRIGGER_TOKEN       # a fresh random value
npx wrangler deploy
```

Then set two repository secrets so the admission job can reach it:

- `RELEASE_INDEPENDENT_ISSUER_URL` — the full `https://<host>/v2/independent-issuer` route, no
  query, no fragment. The enforcer refuses any other path.
- `RELEASE_INDEPENDENT_ISSUER_TOKEN` — the same value given to `ISSUER_TRIGGER_TOKEN`.

## Reviewing a release

After the admission job triggers the issuer it waits up to ten minutes for a signed GO at
`.release/reviews/<source-commit>.json` on the `release-review/<source-commit>` ref. The reviewer
produces it, and the run id must match the acknowledgement or `review-wait` refuses the receipt:

```
curl -sS -H "Authorization: Bearer $ISSUER_TRIGGER_TOKEN" \
  "https://<issuer-host>/v2/independent-issuer/acknowledgements/<source-commit>"
```

Take `issuer_run_id` from that answer, write a findings file whose `decision` is `GO` with zero
unresolved P0 and P1 items, then sign and publish with the review private key:

```
node tools/release-promotion.mjs review-sign \
  --repository Iron-Wrap/ironwrap-os --repo-root . \
  --source-commit <source-commit> --base-commit <base-commit> \
  --findings findings.json --issuer-identity release-admission@ironwrapexteriors.com \
  --review-private-key review.key --output review.receipt
node tools/release-promotion.mjs review-publish \
  --repository Iron-Wrap/ironwrap-os --source-commit <source-commit> \
  --receipt review.receipt --review-public-key review.pub --output published.json
```

The reviewer named in the findings may not be the requester, and the review private key belongs to
the reviewer, not to this service. A GO signed by whoever ran the pipeline is the one thing this
whole gate exists to prevent.

## The gap this service does not close

`RELEASE_REVIEW_PRIVATE_KEY` is currently a repository secret on `Iron-Wrap/ironwrap-os`. Anyone who
can add a workflow to that repository can therefore sign a GO receipt, which is the exact thing the
independent reviewer exists to prevent. This issuer cannot fix that from where it stands: it never
sees the key. The key belongs in the reviewer's own custody, and the repository secret should be
removed once a reviewer holds it.

Related, and only a real risk while the key is misplaced: `issuer_run_id` is derived from the
request digest rather than minted at random, so it is predictable to anyone who can reconstruct the
trigger. Predicting it buys nothing on its own, because publishing a receipt still requires the
review private key. The determinism is deliberate, so that a replay returns one acknowledgement and
so that the reviewer can reproduce the run id instead of copying it out of a log.

Reading an acknowledgement uses the same trigger token, so the reviewer holds it too. A separate
read credential would narrow that; it is not implemented.

## Limits recorded honestly

Deployment of this Worker, its D1 database, its trigger token and the reviewer's key custody are
provisioning steps, not code. Nothing here has been deployed or exercised against a live issuer
host; the contract is proven by `npm test` in this directory (20 cases, including two fuzz
properties against the enforcer's own validator and a real SQLite ledger) and by the enforcer's
own suite.

No independent review of this service has happened. An adversarial review was attempted twice and
both runs failed before any agent executed, so the only scrutiny so far is the author's. That is
also how the two defects listed above were found, which says something about how much more a second
reader is worth here.
