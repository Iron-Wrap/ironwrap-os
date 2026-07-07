# Accounts, Services & Access Register

Every account/service/access the end-state system needs, with status. Doubles as the **vendor
register** required by `final-spec-pack/09` (compliance). Status: ✅ have · 🔲 need (set up / upgrade /
enable) · ❌ retire (cancel to avoid double-paying) · ❓ confirm. 💲 = cost. Verified against repo
and handoff docs 2026-07-07.

## 1. CRM & operations
| Service | Status | For | Action |
|---|---|---|---|
| JobNimbus | ✅ have | CRM / job truth / the spine | 🔲 confirm current tier + limits on the invoice — **API already works on the current plan** (proven live, so NO upgrade needed just for API); watch the **automation/integration cap** (~10 automations / 5 integrations on lower tiers) · 🔲 rotate API key · 🔲 configure record types (`Customer`/`Retail`), statuses, Lead Sources, pipeline stages |
| JobNimbus Engage | 🔲 need | 2-way SMS to clients (stage-triggered) | 🔲 subscribe (~USD $49+/mo) · 🔲 register A2P yourself (see §2) |
| JobNimbus AssistAI | 🔲 need (Phase 2) | 24/7 AI phone receptionist | 🔲 enable after eval gate · 💲 $0.15/voice-min, set a monthly cap · ❓ confirm Canadian-number support with sales |

## 2. Telephony & SMS
| Service | Status | For | Action |
|---|---|---|---|
| Twilio | 🔲 need | Own the portable business phone number (DID) for voice/AssistAI | 🔲 open account · 🔲 provision a Canadian number (~USD $1/mo) |
| A2P 10DLC / TCR registration | 🔲 need | Legal permission to send business SMS in Canada (mandatory, carrier-level, ~2 wks) | 🔲 register brand + campaign (via Twilio or Engage). Needs: legal name, **CRA Business Number**, address, website, sample messages, opt-in description. **Start now** |

## 3. Money
| Service | Status | For | Action |
|---|---|---|---|
| QuickBooks Online | ✅ have | Accounting truth + catalog + invoices + estimates + POs + mileage | 🔲 move to **Plus** tier (~CAD $60/mo, needed for POs/inventory) · 🔲 enable **QuickBooks Payments** (card/EFT on invoice) |
| Moneris | ❌ not needed (owner, 2026-07-02) | - | All payments via **QuickBooks Payments** (card/Apple Pay/EFT on the invoice). No processor, no connector, no Benji Pays |
| CRA Business Number | ✅ have | Needed for A2P registration + tax | — |

## 4. Email, files & storage (moving Microsoft → Google)

> **2026-07-03:** IronWrap Workspace is LIVE (`sales@` + aliases `info@`/`quote@`, MX → Google)
> and everything inbound is mirrored to the old Microsoft 365 mailboxes until migration
> completes — rules, tenant (`NETORG18843785`, GoDaddy-resold) and off-switch documented in
> [`EMAIL-DUAL-DELIVERY.md`](./EMAIL-DUAL-DELIVERY.md).

| Service | Status | For | Action |
|---|---|---|---|
| Google Workspace — iRoof (`info@iroofalberta.ca`) | ✅ have | iRoof brand email | — |
| Google Workspace — IronWrap | ✅ have | IronWrap brand email; `sales@` user with `info@`/`quote@` aliases | Keep M365 mirror until migration close; see `EMAIL-DUAL-DELIVERY.md` |
| Google Drive (Shared Drives) | ✅ have | All job files, folder-per-job by JobNimbus number | IW Jobs / IW Restricted / IW Archive are live |
| Google send-path creds | ✅ have | Automated email from the bus | Service account + domain-wide delegation; bus sends from `sales@` for now |

## 5. Integration & infrastructure
| Service | Status | For | Action |
|---|---|---|---|
| Cloudflare (dedicated IronWrap account) | ✅ have | The bus (Workers/D1/R2/Queues/Cron); owned data store | 🔲 rotate API token (was shared in chat) |
| Make (Core plan) | ✅ have | Connectors + observability (minimized role) | 🔲 clean out GHL/Microsoft connections; keep JobNimbus/QuickBooks/Google Drive/Jotform |

## 6. Field forms & measurements
| Service | Status | For | Action |
|---|---|---|---|
| Jotform | ✅ have (connected) | Safety / Completion / Jobsite-Photo forms | 🔲 paid tier (~USD $39/mo) for offline app + volume |
| RoofRuler | ✅ have | Roof measurement reports (exports XML/ESX) | ❓ confirm XML/ESX auto-delivery vs manual export |
| AppliCad | ❓ if used | Desktop estimating (XML/RXF export) | ❓ confirm whether in use / license |

## 7. Website & local presence
| Service | Status | For | Action |
|---|---|---|---|
| Website access (via agency Wisdek) — both brands | 🔲 need | Point the lead forms at the bus | 🔲 get access / give the agency the forward task (`docs/WEBSITE-INTEGRATION.md`) |
| Google Business Profile (both brands) | ✅ have | Local leads + reviews | maintain |

## 8. Domains / DNS
| Service | Status | For | Action |
|---|---|---|---|
| `ironwrapexteriors.com` + `iroofalberta.ca` registrars | ✅ have | Email authentication + form repoint | 🔲 confirm Google DKIM + clean DMARC monitoring before tightening policy |

## 9. Compliance / legal
| Service | Status | For | Action |
|---|---|---|---|
| WCB Alberta account | ✅ have + **ACN already configured** (owner, 2026-07-02: auto email if a sub's WCB is cancelled; checked daily) | Coverage + subcontractor clearance | Nothing to build; optional JN task at Job Scheduled ("clearance letter on file") |
| Lawyer review | 🔲 need | Approve consent / call-recording / privacy notices before SMS/calls go live | 🔲 engage before launch (hard gate) |

## 10. Retire (cancel once replacements are live — stop double-paying)
| Service | Replaced by |
|---|---|
| ❌ GoHighLevel (GHL) | JobNimbus + the bus |
| ❌ Microsoft 365 / OneDrive | Google Workspace + Google Drive |
| ❌ BookIPI | QuickBooks (invoices/quotes/receipts) |
| ❌ Stripe | QuickBooks Payments |
| ❌ MileIQ | QuickBooks built-in mileage tracker |

## 11. Secrets the bus holds (not services — credentials, stored as Cloudflare secrets, never in code)
`INGEST_TOKEN`, `ADMIN_TOKEN` (generated) · `JOBNIMBUS_API_KEY` (rotate) ·
`GOOGLE_SERVICE_ACCOUNT_JSON` · `QB_WEBHOOK_TOKEN` once QuickBooks is connected. **Rotate anything
pasted in chat** (JobNimbus key, Cloudflare token). The Worker does not hold Twilio SMS secrets.

## 12. Design (optional, minor)
Free **Canva** + free **Affinity** cover marketing/proposal graphics. 💲 CAD $0.
