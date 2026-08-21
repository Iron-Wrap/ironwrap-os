# IronWrap OS extractable layout components

Extract layout components only. Basic `Button`, `Input`, and `Card` primitives should remain inline in Superdesign drafts.

| Canvas component | Source | Props for design template | Notes |
|---|---|---|---|
| AppHeader | `app/src/components/app-shell.tsx` | `brand:string`, `role:string`, `offline:boolean` | Tenant/role identity and sign-out action |
| DesktopRoleNav | `app/src/components/app-shell.tsx` + `app/src/lib/roles.ts` | `items:array`, `activePath:string` | 15rem authenticated desktop rail |
| MobileRoleNav | `app/src/components/app-shell.tsx` + `app/src/lib/roles.ts` | `items:array`, `activePath:string` | Horizontal snap rail; each item at least 72px |
| UniversalSafetyRail | `app/src/components/app-shell.tsx` + `app/src/field/safety-action-panel.tsx` | `open:boolean`, `hazardState:string` | Must remain globally reachable; never hide behind page content |
| SystemStatusStrip | `app/src/components/system-status.tsx` | `online:boolean`, `updateReady:boolean`, `pendingCount:number` | Appears below the sticky header |

Brand note: the current shell uses the Lucide `ShieldCheck` product mark rather than a separate logo file. Do not invent a replacement logo.
