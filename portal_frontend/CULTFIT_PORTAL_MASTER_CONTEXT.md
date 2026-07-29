# CultFit Portal — Master Context

This is the source of truth for the InBody/CultFit Customer Portal and its
in-progress order-request workflow. Read this before making changes — it
exists so a future session (human or AI) doesn't have to re-derive any of
this from scratch. No secret values appear anywhere in this document.

Last updated: 2026-07-29, alongside the "resolve contact server-side" change
described in §9–10.

---

## 1. Architecture

Single Next.js 16 (App Router) application, deployed to Vercel. No separate
backend — `app/api/**` route handlers talk to production Odoo directly over
hand-rolled XML-RPC (`lib/odoo-server.ts`). There used to be a FastAPI
middleware (`portal_backend/`); it is fully retired and not used by any
current code path. **Do not revive it. Do not create a second backend.**

```
Browser
  │  httpOnly session cookie (same-origin)
  ▼
Next.js API routes (app/api/**)  ──XML-RPC──▶  Production Odoo 19
  │
  ▼
Next.js pages (app/**), gated server-side by proxy.ts
```

Stack: Next.js 16 App Router, React, TypeScript, Tailwind CSS, JWT auth in an
httpOnly cookie, Vercel hosting, GitHub deployment.

Key server-only files:
- `lib/odoo-server.ts` — the only place Odoo XML-RPC logic lives. `import
  'server-only'` enforced at build time. Never import this client-side.
- `lib/auth-server.ts` — JWT sign/verify, the httpOnly cookie, `PORTAL_USERS`
  (the only user store).
- `lib/auth.ts` — client-side session helpers (never holds secrets).
- `lib/api.ts` — client-side fetch wrapper for this app's own API routes.
- `lib/stage-config.ts` — single source of truth for stage labels, shared by
  server and client code.
- `types/index.ts` — shared TypeScript types, mirrors the exported shapes
  from `lib/odoo-server.ts`.
- `proxy.ts` — Next.js 16's replacement for `middleware.ts`. Server-side page
  gating (redirects unauthenticated/wrong-role users before a page renders).
  Defense in depth, not the primary boundary — every API route independently
  re-verifies auth and role.

### Rules that must not be violated

- `portal_frontend` is the only active portal application.
- Do not modify or revive the FastAPI backend (`portal_backend/`).
- Do not create a second backend.
- Do not modify Odoo core.
- Do not expose Odoo credentials to the browser.
- Do not expose JWTs, passwords, secrets, or raw Odoo faults to the client.
- Do not add an external database without explicit approval.

---

## 2. Authentication & authorization

1. `POST /api/portal/auth/login` checks credentials against `PORTAL_USERS`,
   signs a JWT containing only `{sub, email}` (no role/permissions — role is
   never trusted from the token), sets it as an httpOnly, `SameSite=Lax`,
   `Secure`-in-production cookie named `portal_session`.
2. Every protected route calls `requireAuthUser(req)`, which re-resolves role
   and scope fresh from `PORTAL_USERS` by email on every request — a config
   change takes effect on the very next request, not after token expiry.
3. Exactly two accounts exist today: `admin@inbody.com` (role `admin`) and
   `cultfit@curefit.com` (role `customer`, scope `cultfit_domain`). This is a
   **shared** login for the whole CultFit relationship, not per-individual —
   see §11 Phase 6 for the planned fix.
4. Customer access must always fail closed — a customer with no/invalid scope
   gets 403, never a fallback to broad access.

### CultFit identification — id-based, not name-based

**`CULTFIT_PARTNER_ID` (server-only env var, currently `1822`)** is the single
source of truth for which Odoo commercial partner is CultFit. Every CultFit
read/write resolves access through `partner_id.commercial_partner_id =
CULTFIT_PARTNER_ID` (`cultfitDomain()` in `lib/odoo-server.ts`).

**Do not use company-name matching as the authorization source.** This
project shipped with a name-based domain (`ilike 'cultfit'`, `'curefit'`,
etc.) initially. On 2026-07-29, InBody's team renamed the canonical CultFit
partner in production from "CULTFIT HEALTHCARE PRIVATE LIMITED" to "CULT.FIT
LIMITED" — live, mid-build — which silently broke the name match and dropped
the visible order count from ~85 to 3, for every existing CultFit view
(dashboard, admin, order detail), not just new code. An id survives a rename;
a name does not. The old name-based domain is kept only as an inert,
opt-in diagnostic (`checkCultFitPartnerDrift()`), never wired into any
authorization path.

The customer must never supply or influence: `partner_id`, `customer_id`,
salesperson id, stage id, or price, in any request. These are always resolved
server-side.

---

## 3. Odoo integration

`crm.lead` is the core "order"/"request" record for this portal — not
`sale.order`. `lib/odoo-server.ts` exports two families of functions:

- **Existing order tracking** (`fetchCultFitOrders`, `fetchCultFitOrderById`,
  `updateCultFitStage`, `setCultFitStage`, attachment download) — reads/writes
  real, already-placed orders via `deal_status_id` (a custom `deal.status`
  model) and `stage_id` (standard `crm.stage`). This is separate from and
  predates the New Order Request feature below.
- **New Order Request** (`createPortalOrderRequest`, `fetchPortalOrderRequests`,
  `fetchPortalOrderRequestById`, `fetchCultFitProductCatalog`) — the feature
  documented in §4 onward.

Odoo reliability: `rpcPost()` has a 15s timeout; timeout/network failure
raises `OdooUnavailableError` → generic 503, never a raw Odoo fault or stack
trace to the client. `executeKw()` retries once on a stale cached uid, never
on `OdooUnavailableError`.

---

## 4. Business objective — full intended workflow

The portal is meant to eventually replace the entire email-based CultFit
order process. **Only the first stage (New Request) is built today.** The
full intended flow, for future phases to follow:

```
New Request
  → CRM Opportunity created in Odoo                              [BUILT]
  → InBody reviews the request                                   [manual, Odoo-side]
  → InBody creates the quotation/PI                               [Phase 2]
  → Customer views the PI in the portal                           [Phase 2]
  → Customer confirms PI or requests correction                   [Phase 2]
  → Customer uploads the official PO                              [Phase 3]
  → InBody verifies the PO                                        [Phase 3]
  → Logistics processes dispatch                                  [Phase 4]
  → Customer sees invoice, dispatch and tracking details           [Phase 4]
  → Installation is scheduled                                     [Phase 5]
  → Installation update/report is added                           [Phase 5]
  → Order is marked completed                                     [Phase 5]
```

See §11 for the full phase-by-phase roadmap. **Do not build future phases
without being explicitly asked — this document exists so that when you are
asked, the plan doesn't need to be re-derived.**

---

## 5. Phase 1 implementation (current state)

Pages:
- `/requests/new` — New Order Request form
- `/requests` — My Requests (list, customer-only, portal-submitted requests only)
- `/requests/[id]` — Request detail

API routes:
- `GET /api/portal/cultfit/products` — product picker catalog
- `GET /api/portal/cultfit/requests` — list
- `POST /api/portal/cultfit/requests` — create
- `GET /api/portal/cultfit/requests/[id]` — detail

Phase 1 supports: customer creates a request → a `crm.lead` Opportunity is
created, linked to the existing CultFit partner, starting in the real Odoo
stage "New", salesperson intentionally blank (admin assigns later); customer
views current/previous requests and their status; product bundle, COCO/FOFO,
delivery address and notes are stored; duplicate requests within 5 minutes
are blocked (409); mobile navigation exists; the customer cannot edit or
cancel after submission. **No `res.partner`, `sale.order`, PI, invoice, or
email is created in Phase 1.**

### Mandatory Odoo fields discovered live (not in any spec, found via real faults)

- `crm.lead.industry_id` is mandatory in this Odoo instance (an
  instance-specific customization, not stock Odoo behavior). Resolved
  dynamically by name ("Fitness") — verified 100% of existing CultFit leads
  (80/80) use this value.
- `crm.lead.sub_industry_id` is also mandatory, but has no single dominant
  historical value (CultFit leads split ~81%/12%/6% across "High Budget
  Fitness" / "Medium" / "Low"). **Temporarily defaulted to "High Budget
  Fitness"** — an internal placeholder, not a verified-correct classification
  per request. Do not ask the customer to select sub-industry; InBody admin
  may correct it manually in Odoo per request.

### Controlled test results (already confirmed, both test Opportunities archived)

Opportunity linked to partner 1822; stage "New"; salesperson blank
(`user_id: false`); product bundle stored correctly; COCO/FOFO stored;
delivery details stored; chatter note created; duplicate request returned
409; My Requests and Request Detail worked; lint and build passed.

---

## 6. Opportunity creation — confirmed rules

On submission, create only:
- One new `crm.lead` Opportunity
- One structured chatter note (`message_post`, `subtype: mail.mt_note`)

**Never create:** `res.partner` (no new customer/contact), `sale.order`,
`sale.order.line`, PI, invoice, picking, installation record, or email.

### `crm.lead` fields actually written on create

```
name              — the customer-entered request/location name
type              — 'opportunity'
partner_id        — CULTFIT_PARTNER_ID, resolved server-side
stage_id          — resolved server-side, the real Odoo "New" stage
industry_id       — resolved server-side, "Fitness"
sub_industry_id   — resolved server-side, "High Budget Fitness" (placeholder)
user_id           — explicit `false` (not omitted — Odoo's own team/onchange
                     defaults silently auto-assign a salesperson if this key
                     is left out entirely; discovered live)
description       — structured HTML + a base64 JSON blob in an HTML comment
                     (see §8)
```

Note: `contact_name` / `phone` / `email_from` are **not** set on the lead as
of the 2026-07-29 contact-resolution change (see §9) — contact details live
only in the structured `description` metadata now, not as native lead
fields. (Earlier Phase 1 builds did set these from customer-typed form
input; that form input no longer exists.)

Everything else is resolved server-side and never trusted from the client:
CultFit partner, initial stage, industry, default sub-industry, product
mapping, included free products, portal account identity, submitted date,
and (as of 2026-07-29) contact/company details.

---

## 7. Product and package rules

Customer selects only the main machine and quantity — **never prices**. The
product picker (`fetchCultFitProductCatalog`) is built live from products
already used in real CultFit/Curefit order lines, not the full Odoo catalog
(1,835 products) and not a hardcoded list — a genuinely new main model shows
up automatically the first time InBody staff use it in a real order.

Verified bundle rules (from real historical order-line data, not guessed):

| Main product | Included free |
|---|---|
| InBody 260 / InBody 260S (`I9V600002`) | HP 1008A printer (`IIPLPR002`) + LB WEB_B_1Y (`O40208301`) |
| InBody 120 (`I9F300001`) | Stand 120 (`Z9ZZ04006`) + LookinBody120 (`L9I100039`) |

Other products appear in CultFit history (NF1500, InBody270S) but have **no
verified bundle rule** — deliberately left unmapped rather than guessed; they
remain selectable as a main product with no automatic inclusions.

A deprecated SKU ("Not Use_LB WEB Membership Fee") and a legacy-duplicate
260S entry are excluded from the picker outright.

Requirements: use verified Odoo product records; never create duplicate
products; never trust a client-supplied product id without re-validating it
against the live catalog server-side; never let the customer submit or see
prices; store main product + quantity + included free products in the
Opportunity's structured metadata; **do not create `sale.order.line` records
in Phase 1.**

---

## 8. Structured metadata format (`crm.lead.description`)

`description` (an html field) holds a human-readable rendering (visible
normally to InBody staff in Odoo) plus a machine-readable block:

```
<!--PORTAL_REQUEST_DATA:{base64-encoded JSON}-->
```

Base64-wrapping means customer-entered text can never break the HTML-comment
syntax regardless of content. The literal marker `PORTAL_ORDER_REQUEST` is
also present in the human-readable text — "My Requests" filters on
`description ilike 'PORTAL_ORDER_REQUEST'`, ANDed with the normal CultFit
authorization domain. No new Odoo field or model exists for this.

Current JSON shape (`PortalRequestDetails` in `lib/odoo-server.ts` and
`types/index.ts` — keep these two in sync):

```ts
{
  requestName: string;
  cocoFofo: 'COCO' | 'FOFO';
  mainProduct: { id: number; code: string; name: string };
  quantity: number;
  includedProducts: { id: number; code: string; name: string }[];
  deliveryAddress: string;
  preferredDeliveryDate: string | null;
  notes: string;
  portalAccount: string;       // authenticated portal login email
  submittedDate: string;
  cultfitCompany: string | null;   // resolved server-side, see §9
  contact: {                        // resolved server-side, see §9 — or null
    name: string | null;
    phone: string | null;
    email: string | null;
    source: 'portal-mapped' | 'primary-contact' | 'company' | 'portal-account-only';
  } | null;
  // Legacy — only present on records created before 2026-07-29. Never
  // written by current code. The decoder and UI must keep reading these
  // safely so old requests don't break.
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string | null;
}
```

---

## 9. Contact resolution (added 2026-07-29)

**The CultFit customer/contact already exists in Odoo — the portal must not
ask the customer to retype contact information it already has.** The New
Order Request form no longer collects Contact Person Name / Phone / Email.

### Odoo contact structure found for partner 1822 (verified live, read-only)

- Partner 1822 itself ("Cult Healthcare Private Limited"): `phone` looks like
  a dummy placeholder value (a suspicious all-9s pattern); `email` is
  `guru.hugar@curefit.com`.
- Two child contacts: id 4361 (`type: 'contact'` — Odoo's own convention for
  "the" default/primary contact on a company), with a real-looking phone
  number and the **same** email as the parent; id 7292 (`type: 'other'`),
  with no phone and an unrelated-looking personal email — not treated as
  reliable.
- **No `res.partner` anywhere has an email matching the portal login**
  (`cultfit@curefit.com`) — the shared login is not mapped to any specific
  Odoo contact today.
- 100% of existing CultFit leads (80/80) use `partner_id = 1822` directly
  (the company), never a child contact — matches how this portal already
  sets `partner_id`.

### Resolution priority (`resolveCultFitParty()` in `lib/odoo-server.ts`)

1. A contact under the CultFit partner whose email matches the authenticated
   portal account exactly. (None exists today — kept as priority 1 so this
   resolves correctly the moment a future per-user account is mapped; see
   §11 Phase 6.)
2. The CultFit company's primary contact (`type='contact'`), if it has a
   phone or email.
3. The company record itself (`partner_id = CULTFIT_PARTNER_ID`), if it has
   a phone or email.
4. Fallback: only the portal account's own email — never invented, never a
   blank field presented as real data.

If this priority ever produces genuinely ambiguous results in the future
(e.g. multiple equally-plausible primary contacts), **do not guess** — omit
contact display rather than pick arbitrarily, and document the ambiguity
here for a future per-user-login fix (§11 Phase 6) rather than resolving it
with more heuristics.

Contact info, when resolved, may be shown **read-only** in the request
detail UI. A missing/unreliable contact must never block submission — the
form has no contact fields to validate in the first place.

---

## 10. COCO / FOFO

Production Odoo currently has **no dedicated COCO/FOFO field** on `crm.lead`
or `sale.order` (confirmed live via `fields_get` — nothing matching
`fofo|coco|franchise|owned`). Stored only in the structured `description`
metadata (§8), isolated to one field end-to-end so moving it to a real Odoo
Studio field later is a localized change. **Do not create an Odoo field
automatically** — that requires an explicit decision from InBody.

---

## 11. Future phase roadmap — document only, not built

Do not build these without being explicitly asked to start that phase.

**Phase 2 — PI:** InBody staff creates the quotation/PI in Odoo. Portal
detects the linked `sale.order`. Customer downloads the PI (Odoo already has
a native report for this: `sale.report_saleorder_pro_forma` — no custom
template needed). Customer confirms the PI or requests a correction.
Call/WhatsApp actions. "PI Ready" status.

**Phase 3 — PO:** Customer uploads the official PO PDF as `ir.attachment`
(create rights already confirmed on this model). InBody verifies the PO. PO
status and document history. Attachment authorization must follow the same
ownership-check pattern already used for downloads (verify the attachment
genuinely belongs to a sale order/invoice reachable from the authorized
lead before accepting/serving it).

**Phase 4 — Dispatch & invoice:** Dispatch status from `stock.picking`
(confirmed readable: `carrier_id`, `carrier_tracking_ref`,
`carrier_tracking_url`, `scheduled_date`, `date_done`). Invoice details and
PDF from `account.move` (already used for the existing order-tracking
attachment-download feature).

**Phase 5 — Installation:** Blocked until a reliable order link exists.
`installation.data` is a real model (installer, date, checklist, signatures)
but has almost no production usage (1 record system-wide as of the last
check) and no direct link to `crm.lead`/`sale.order` (only `partner_id` +
`lot_id`/serial number). **Do not build installation integration until a
reliable link and an approved operational process exist.**

**Phase 6 — Per-user accounts:** Replace the single shared
`cultfit@curefit.com` login with per-individual CultFit accounts,
location-based permissions, cross-device portal notifications with unread
tracking (requires server-side persistence — the portal has no database
today; **do not add one without explicit approval**), and customer role
separation. This is also what would let §9's contact-resolution priority 1
("mapped to the portal user") actually activate.

Portal notifications, near-term: basic update indicators can compare Odoo
`write_date`/chatter timestamps against a browser-side last-seen value —
works today, no new infra, but is per-browser only (doesn't survive across
devices for the shared login) until Phase 6.

---

## 12. Security checklist (must remain true after any change)

- `CULTFIT_PARTNER_ID` stays server-only, read only in `server-only`-guarded
  files, fails closed (throws, not silently broad) if missing/invalid.
- Customer can never supply or change: partner id, customer id, salesperson
  id, stage id, product price, Odoo model name.
- Every mutating POST route checks same-origin (`Origin` header, when
  present) and requires `Content-Type: application/json`.
- Every client-supplied product id is re-validated against the live,
  server-computed "already used by CultFit" catalog — never trusted blindly.
- Quantity validated as an integer in range; text fields length-limited and
  HTML-escaped before being embedded in `description`/chatter.
- Duplicate-request protection returns 409 (best-effort client-side disable
  of the submit button as well; no server-side idempotency key, since that
  would need persistence this app doesn't have — documented, not overclaimed).
- Odoo faults are never surfaced raw to the client — always a generic 503,
  logged server-side only.
- No customer, sale order, PI, invoice, or email is created anywhere in
  Phase 1.

---

## 13. Deployment

- Feature work happens on `feature/pi-request-v1`.
- Correct Vercel project: **`inbody-cultfit-portal-mgrl`** (Root Directory
  `portal_frontend`, Next.js). There is a second, similarly-named project,
  `inbody-cultfit-portal` — that one is the **old FastAPI backend**
  (`portal_backend`). Do not touch it.
- Production portal: `https://inbody-cultfit-portal-mgrl.vercel.app`.
- `CULTFIT_PARTNER_ID` must be configured in Vercel for **every** environment
  it runs in (local `.env.local`, Preview, Production) — it does not travel
  with the code (this repo's `.gitignore` excludes all `.env*` files,
  including `.env.example` — see `PORTAL_ENVIRONMENT.md` for the full
  variable reference).
- Do not merge into `main` or deploy to production without explicit approval.
- Do not create a real production Opportunity without explicit approval —
  use the controlled-test pattern (submit one clearly-labeled test request,
  verify every field directly against Odoo, then archive it) instead.
