# QA & Go-Live Acceptance Matrix (spec 10)

Run before launch, for **both brands** (IronWrap Exteriors + iRoof Alberta). Each case: **do → expect → ✅/❌**.
A case is **N/A** until its feature is connected (see `ACTIVATION-CHECKLIST.md`) — the matrix is the proof
that "built" became "operating."

## A. Lead capture → owned store → JobNimbus
| # | Case | Expect |
|---|---|---|
| A1 | Website **quote** form (each brand) | envelope in D1 (`status=pushed`); JN contact w/ `brand:` tag; queue routed by service |
| A2 | Website **contact** form | same; `intent_queue=human_qualification` |
| A3 | Service-page form (metal roof) | `intent_queue=residential_sales` |
| A4 | GBP / manual lead (`POST /ingest/gbp`) | envelope + JN contact; source tagged |
| A5 | Phone lead → MCTB (post-AssistAI) | envelope; instant-ack fires |
| A6 | Lead with **no phone + no email** | 200, envelope `status=received`, flagged `no_contact_handle`, **not** pushed |
| A7 | Oversized (>256 KB) / malformed body | 413 / safe handling; raw still stored in R2 |

## B. Dedup & idempotency
| B1 | Same person twice within 72h | second = `duplicate` (`dup_of` set); **one** JN contact |
| B2 | Replay same envelope | JN contact reused via bus tag; no duplicate |

## C. Instant-ack (Gmail now; SMS in Engage post-A2P)
| C1 | Lead with email | prospect "we got it" email + owner alert **<60s** |
| C2 | Lead with phone (A2P/Engage on) | prospect SMS sent from JobNimbus Engage; **STOP** honored |
| C3 | Mailer misconfigured | lead still captured + pushed (email is best-effort, non-fatal) |

## D. Reconciliation & heartbeat
| D1 | `POST /admin/reconcile` | digest email arrives; rows show source vs landed; gaps flagged |
| D2 | Heartbeat absence (simulate) | missing digest → documented escalation path |
| D3 | Force a JN failure | envelope → `dead`; owner alerted; `POST /admin/replay` recovers |

## E. Field & documents (Phase 3)
| E1 | Jotform photo w/ job # | files into Google Drive job folder (keyed by JN job number) |
| E2 | RoofRuler report w/ job # | report filed to Google Drive or current Make-owned report folder; measurements captured |
| E3 | Create a routable lead | Google Drive job folder auto-created on job mint |
| E4 | Unreachable photo URL | skipped + logged; raw retained; other photos still file |

## F. Proposals & finance
| F1 | JobNimbus native e-sign proposal | proposal/signature flow works in JobNimbus; DocuSeal remains N/A unless adopted later |
| F2 | QuickBooks invoice/payment event | `/webhook/quickbooks` verifies signature + records event |
| F3 | Wrong `intuit-signature` | 401 |

## G. Brand split
| G1 | IronWrap lead (`brand=ironwrap`) | `brand:ironwrap` tag; correct sender/domain |
| G2 | iRoof lead (`brand=iroof`) | `brand:iroof` tag; correct sender/domain |

## H. Security & compliance (hard gates — spec 09)
| H1 | `/ingest` + `/admin` without token | 401 |
| H2 | Keys rotated post-launch | old JN/CF/bus tokens invalid |
| H3 | Privacy notice (both brand sites) | published; names cross-border processors |
| H4 | CASL consent + unsubscribe | consent recorded; STOP/unsubscribe honored |
| H5 | Call recording / AI disclosure | plays before any capture |
| H6 | A2P 10DLC | campaign approved before any SMS |

## Sign-off
☐ All non-N/A cases pass, **both brands** · ☐ compliance gate approved (spec 09) · ☐ AssistAI eval passed
(spec 05) · ☐ owner sign-off (spec 11). Then "What Counts As Shipped" (`final-spec-pack/README.md`) is true.
