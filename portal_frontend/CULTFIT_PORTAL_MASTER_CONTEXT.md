# CultFit Portal — Master Context

This is the source of truth for the InBody/CultFit Customer Portal and its
in-progress order-request workflow. Read this before making changes — it
exists so a future session (human or AI) doesn't have to re-derive any of
this from scratch. No secret values appear anywhere in this document.

Last updated: 2026-07-31, alongside the Phase 5 installation workflow build
(`feature/installation-workflow-v5`) described in §11.

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
3. Up to four accounts can exist: `admin@inbody.com` (role `admin`),
   `cultfit@curefit.com` (role `customer`, scope `cultfit_domain`), an
   optional `logistics` account (role `logistics`, Phase 4 — see §11) whose
   email/password come from `PORTAL_LOGISTICS_EMAIL`/`PORTAL_LOGISTICS_PASS`,
   and an optional `cs` account (role `cs`, Customer Care, Phase 5 — see
   §11) whose email/password come from `PORTAL_CS_EMAIL`/`PORTAL_CS_PASS`.
   Logistics and CS are each only added to the user list at all when
   **both** of their env vars are configured (fail closed — see
   `PORTAL_ENVIRONMENT.md`). All four are **shared** logins for the whole
   relevant team, not per-individual — see §11 Phase 6 for the planned fix.
4. Customer access must always fail closed — a customer with no/invalid scope
   gets 403, never a fallback to broad access. Logistics and CS reads share
   the exact same CultFit-domain resolution as admin (`authzDomain()` in
   `lib/odoo-server.ts` treats `admin`, `logistics` and `cs` identically for
   reads); every write-gated function still explicitly checks for the exact
   role(s) it should allow (e.g. dispatch writes: `admin`/`logistics` only;
   installation writes: `admin`/`cs` only), so a role this file doesn't
   explicitly grant a capability to is rejected by construction, not by
   omission.

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
order process. **Phases 1-5 are built.** The full intended flow:

```
New Request
  → CRM Opportunity created in Odoo                              [BUILT — Phase 1]
  → InBody reviews the request                                   [manual, Odoo-side]
  → InBody creates the quotation/PI                               [BUILT — Phase 2]
  → Customer views the PI in the portal                           [BUILT — Phase 2]
  → Customer confirms PI or requests correction                   [BUILT — Phase 2]
  → Customer uploads the official PO                              [BUILT — Phase 3]
  → InBody verifies the PO                                        [BUILT — Phase 3]
  → Logistics processes dispatch                                  [BUILT — Phase 4]
  → Customer sees invoice, dispatch and tracking details           [BUILT — Phase 4]
  → CS schedules installation                                     [BUILT — Phase 5]
  → CS updates installation status/notes through to completion     [BUILT — Phase 5]
  → Customer sees installation status read-only                    [BUILT — Phase 5]
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

## 11. Future phase roadmap

**Phase 2 — PI: BUILT** (`feature/pi-workflow-v2`, not yet merged/deployed —
see §14). Admin assigns a salesperson (`crm.lead.user_id`, live-loaded from
the union of the three "Sales" security groups — historical CultFit
salespeople were checked live and found to no longer be members of any
active Sales group, so the eligible list is today's roster, not frozen
history), then creates a **draft `sale.order`** from the request's own
stored details (never re-derived any other way), linked via
`opportunity_id`. Admin sets/confirms the main product price and validity
date, then **Publish PI**. Customer sees nothing until published; once
published, they can download the PDF and Confirm or Request Correction.

Do not build further phases without being explicitly asked to start that
phase.

**Why the PI PDF is NOT Odoo's native report** — verified live, do not
re-attempt without a real fix to one of these two blockers:
- Calling `ir.actions.report._render_qweb_pdf` over XML-RPC fails: *"Private
  methods ... cannot be called remotely."* The old public alias
  (`render_qweb_pdf`) no longer exists in this Odoo 19 instance either.
- The web `/report/pdf/<report>/<res_ids>` endpoint (what a browser hits on
  Print) needs an interactive session login. `POST /web/session/authenticate`
  with this portal's API credentials returns **"Access Denied"** — almost
  certainly because the Odoo service account was deliberately set up as
  API/XML-RPC-only (or is using an API key rather than a real password),
  with no backend/web login rights. Not a bug to route around.

So `lib/pi-pdf.ts` renders its own look-alike PDF (via `pdfkit`, no
headless-browser dependency — deliberately avoided given past Playwright/
gstack binary-mismatch friction in this dev environment) from data already
read via XML-RPC: line items, taxes, totals, company/GST details (verified
live from `res.company` id 1), and the same bank-details/T&C boilerplate
InBody's real quotations already carry (copied verbatim from live
historical CultFit orders — see `PI_TERMS` block in `lib/pi-pdf.ts`).
**Not byte-identical to Odoo's own template.** If InBody later provisions a
web-login-capable Odoo credential, the render path in `publishPI()`
(`lib/odoo-server.ts`) is the only place that would need to change.

**PI status/versioning has no new Odoo field or model** — same
zero-new-infrastructure approach as Phase 1: a structured JSON blob in an
HTML-comment chatter marker on the Opportunity, one marker per event
(`PORTAL_PI_DRAFT_CREATED`, `PORTAL_PI_SUPERSEDED`, `PORTAL_PI_PUBLISHED`,
`PORTAL_PI_CUSTOMER_RESPONSE`), decoded back out and matched by an explicit
`version` number embedded in the marker — never trusted from live
`sale.order` state, so a published version's numbers stay frozen even if
the underlying quotation is edited afterward (only `createPIRevision`
supersedes a version, by cancelling the old `sale.order` — `state:
'cancel'` — and creating a fresh one; PIs are never auto-confirmed, they
stay in Odoo's draft/quotation state even after publish). Version number =
`crm.lead.order_ids.length` at publish time (includes cancelled
predecessors, so it only ever increases).

Warranty years on the PDF are only asserted for the two products with a
verified historical rule (InBody 260/260S → 5 years, InBody 120 → 1 year,
`WARRANTY_YEARS_MAP` in `lib/odoo-server.ts`) — any other main product
prints a generic phrase rather than a guessed number.

Salesperson `Call`/`WhatsApp` buttons use `res.users.mobile_phone` (falling
back to `phone`) — note the field is `mobile_phone`, **not** `mobile`
(`mobile` doesn't exist on `res.users` in this instance, confirmed live via
a real fault). Never shown when neither is set.

### Controlled test results (2026-07-29, both test quotations cancelled and the test Opportunity archived afterward)

Full flow exercised against production Odoo (submit → assign salesperson →
create draft PI → publish → customer confirm) and verified field-by-field
directly against Odoo, not just the app's own responses. Two real bugs
found and fixed in the process:

- **`pdfkit` reads its font `.afm` files from disk relative to its own
  module path at runtime** — Turbopack/webpack bundling breaks that path
  resolution (`ENOENT ... C:\ROOT\node_modules\pdfkit\...`). Fixed by adding
  `serverExternalPackages: ["pdfkit"]` to `next.config.ts` — keeps it a real
  `node_modules` require instead of bundling it. Required for `pdfkit` to
  work in this app at all, on any environment (dev, Preview, Production).
- **pdfkit's core Helvetica font has no Indian Rupee glyph** (U+20B9 isn't
  in WinAnsiEncoding) — a literal `₹` silently rendered as a stray
  superscript "1". Fixed by using `"Rs. "` instead. Also fixed: the Terms &
  Conditions/Bank Details block was inheriting the narrow ~65pt column
  width left over from the totals section (pdfkit carries position/width
  state across `.text()` calls that don't pass explicit x/width) — now
  explicit full-width (`50, doc.y, { width: 495 }`) on every call in that
  section.

Verified: draft `sale.order` fields (`opportunity_id`, `partner_id` /
`partner_invoice_id` / `partner_shipping_id` all = CultFit partner, no new
address created, `company_id`, `user_id`, `pricelist_id`,
`client_order_ref`, `validity_date`, `date_order` auto-populated by Odoo's
own stock default) all correct; tax/line math correct (5%/18% GST applied
per product, bundle lines at ₹0); `Create Revision` correctly cancels the
prior `sale.order` (`state: 'cancel'`) and increments version; published
PDF downloads as a valid, well-formed, correctly laid-out PDF matching the
published snapshot exactly; customer confirm flips status correctly and a
second response is correctly rejected (400); admin list/detail and customer
view agree on status throughout.

**Phase 3 — PO: BUILT** (`feature/po-workflow-v3`, not yet merged/deployed —
see §13). Superseded the original plan of storing the PO as an
`ir.attachment`: the actual requirement (confirmed explicitly) is the
opposite — **the uploaded PO PDF is never persisted anywhere.** It exists
only as a `Buffer` for the duration of one request (`POST
.../po/extract`), is parsed synchronously, and goes out of scope when the
handler returns. No `ir.attachment`, no disk, no database, no logging of
its contents.

Flow: PI confirmed → customer uploads a PO PDF → server extracts structured
data (`lib/po-pdf-parser.ts`) → customer reviews/corrects the extracted
fields in the browser (nothing saved yet) → customer submits → server
re-validates every field from scratch (`lib/po-validation.ts`, nothing from
the extraction step is trusted just because it round-tripped unedited) →
compares the submission against the latest confirmed PI
(`lib/po-comparison.ts`) → admin reviews and Approves or Requests
Correction.

**PDF text extraction — library choice, verified live:**
- `pdf-parse` (the obvious first choice) was tried and **rejected**: its
  1.1.1 line (pinned initially for having zero native/binary deps, unlike
  2.x which pulls in `@napi-rs/canvas`) wraps a bundled pdf.js from **2017**
  (v1.10.100). Verified live: parsing the *same* synthetic PDF 10 times in a
  row intermittently threw `bad XRef entry` — a real, non-deterministic
  reliability bug, not a fluke, not an artifact of the test harness.
- Switched to **`pdfjs-dist` directly** (current, 6.x — also zero native
  deps), calling `getDocument()` + `getTextContent()` per page and grouping
  text items into lines by Y-transform (the same logic pdf-parse used
  internally, just against a maintained parser). Verified live: 10/10
  successful, byte-identical extractions on the same file.
- Marked `serverExternalPackages: ["pdfkit", "pdfjs-dist"]` in
  `next.config.ts` — same fix as pdfkit needed in Phase 2 (keeps it a real
  runtime import rather than something Turbopack tries to bundle).
- No OCR. Scanned/image-only PDFs correctly fail extraction with a clear
  error rather than silently returning nothing.

**Extraction is a best-effort, label-proximity text parser** (PO Number,
PO Date, Expected Delivery Date, Payment Terms, billing/shipping
company/address/city/state/PIN/GSTIN, product lines, totals, PI reference,
vendor, delivery contact, notes) — there is no real customer PO template to
calibrate against, so this was built and tested against synthetic PDFs, not
real InBody-received POs. **Known limitations, found and left as
documented limitations (the two-step review flow is the intended safety
net for exactly this):**
- City/state splitting from a single `"City, State, PIN"` address line is a
  loose heuristic and can mis-split — never blocks submission, always
  editable before the customer submits.
- Product-line table parsing is layout-sensitive: it locates the row region
  between a header row (`description`/`item` + `qty`/`quantity`) and a
  totals row, then classifies each row by whitespace **token** type
  (numeric vs. a short recognized unit word like "Nos"/"Pcs" vs. text) —
  deliberately NOT a digit-substring scan, because an early version of this
  matched digits *inside* a product code like `I9F300001` and produced
  garbage. Tables with very different column layouts than InBody's own
  quotations may still parse partially or not at all; missing columns are
  left `null`, never guessed.
- GSTIN uses the correct 15-character format regex (2-digit state + 10-char
  PAN + entity digit + literal `Z` + checksum) — an earlier version of this
  regex had one extra character class and silently matched nothing; fixed
  and verified against real-shaped test GSTINs.

**Odoo fields — verified live, read-only investigation, no guessing:**
- No dedicated PO number, PO date, or billing/shipping **text** field
  exists anywhere reachable. `crm.lead.billing_address_id` /
  `shipping_address_id` exist but are `many2one` to `res.partner` — usable
  only by pointing at an *existing* partner/contact, which is explicitly
  forbidden here (no new `res.partner`, no new child contacts, never touch
  partner 1822 or `sale.order.partner_invoice_id`/`partner_shipping_id`).
  So: PO data lives in structured chatter markers on the Opportunity — same
  zero-new-infrastructure pattern as Phase 1/2.
- Two **verified-unused** native fields are written, but only on admin
  approval, and only two: `sale.order.client_order_ref` (Customer
  Reference, char — confirmed empty on every sampled historical CultFit
  order) for the PO number, and `sale.order.commitment_date` (Delivery
  Date, datetime — also confirmed empty) for the expected delivery date.
  Nothing else on `sale.order`/`crm.lead` is touched by Phase 3.

**Markers** (base64 JSON in an HTML comment, same encoding as Phase 1/2):
`PORTAL_PO_SUBMITTED`, `PORTAL_PO_CORRECTION_REQUESTED`,
`PORTAL_PO_APPROVED`. Version = 1-indexed count of submissions so far
(never reused); a correction only "sticks" to the status if it targets the
*current latest* submission's version — a fresh resubmission always
supersedes an older pending correction, mirroring how `createPIRevision`
supersedes a stale PI response in Phase 2. Comparison warnings (product/
quantity/amount/tax mismatches vs. the confirmed PI) are computed at
submission time and frozen into that version's marker — **always shown,
never blocking submission**, per explicit business rule.

**PI eligibility gate** (shared by both the extract and submit steps):
latest PI must be published AND customer-confirmed; PO must not already be
`approved`; PO must not currently be `submitted` (awaiting review) — a
correction request from admin is what re-opens the ability to submit a new
version. Enforced in one function (`assertPoEligibleForWrite`), not
duplicated per route.

**Correction activity** reuses the exact fix already shipped in PR #3 for
PI corrections (`mail.activity.create` with resolved `activity_type_id`
via `mail.activity.type` lookup and `res_model_id` via `ir.model` lookup —
`activity_schedule()`'s convenience-method signature did not match this
Odoo 19 instance). If no salesperson is assigned, the correction marker is
still posted unconditionally (the record of the correction request must
never be lost); the missing-activity condition is surfaced back to the
admin as a warning, not silently swallowed.

**Phase 4 — Logistics, billing invoice & dispatch tracking: BUILT**
(`feature/logistics-workflow-v4`, not yet merged/deployed — see §13). A
new shared `logistics` role (see §2) can see every CultFit order — not
just portal-submitted ones, including orders that predate the portal
entirely — and update invoice/dispatch tracking info. Admin can also view
everything logistics sees (`authzDomain()`/every logistics function treats
`admin` and `logistics` identically for reads and for the dispatch/invoice
writes specifically — see below).

**account.move (invoice) is the only source of truth for billing data —
the portal never creates one.** A lead's linked sale.order(s) →
`invoice_ids` are filtered to `move_type = 'out_invoice'` (never a credit
note) and `state = 'posted'` (never draft/cancelled — a draft could still
change), re-verified against `CULTFIT_PARTNER_ID` independently of the
lead-scoping already in place. Verified live: a real CultFit sale order
had **two** linked invoices — one real `out_invoice` and one `out_refund`
credit note — confirming the `move_type` filter is load-bearing, not
theoretical. When exactly one valid invoice exists it's used automatically;
when more than one exists, logistics must explicitly select the correct
one (`PORTAL_INVOICE_LINKED` chatter marker) — the selection is re-verified
server-side against the current candidate list every time, so a
since-cancelled invoice can never stay "selected." The customer's PDF
download reuses the existing `ir.attachment` ownership-check pattern
(`res_model = 'account.move'`, scoped to the resolved invoice id only —
never a client-supplied one).

**stock.picking (dispatch) is the only source of truth for delivery
data — the portal never creates, confirms, reserves, or validates one.**
Verified live: a real CultFit sale order had **two** pickings — an
outgoing delivery and a separate return — confirming the dispatch tracking
here must filter to `picking_type_id.code = 'outgoing'` specifically
(`sale.order.picking_ids` alone is not enough). When an outgoing picking
exists, only **three** native fields are ever written:
`scheduled_date`, `carrier_tracking_ref`, `carrier_tracking_url` — never
picking `state`, never `date_done` (Odoo sets that itself on real
validation, which this portal never triggers), never `carrier_id` (a
many2one requiring an existing `delivery.carrier` record — verified live
that only one generic "Standard delivery" carrier exists in this Odoo
instance and none of it is realistically usable for actual Indian courier
names, so courier/transporter is kept as portal metadata text instead).
Everything else — courier name, dispatch date, actual delivery date, the
portal's own richer `DeliveryStatus` enum (`not_started` →
`logistics_processing` → `ready_to_dispatch` → `dispatched` → `in_transit`
→ `delivered`, plus a parallel `delivery_issue`), and the logistics note —
lives in structured chatter markers (`PORTAL_LOGISTICS_UPDATED` /
`PORTAL_DISPATCHED` / `PORTAL_DELIVERED`, chosen only for how the
chatter/timeline reads at each transition — all three decode identically).
When no outgoing picking exists yet, every field lives in metadata only;
once a picking exists, its own state/tracking-ref/tracking-url are
preferred over metadata for the fields Odoo actually has, while metadata
stays authoritative for everything Odoo has no field for. Tracking URLs
are validated to `http`/`https` only (rejects `javascript:` and any other
scheme) before ever being stored or rendered as a clickable link.

**No new Odoo model, no second CRM stage system** — same
zero-new-infrastructure pattern as Phase 1-3. `crm.lead.stage_id` remains
the one overall CRM stage; invoice/dispatch status are their own
independent, real-data-backed concepts layered on top, not folded into it.

**Logistics dashboard** (`/logistics`) shows every CultFit order (up to
500, `search_read` limit) with summary counts and filters (search,
salesperson, PO/invoice/delivery status, courier, sort) computed
client-side over the already-fetched list — no server-side pagination or
per-filter query params, since the CultFit order volume (order of ~100)
doesn't currently warrant it. `/logistics/orders/[id]` shows the same
read-only order context every other role sees (customer, product bundle,
salesperson, confirmed PI, approved PO incl. its billing/shipping
addresses) plus the editable invoice-selection and dispatch sections.

**Phase 5 — Installation (CS — Customer Care): BUILT**
(`feature/installation-workflow-v5`, not yet merged/deployed at time of
writing — see §13). A new shared `cs` role can see every CultFit order
(same domain as logistics/admin) and schedule/track installation through
to completion. Admin can also view/manage everything CS can.

**Read-only investigation confirmed no reliable, already-used native
mechanism exists for installation tracking on CultFit orders specifically**
— the original assessment above (`installation.data` unreliable, only 1
record system-wide, no crm.lead/sale.order link) was re-verified live and
still holds, plus several more candidates were checked and ruled out:
- `crm.lead.cs_person` (many2one `res.users`, "CS Person") is real and
  semantically exactly "Assigned CS" — but is `false`/empty on every real
  CultFit order checked (verified across 4 real orders with completed
  deliveries). Never populated in practice. **Not written from the
  portal** — writing to a core, heavily-automated model's user-assignment
  field with zero visibility into what else might react to it (activity
  creation, notifications) is a real risk the Phase 4 dispatch precedent
  explicitly avoids for its own narrow fields; "Assigned CS" is instead
  whoever last touched the portal's own installation metadata for that
  order — read-only in the customer view, informational in the CS view.
- `crm.lead.x_studio_machine_installed_at` looks installation-related by
  name but is actually a location-**type** classifier (Gym, Clinic,
  Hospital, Home, School/College, ...) — completely unrelated to
  installation status. A real false lead the live re-verification caught.
- `stock.picking.is_installation_required` (boolean) is real and `true` on
  every real CultFit outgoing delivery checked — reused as read-only
  display context only (`InstallationInfo.installationRequired`), never
  written.
- `stock.picking.installation_count` is `0` on every real CultFit order
  checked — it counts linked `project.task` records, and zero exist.
- `project.task` is a real, actively-used Odoo model (364 records
  system-wide, genuine `sale_order_id` FK) — but **zero** are linked to
  any real CultFit sale order checked. Auto-creating one from the portal
  would be creating a new Odoo business record, which the spec explicitly
  disallows; not integrated.
- `account.move.is_sale_installed` (boolean) is real and `true` on the
  real CultFit invoices checked — a reasonable coarse signal, but
  boolean-only (no date/installer/notes), so it can't carry the full
  status/schedule/notes model this phase needs. Not integrated.
- `maintenance.equipment`/`maintenance.request` don't exist in this Odoo
  instance (Maintenance app not installed). `calendar.event` exists and is
  heavily used elsewhere (5,532 records) but not for CultFit installation
  — not integrated, to avoid a second scheduling surface beyond the
  portal's own Scheduled Date/Time fields.

**Conclusion, same pattern as Phase 4 dispatch:** no native field is both
reliably linked to crm.lead/sale.order AND safe to write, so installation
status/schedule/notes/completion live entirely in structured chatter
metadata (`PORTAL_INSTALLATION_SCHEDULED` / `_UPDATED` / `_STARTED` /
`_COMPLETED`, versioned, latest-by-date wins on read — identical mechanics
to `DispatchMetadataRecord`). `InstallationStatus` is exactly the 5 states
requested: `not_scheduled` → `scheduled` → `in_progress` → `installed` →
`completed`. No new Odoo model, no new field, no new activity, no
`project.task`/`installation.data`/`calendar.event` record ever created by
the portal.

CS dashboard (`/cs`) mirrors the logistics dashboard exactly (summary
cards, filters, desktop table + mobile cards). `/cs/orders/[id]` shows the
same read-only order context (customer, product, salesperson, CRM stage,
delivery status) plus the editable Installation panel (status, date, time,
notes, completion notes). Customer view (`CustomerInstallationSection`,
added to both `/orders/[id]` and `/requests/[id]`, same
fail-silently-on-error pattern as `CustomerLogisticsSection`) is read-only.

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
- Phase 2: customer can never supply/change salesperson id, main product
  price, quotation id, or attachment id — all resolved/verified server-side.
  A draft PI is never visible to the customer (the customer-facing fetch
  path only ever reads published chatter snapshots, never a draft
  `sale.order`, by construction). PI PDF download re-verifies the attachment
  belongs to the specific `sale.order` in the published snapshot before
  reading it (same ownership-check pattern as the existing quotation/invoice
  attachment downloads). Unpublished/nonexistent PI returns an identical
  safe 404 either way.
- Phase 3: the uploaded PO PDF is never persisted — no `ir.attachment`, no
  disk, no database, no logging of its bytes or extracted raw text; it lives
  only as a `Buffer` for the extract request's duration. Every field in the
  customer's final submission is re-validated server-side
  (`lib/po-validation.ts`) regardless of what extraction returned. Customer
  can never supply/change partner id, salesperson id, PI version, quotation
  id, or attachment id in the PO flow either — the respond/submit/approve
  routes only ever read the specific fields they whitelist. PDF upload is
  validated by magic bytes (not just declared MIME/extension), capped at
  4MB (safely under Vercel's 4.5MB hard platform limit), and
  encrypted/malformed PDFs fail with a clear, generic error — never a raw
  parser stack trace. PO extraction/submission is gated by the same
  eligibility check as either action (PI confirmed, not already approved,
  not already awaiting review) — enforced once, not duplicated per route.
- Phase 4: `PORTAL_LOGISTICS_EMAIL`/`PORTAL_LOGISTICS_PASS` fail closed
  exactly like `CULTFIT_PARTNER_ID` — missing either one disables logistics
  login only, never widens/narrows admin or customer access, never throws.
  `authzDomain()` and every logistics read/write function treat `admin` and
  `logistics` identically; `proxy.ts` gates `/logistics/*` to those two
  roles only, `/admin/*` and `/dashboard|/requests/*` are unaffected. Every
  logistics mutation route whitelists an exact, named field set from the
  request body — no arbitrary Odoo model/field/method ever reaches
  `executeKw` from client input. Invoice selection is re-verified
  server-side against the live candidate list on every read, not trusted
  from a stored id alone, so a since-cancelled/reissued invoice can never
  stay "selected." Dispatch tracking URLs are parsed and restricted to
  `http`/`https` only (`javascript:`/`data:`/any other scheme rejected)
  before being stored or rendered. The portal never creates an
  `account.move` or `stock.picking`, never confirms a sale order, never
  writes picking `state`/`date_done`, never reserves or validates stock —
  the only native `stock.picking` writes are `scheduled_date`,
  `carrier_tracking_ref`, `carrier_tracking_url`, wrapped so a write
  failure there never loses the corresponding chatter-metadata record. The
  customer's invoice PDF download re-verifies the invoice belongs to the
  customer's own linked sale order and to `CULTFIT_PARTNER_ID` before
  reading any `ir.attachment` bytes — same pattern as the existing PI PDF
  download.
- Phase 5: `PORTAL_CS_EMAIL`/`PORTAL_CS_PASS` fail closed exactly like the
  logistics pair — missing either one disables CS login only, never
  widens/narrows any other role's access, never throws. `authzDomain()`
  treats `admin`, `logistics`, and `cs` identically for reads;
  `proxy.ts` gates `/cs/*` to `cs`/`admin` only, every other route's
  gating is unaffected. The installation mutation route whitelists an
  exact, named field set (`status`, `scheduledDate`, `scheduledTime`,
  `installationNotes`, `completedOn`, `completionNotes`) — no arbitrary
  Odoo model/field/method ever reaches `executeKw` from client input, and
  no partner/salesperson/product/CRM-stage field is ever accepted from
  either the CS or customer side. Customer cannot access `/cs/*` pages or
  call the installation-update route (customer role is rejected there by
  construction, same as every other role-gated route). The portal never
  writes any native Odoo field for installation (see §11) — every write
  is a chatter marker only, so there is no risk of an unverified write
  interacting with existing Odoo automation on `crm.lead`.

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
- Phase 2 work happens on `feature/pi-workflow-v2` (branched from `main`
  after Phase 1 was merged/deployed). Same controlled-test discipline
  applies before release: a real `sale.order`/PI/attachment/chatter marker
  should only be created against production Odoo with explicit approval,
  verified field-by-field, then archived/cancelled if it was purely a test.
- Phase 3 work happens on `feature/po-workflow-v3` (branched from `main`
  after Phase 2 and the PI-correction-activity fix (PR #3) were merged/
  deployed). Same controlled-test discipline — a real PO submission
  (chatter markers only; no PDF is ever persisted regardless) should only
  be created against production Odoo with explicit approval, verified
  field-by-field, then archived/cancelled if it was purely a test.
- Phase 4 work happened on `feature/logistics-workflow-v4` (branched from
  `main` after Phase 3 was merged/deployed), plus a follow-up fix branch
  `fix/phase4-production-verification`. Merged and deployed to Production;
  `PORTAL_LOGISTICS_EMAIL`/`PORTAL_LOGISTICS_PASS` are configured in local
  `.env.local`, Vercel Preview, and Vercel Production.
- Phase 5 work happens on `feature/installation-workflow-v5` (branched
  from `main` after Phase 4 was merged/deployed). Not yet merged or
  deployed. `PORTAL_CS_EMAIL`/`PORTAL_CS_PASS` must be added manually to
  local `.env.local`, Vercel Preview, and Vercel Production before the CS
  role works in each environment (see `PORTAL_ENVIRONMENT.md`) — same
  operational pattern as the logistics pair. Same controlled-test
  discipline applies before release: scheduling/updating installation
  status against production Odoo should only happen with explicit
  approval, verified field-by-field (including that no native Odoo field
  was written and no `project.task`/`installation.data` record was
  created), then the test's chatter markers cleaned up afterward.
