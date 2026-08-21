# IronWrap OS design system — Facet family 2026

Status: active product standard. Direction approved: evolve this system in place.

## Approved evolution direction

- Preserve the ivory content canvas, Inter typography, and proof-first operational tone. Use Facet's exact graphite, paper, red, and semantic status ramps across the shared product family.
- Improve hierarchy, density, responsive ergonomics, focus clarity, and state consistency through the existing tokens and shared primitives.
- Keep IronWrap and Facet visibly related through identical color semantics, disciplined surfaces, spacing, touch targets, and accessibility, while preserving each product's workflows and information architecture.
- Do not introduce a parallel theme, decorative brand palette, or new component library.

## Facet family composition

- Use the v13 Facet deck as the visual source: hard left alignment, strong type, thin red rails, graphite blocks, paper surfaces, and clear numeric hierarchy.
- Build pages as one working canvas with ruled sections. Do not stack soft floating cards when a border or divider is enough.
- Use red for the next primary action, active route edge, or a true blocker. Never scatter red as decoration.
- Keep corners compact and shadows nearly flat. Pills are for short state labels only.
- Let key numbers and decisions carry the page. Supporting copy stays quiet and short.

## Product and jobs to be done

IronWrap OS is a proof-first roofing operations system for owners, operations, sales, production, accounting, and field crews. It turns live work into explicit next actions while preserving authority, evidence, safety, and offline recovery. The interface must feel dependable under field pressure, not like a generic analytics dashboard.

## Information architecture

- One authenticated shell adapts navigation by role.
- The header carries tenant identity, active role, system status, and sign-out.
- Desktop uses a persistent left rail; mobile uses a fixed bottom rail with horizontal overflow.
- A universal safety action rail is always present on authenticated screens.
- Pages use a consistent hierarchy: eyebrow/status → page title and next action → key signals → working queue/detail.
- Public estimate, portal, and acceptance flows intentionally sit outside the authenticated shell.

## Visual character

- Industrial, calm, direct, and human.
- Ivory working surfaces and neutral graphite chrome, derived from the Facet investor deck's disciplined light/dark frames.
- Facet red is action and focus, not decoration. Warning amber remains reserved for warning meaning.
- Status colors communicate meaning only. They tint icons and edges before they tint entire surfaces.
- Prefer solid surfaces, crisp borders, nearly flat elevation, and generous working whitespace.
- Avoid ornamental gradients, excessive glass effects, tiny dense controls, and invented illustration.

## Color tokens

Use the exact tokens from `app/src/styles.css`.

Light:

- background `#f2efe8`
- surface `#fffdf9`
- raised/control `#fffefb`
- foreground `#1a1d20`
- muted `#625e59`
- border `#cec7bd`
- accent/action `#c81d25`
- accent hover `#a9171e`
- accent active `#821219`
- focus `#e13b43`
- success `#326548`
- warning `#725d20`
- danger `#a9171e`
- information `#1f4e66`

Dark mode uses the exact paired values in the global stylesheet. Do not invent extra brand colors.

Authenticated navigation uses the invariant neutral-graphite `chrome`, `chrome-raised`, `chrome-foreground`, `chrome-muted`, and `chrome-border` semantic tokens. Chrome does not invert with the content color scheme.

## Typography

- Inter Variable for every interface surface.
- Body 16px; supporting copy 14px; mobile navigation labels 11px only where space constrained.
- Controls use 600–700 weight.
- Page titles and critical metrics use tight negative tracking.
- Use sentence case and operational language; avoid marketing headlines inside the app.

## Product voice

VOICE PROFILE
=============

Author: IronWrap OS
Goal: Help people see what happened, what matters, and what to do next in Grade 5 English.
Confidence: High

Source Set

- The user's Grade 5 copy direction
- Facet investor deck v13
- IronWrap's live job, safety, approval, and money workflows

Rhythm

- One idea per sentence. Most sentences stay under 18 words.

Compression

- Lead with the answer. Add one short next step only when it helps.

Capitalization

- Sentence case. Use all caps only for short eyebrow labels.

Parentheticals

- Do not use them in product copy.

Question Use

- Use only when the user must make a clear choice.

Claim Style

- Say what the system knows. Do not guess or hide an unknown state.

Preferred Moves

- Start buttons with a clear verb.
- Name the object: `Open job`, `Save check`, `Turn off link`.
- Errors say what happened, then what to do.
- Success states say what was saved or sent.

Banned Moves

- Internal API, queue, retry, or evidence jargon in visible copy.
- Long legal-sounding sentences when two short sentences are clearer.
- Vague buttons such as `Continue`, `Submit`, or `Process` without an object.
- Marketing claims inside task screens.

CTA Rules

- Use two to four words. Put the main action first. Name risky actions exactly.

Channel Notes

- Product UI: Grade 5 English; role and legal terms stay exact only when required.
- Email: plain subject, one action, clear expiry.
- Public pages: warm, direct, and free of sales pressure.

## Spacing, geometry, and elevation

- Base rhythm: 4px, composed mainly as 8/12/16/20/24/32.
- Control minimum: 44px compact, 48px standard, 64px field/mobile-primary.
- Radii: 4–8px controls, 8–12px containers.
- Borders and dividers define structure. Shadows are one-pixel lift and reserved for raised or fixed surfaces.
- `border-strong` is the hover/selected boundary; ordinary containers continue to use `border`.
- Office controls use a 48px default for useful density; compact controls stay at least 44px, while field-primary controls stay 64px.
- Desktop content max width: 1280px equivalent (`max-w-7xl`).
- The authenticated frame supports a 1600px shell while each page preserves its own 1280px reading width.
- Desktop sidebar: 240px graphite equipment rail; sticky header: 64px minimum.

## Components and states

- Buttons: default dark, Facet-red accent with exact hover/active steps, outline, ghost, and semantic danger variants.
- Cards: warm raised surface, 1px border, compact corner, near-flat shadow.
- Inputs: 64px field-friendly height with explicit invalid and focus states.
- Navigation selection uses one Facet-red leading edge on graphite. Route meaning never changes the active-navigation color.
- Command cards use a schedule rail, decision body, and one contextual action zone; blocker color appears on the leading edge and blocker copy only.
- Every asynchronous surface needs loading, empty, error, offline, and retry treatment.
- Metrics use tabular numerals where values change.
- Use Lucide icons only; icon plus label for unfamiliar or consequential actions.

## Responsive behavior

- Design from 320px upward.
- No horizontal page overflow.
- Desktop navigation becomes a bottom navigation rail below `lg`.
- Mobile bottom rail must not collide with the universal safety control or device safe area.
- Long office navigation scrolls horizontally with snap points instead of shrinking touch targets.
- Fixed content must leave enough bottom padding for shell chrome.

## Accessibility and motion

- WCAG AA contrast minimum; preserve the existing dark-mode danger foreground pairing.
- Visible 3px focus ring with offset.
- Semantic landmarks and labels; no color-only status.
- Respect `prefers-reduced-motion`; transitions are brief state feedback, never blocking.
- Safety, approval, money, and destructive actions require clear labels and states.
