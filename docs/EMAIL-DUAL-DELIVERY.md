# Email dual delivery: Google (primary) + Microsoft 365 (mirror until migration completes)

> Set up 2026-07-03 per owner instruction: "на майкрософт тоже должно все приходить пока мы
> полностью не мигрируем". Live-verified end to end (Exchange message trace + Outlook inbox).

## How mail flows now

1. MX for `ironwrapexteriors.com` → `smtp.google.com` (flipped 2026-07-02). All inbound mail
   lands in Google Workspace: user `sales@` with aliases `info@` and `quote@`.
2. Two Gmail **Routing** rules (Admin console → Apps → Google Workspace → Gmail → Routing)
   copy inbound + internal-receiving mail to the old Microsoft 365 mailboxes:

   | Rule (description) | ID | Envelope recipient filter | Also deliver to |
   |---|---|---|---|
   | Dual delivery to Microsoft 365 (info) | `3fe82` | `info@ironwrapexteriors.com` | `0fe83a84-6a5c-4b66-b6a7-8b778a40404f@NETORG18843785.onmicrosoft.com` |
   | Dual delivery to Microsoft 365 (quote) | `b823e` | `quote@ironwrapexteriors.com` | `7c752096-0fa5-40aa-a331-8dca12b40f42@NETORG18843785.onmicrosoft.com` |

   Both copies have "Do not deliver spam to this recipient" and "Suppress bounces from this
   recipient" enabled, so an M365 outage can never bounce anything back at senders.

## Why the ugly GUID addresses

The M365 tenant is GoDaddy-resold: **NETORG18843785.onmicrosoft.com**. GoDaddy provisions each
mailbox's onmicrosoft proxy address as `<user-GUID>@NETORG18843785.onmicrosoft.com`, not
`info@`/`quote@`. These GUID addresses route to Exchange Online directly over public MX, which
is what lets Google hand copies to Microsoft even though the domain's MX now points at Google.
(A Hosts route "Microsoft 365 dual delivery" → `ironwrapexteriors-com.mail.protection.outlook.com`
also exists in Gmail settings; it ended up unused because the admin-console route picker is
broken for automation. Harmless to keep, fine to delete.)

M365 mailboxes (the only two licensed): `info@` = user "Iron Wrap Exteriors"
(alias `ilya@ironwrapexteriors.com`), `quote@` = user "Iron Wrap".

## Verified 2026-07-03

- Test mail sales@ → info@ + quote@ appeared in BOTH Gmail and Outlook (info@ inbox), and
  Exchange message trace shows both rule copies delivered (`Resolved`) to both GUID addresses.
- Three business emails that arrived Google-only before the rules existed were manually
  forwarded to the info GUID address and all delivered: BookIPI invoice #2025135 (+PDF),
  BookIPI receipt ($21,000), Engage "Loyalty Rebate Program" (rebate deadline July 31, 2026).
- During the brief MX gap some senders (Interac, WCB) kept delivering straight to Microsoft via
  the old mail.protection host, so nothing was lost. By 2026-07-03 they had all shifted to the
  Google MX, and the message trace confirms the rules now mirror their live mail to M365
  (WCB ACN report, Interac e-Transfers, Intuit receipt, a real Save On Roofing quote request,
  Google DMARC reports — all `Resolved` to the GUID addresses).
- ilya@ map live-tested 2026-07-03: mail from sales@ to ilya@ delivered to the M365 info
  mailbox (`Resolved`), no copy in Gmail — Microsoft-only, as intended.

## ilya@ goes to Microsoft ONLY (owner decision 2026-07-03)

Per owner: "пусть ilya@ironwrapexteriors.com идут ему на майкрософт только". Implemented as a
Gmail **recipient address map** (Admin console → Gmail → Routing → Email forwarding using
recipient address map), setting id `bd3e9`, "ilya@ forward to Microsoft 365 only":

- `ilya@ironwrapexteriors.com` → `0fe83a84-6a5c-4b66-b6a7-8b778a40404f@NETORG18843785.onmicrosoft.com`
- Applies to **all incoming messages**; "Also route to original destination" is **OFF**, so no
  copy stays in Google. The mail lands in the M365 `info@` mailbox where `ilya@` is an alias.
- ilya@ has NO Google mailbox/alias; before this map, mail to ilya@ bounced at Google.

## Full address map (verified across Google Admin, M365 admin, mailboxes 2026-07-03)

### Mailboxes and addresses

| Address | Lives where | What happens to inbound mail |
|---|---|---|
| `sales@ironwrapexteriors.com` | Google Workspace, the ONLY user (display name **"Iron Wrap Exteriors"**, renamed from "Veronika Peycheva" 2026-07-03) | Stays in Gmail only. The bus sends FROM this address (`FROM_EMAIL`); it is also `BACKUP_ALERT_EMAIL` |
| `info@ironwrapexteriors.com` | Alias of sales@ (Google) + real M365 mailbox "Iron Wrap Exteriors" (Business Basic, Global Admin) | Gmail inbox **and** copy to M365 via rule `3fe82`. Bus `OWNER_ALERT_EMAIL`, DMARC reports target, QuickBooks/Cloudflare/Make logins, WCB + ATB/Interac + BookIPI + Intuit notifications |
| `quote@ironwrapexteriors.com` | Alias of sales@ (Google) + real M365 mailbox "Iron Wrap" (Business Basic + Power Automate Free) | Gmail inbox **and** copy to M365 via rule `b823e`. RoofRuler reports arrive here |
| `ilya@ironwrapexteriors.com` | M365-only (alias of info@ mailbox); NO Google mailbox | Address map `bd3e9` redirects to Microsoft ONLY, nothing stays in Gmail |
| `admin@NETORG18843785.onmicrosoft.com` | M365 tenant admin "Ilya Myshalou", unlicensed | No mailbox; tenant administration only |
| `info@iroofalberta.ca` | Separate Google account "I Roof" (iRoof Alberta brand) | Independent of this Workspace; **Jotform is connected to this account** |
| GUID addresses `0fe83a84-…@NETORG…` / `7c752096-…@NETORG…` | M365 proxy aliases of info@ / quote@ | Technical delivery targets for the dual-delivery rules and the ilya@ map; not used by humans |

Google Workspace has **no groups** and no other users. Personal Gmail accounts seen on the
owner's devices (ilya.myshalou@, solarisleo1983@) are deliberately NOT wired into any business
flow — keep it that way.

### Which service logs in with which email

| Service | Login / connected account |
|---|---|
| QuickBooks Online (signed up 2026-07-03; Intuit payment receipt confirmed) | `info@ironwrapexteriors.com` |
| Jotform | `info@iroofalberta.ca` |
| Cloudflare dashboard | `info@ironwrapexteriors.com` |
| Make (org 6202921) | `info@ironwrapexteriors.com` (notifications arrive there) |
| GitHub org `ironwrap` | `sales@ironwrapexteriors.com` (token/launch emails arrive there) |
| Google Cloud project `ironwrap-bus` (service account, Shared Drives) | `sales@ironwrapexteriors.com` |
| Microsoft 365 admin / Exchange admin | `info@ironwrapexteriors.com` (Global Admin) or `admin@NETORG18843785.onmicrosoft.com` |
| BookIPI (invoicing, still active until QBO takes over) | sends copies to `info@ironwrapexteriors.com` |
| WCB Alberta ACN daily report (`decc001@wcb.ab.ca`) | to `info@ironwrapexteriors.com` |
| ATB / Interac e-Transfer notifications | to `info@ironwrapexteriors.com` |

## RoofRuler report processing (how it actually works — verified 2026-07-05)

RoofRuler measurement reports are **not** fed by any mail-forwarding rule. RoofRuler
(`support@roofruler.com`) sends each completed report **directly to the Make mailhook** as the
primary recipient, with `quote@` only on Cc:

```
To: Ironwrap Replies <h5tysqx6w3durjkg6iewknc9bkb3injg@hook.us2.make.com>
Cc: Iron Wrap <quote@ironwrapexteriors.com>
```

This works because IronWrap's outbound RoofRuler *request* emails set the mailhook as the
reply address, so RoofRuler's reply lands straight in Make — **independent of the MX / migration**.
The `quote@` copy is just the human-visible copy in Gmail.

- **Make scenario:** "Roofroler Report Processing" (id `4754599`, org 6202921, team 1742726),
  hook `RoofRulerMailHook` (id 2165390). Flow: mailhook → GPT-5-nano extracts `Opportunity ID` +
  `LEAD_NUMBER` from the email body → JobNimbus/GHL `getAnOpportunity` → OneDrive folder search +
  upload of the PDF/XML attachments into the job folder → add note to the contact → confirmation
  email back to `quote@`. A healthy run is ~11–13 operations; the "not found / no attachments"
  branch is ~6 operations and just emails `quote@`.
- **Do NOT add a second feed.** A Google Routing rule "RoofRuler reports also to Make (quote@)"
  (id `e4fb8`, envelope sender `support@roofruler.com` → also-deliver-to the mailhook) was built
  2026-07-05, then **disabled the same day**: because RoofRuler already sends direct, the rule
  double-delivered every report (duplicate OneDrive upload + duplicate CRM note + duplicate
  email). It is left **Disabled** (one click to re-enable). Only re-enable it if the scenario
  first gets dedup logic (keyed on the report/opportunity id) so double delivery is harmless —
  or, better, reconfigure RoofRuler to send to `quote@` only and let this rule be the single feed.
- **Recovering a missed report:** if a report ever lands in the `sales@`/`quote@` Gmail but no
  Make execution fires (rare transient miss — happened once for job `26-180-ER Jim Rakievich`
  on Jul 3, recovered Jul 5), just **Forward that email to the mailhook** address above with its
  attachments. Forwarding from `sales@` does not trigger the disabled rule and processes cleanly
  (verified: 13 ops, 82 MB, SUCCESS). Edits to the Make scenario must be done in the Make **UI**,
  never via API.

## To switch OFF after full migration

Admin console → Gmail → Routing → Disable/Delete rules `3fe82` and `b823e` (and optionally the
"Microsoft 365 dual delivery" host). Nothing else to unwind. DNS already final:
SPF `v=spf1 include:_spf.google.com include:spf.protection.outlook.com ~all` (drop the outlook
include once M365 is retired), DMARC `p=none rua=info@` (tighten back toward `p=quarantine`
after a few clean weeks of reports).
