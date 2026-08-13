# InBody × CultFit Customer Portal — Production Handover

**Status: Live in Production. Handed over as of 2026-08-13.**

This is the top-level handover document for the portal. It is written for
whoever picks up ownership next — support, a future developer, or InBody
management — and assumes no prior context. For deep implementation detail
beyond what's summarized here, the source of truth remains
`CULTFIT_PORTAL_MASTER_CONTEXT.md` (architecture/business-rule history) and
`PORTAL_ENVIRONMENT.md` (env var reference); this document is the map that
tells you when to go read those, not a replacement for them.

---

## 1. Project overview

A self-service Next.js web portal that lets InBody's CultFit franchise
account place, track, and manage InBody equipment orders end-to-end —
replacing what used to be an entirely email-based process. Four workflow
phases are built and live: order request → quotation (PI) → purchase order
(PO) → dispatch/invoice → installation, each with its own role (customer,
admin, logistics, CS). No new backend, no new database — every workflow
step reads and writes InBody's real production Odoo instance directly.

## 2. Production URL

**https://inbody-cultfit-portal-mgrl.vercel.app**

Vercel project: `inbody-cultfit-portal-mgrl` (org `inbody01`). There is a
similarly-named, unrelated second Vercel project, `inbody-cultfit-portal`
— that one is the retired FastAPI backend. **Never deploy to it.**

## 3. Technology stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16.2.7 (App Router, Turbopack), React 19.2.4, TypeScript 5 |
| Styling | Tailwind CSS 4 |
| Auth | Hand-rolled HS256 JWT (Node `crypto`, no external JWT library) in an httpOnly cookie |
| Odoo client | Hand-rolled XML-RPC (`lib/odoo-server.ts`) — no Odoo SDK dependency |
| PDF (PO parsing) | `pdfjs-dist` 6.x |
| PDF (legacy, unused) | `pdfkit` — kept only so old already-rendered PDF bytes aren't affected; no longer called |
| Hosting | Vercel (Next.js-native), GitHub-integrated auto-deploy |
| Database | **None.** All portal-specific state lives in structured, versioned, base64-JSON chatter markers on the Odoo `crm.lead` record — a deliberate "zero new infrastructure" pattern used consistently across every phase. |

## 4. Odoo integration overview

Single Next.js app; `app/api/**` route handlers are the only server code,
and they talk to production Odoo 19 directly over XML-RPC
(`lib/odoo-server.ts`, `import 'server-only'`, never imported client-side).
There is no middleware, no queue, no cache layer, no ORM.

```
Browser → httpOnly session cookie → Next.js API routes → XML-RPC → Production Odoo 19
                                          │
                                          ▼
                              Next.js pages, gated by proxy.ts
```

`crm.lead` is the core "order" record — not `sale.order`. A quotation
(`sale.order`) is created only once an admin starts the PI workflow, linked
back to the lead via `opportunity_id`. `CULTFIT_PARTNER_ID` (Odoo
`res.partner` id, currently `1822`) is the single, id-based anchor every
CultFit-scoped read/write resolves through — never a name match (a partner
rename in production silently broke the portal once already; see §19).

## 5. User roles

Four shared/team logins (not per-individual — see §23 Known Limitations),
defined in `lib/auth-server.ts` → `PORTAL_USERS`:

| Role | Email | Home page | Sees |
|---|---|---|---|
| `admin` | `admin@inbody.com` | `/admin` | Everything below, plus every mutation |
| `customer` (CultFit) | `cultfit@curefit.com` | `/dashboard` | Own CultFit-scoped orders/requests only |
| `logistics` | `PORTAL_LOGISTICS_EMAIL` | `/logistics` | Every CultFit order — invoice + dispatch editing |
| `cs` (Customer Care) | `PORTAL_CS_EMAIL` | `/cs` | Every CultFit order — installation editing |

`logistics`/`cs` only exist at all when **both** their email+password env
vars are configured (fail-closed, never a fallback to broad access). Admin
can see everything logistics/CS see. Role is **never** trusted from the
JWT — every request re-resolves role fresh from `PORTAL_USERS` by email
(`requireAuthUser`), so revoking/changing a role takes effect on the very
next request, not after the token's 7-day expiry.

## 6. Customer workflow

1. **New Order Request** (`/requests/new`) — pick a main product + quantity
   + COCO/FOFO + optional delivery address/notes. No prices shown or
   collected. Creates one `crm.lead` Opportunity, stage "New", salesperson
   blank.
2. **My Requests** (`/requests`) — track request status.
3. Once admin publishes a **PI**, the customer sees it on the request/order
   detail page, can **download the native Odoo PDF**, and **Confirm** or
   **Request Correction**.
4. After confirming, the customer can **upload a PO PDF** — server extracts
   fields, customer reviews/edits, then submits.
5. Once admin approves, the customer sees **Logistics & Delivery**
   (courier, tracking, status) and **Invoice** (downloadable native PDF)
   read-only.
6. Once CS schedules it, the customer sees **Installation** status
   read-only.

Customer can never see or influence: salesperson, PI line pricing/discount,
publish/approve/dispatch/installation actions, or any other customer's
data.

## 7. Admin workflow

`/admin` — all CultFit orders (including pre-portal, Odoo-native ones) with
stage/payment filters. `/admin/requests` — portal-submitted requests. Per
request: assign salesperson, review/override Territory, review CultFit
Opportunity defaults, **Create Draft PI**, search/add/remove products,
edit quantity and discount (Unit Price is always read-only), **Publish
PI**, review PO submissions, **Approve** or **Request Correction**.

## 8. Logistics workflow

`/logistics` — every CultFit order, with search/filter by
salesperson/PO/invoice/delivery status/courier. Per order: select the
correct posted invoice when more than one exists, set dispatch tracking
(courier, AWB/tracking ref, tracking URL, scheduled date, richer delivery
status). Logistics can never touch PI lines, PO approval, or installation.

## 9. CS (Customer Care) workflow

`/cs` — every CultFit order. Per order: schedule/update installation
(status, date, time, notes, completion date, completion notes). CS can
never touch PI, PO, dispatch, or invoicing.

## 10. PI (Proforma Invoice / quotation) workflow

Admin assigns a salesperson → **Create Draft PI** builds a draft
`sale.order` from the request's own stored product selection (never
re-derived any other way) → admin can freely edit quantity/discount and
add/remove any valid sellable Odoo product on the still-draft order → admin
sets a validity date and **Publishes**. Publishing fetches Odoo's own
native quotation PDF (see §13), attaches it, and posts a versioned,
frozen snapshot to chatter. The customer then Confirms or Requests
Correction; **Create Revision** cancels the current `sale.order` and builds
a fresh one, incrementing the version. A PI is never auto-confirmed in
Odoo — it stays in draft/quotation state throughout, mirroring exactly what
a human creating the same quotation directly in Odoo would produce.

## 11. Pricing / discount rules

**Unit Price is never client-editable, anywhere.** It is always resolved
server-side from Odoo's own `product.product.list_price` at the moment a
line is created (main product on draft-PI creation, or any product an
admin adds afterward) — re-read fresh from Odoo every time, never trusted
from a search-result cache or from the browser. No API route accepts
`unitPrice`/`price_unit`/`subtotal`/`tax`/`total` from the client; any such
fields sent are silently ignored.

Admin can edit: **Quantity** (integer, 1–999) and **Discount** — either a
percentage (0–100%, Odoo's own native `discount` field) or a Fixed Amount
(the `inbody` Odoo module's own `fixed_amt`/`disc_calculation` fields,
bounded so a line can never go negative). Odoo itself computes
`price_subtotal`/`price_tax`/`price_total` — the portal only ever reads
those back, never recalculates them.

**Known display gap (Severity B, not fixed this pass — see §23):** the
native Odoo PDF's Discount% column does not currently render the Fixed
Amount mode's effect correctly (the underlying `fixed_amt` math is correct
in Odoo, it's a report/QWeb display issue). Use Percentage mode for
anything that needs to show correctly on the customer-facing PDF today.

## 12. Bundle rules

Verified bundle relationships (from real historical CultFit order data):

| Main product | Included (free) products |
|---|---|
| InBody 120 (`I9F300001`) | Stand 120 (`Z9ZZ04006`) + LookinBody120 (`L9I100039`) |
| InBody 260 / 260S (`I9V600002`) | HP 1008A printer (`IIPLPR002`) + LB WEB_B_1Y (`O40208301`) |

Every included product's line uses its own **real, native Odoo Sales
Price** as Unit Price, with Odoo's native **100% discount** applied — never
a faked ₹0 Unit Price. (Note: Stand 120 and HP 1008A's own configured Odoo
Sales Price genuinely is ₹1 today — that's InBody's own product master
data, not a portal bug; the portal always shows whatever Odoo says.) This
was a real bug (`price_unit` hardcoded to 0 with no discount) found and
fixed on 2026-08-12 — see the git history around commit `15e0840` and the
verification method in §26.

**Main-product identification** (used for the T&C template, and for
displaying "the main product's price") is resolved by matching the line's
`product_id` against the exact product id the customer selected when the
request was created — never by price, discount, or line order (which is
what the pre-fix code did, and which broke the moment included lines
started carrying real prices too).

## 13. Terms & Conditions rules

Automatically written into `sale.order.note` (Odoo's own native quotation
report renders this HTML directly — no custom PDF) whenever the PI's lines
change. Main-machine detection for T&C purposes is independent of the
main-product-price logic above: it matches on the product's Odoo **product
category** (`InBody / IBD_<Model>`), a structural signal unaffected by
price/discount, so it was never at risk from the bundle-pricing bug.

| Product | Warranty clause |
|---|---|
| InBody 120 | 1 year from delivery/installation |
| InBody 260 / 260S | 5 years from delivery/installation |

The note always includes: Prices (firm/inclusive), Payment Terms (100%
with order), Warranty (above), Delivery Period (ex-stock or 4 weeks), and
**Validity** — dynamically formatted from the quotation's own
`validity_date`, never a hardcoded date. Bank details are fixed/verbatim
InBody India bank details. Adding accessories never changes which
template is selected (category-based, not price-based). Verified live
against real production quotation PDFs for both InBody 120 and 260S on
2026-08-12 (see §26).

## 14. PO (Purchase Order) workflow

Available only once the current PI is published **and** customer-confirmed.
Customer uploads a PO PDF → server extracts structured fields
(`lib/po-pdf-parser.ts`, `pdfjs-dist`-based, magic-byte + size validated,
3.5MB cap) → **the PDF itself is never persisted anywhere** — no
attachment, no disk, no database, no logging of its bytes; it exists only
as an in-memory buffer for the one extract request. Customer reviews/edits
the extracted fields in the browser (nothing saved yet) → submits → server
re-validates every field from scratch, regardless of what the extraction
returned → compares against the confirmed PI and surfaces warnings
(never blocking). Admin reviews and Approves or Requests Correction. On
approval, exactly two native Odoo fields are written:
`sale.order.client_order_ref` (PO number) and `sale.order.commitment_date`
(expected delivery). No `res.partner`/contact is ever created by this flow.

## 15. Invoice workflow

`account.move` is the only source of truth — the portal never creates an
invoice. Only real posted customer invoices are ever surfaced
(`move_type='out_invoice'`, `state='posted'` — never a draft or a credit
note). When more than one valid invoice exists on an order, logistics
explicitly selects the correct one; that selection is re-verified against
the live candidate list on every subsequent read, so a since-cancelled
invoice can never stay "selected." The customer's PDF download is Odoo's
own native invoice report, fetched on-demand via Odoo's customer-portal
access-token route — not a custom-rendered PDF.

## 16. Dispatch workflow

`stock.picking` is the only source of truth — the portal never creates,
confirms, reserves, or validates one. Only three native fields are ever
written: `scheduled_date`, `carrier_tracking_ref`, `carrier_tracking_url`
(the last validated to `http`/`https` only). Everything else — courier
name, the portal's own richer delivery-status enum, notes — lives in
chatter metadata. For a historical order the portal has never touched,
delivery status is inferred from Odoo's own picking (`state='done'` →
"Delivered"); once logistics saves anything via the portal, the portal's
own metadata becomes authoritative going forward and will not
auto-re-sync with a later real-world Odoo change (documented in §23).
Historical orders with no portal PO tracking show an honest **"Not
Tracked"**, never a misleading "Awaiting PO Approval."

## 17. Installation workflow

Writes **zero** native Odoo fields — a deliberate decision after
confirming no reliable, safe, already-used native field/model exists for
this on CultFit orders (full investigation in
`CULTFIT_PORTAL_MASTER_CONTEXT.md` §11, Phase 5). Status, schedule, notes,
and completion live entirely in structured chatter metadata:
`not_scheduled → scheduled → in_progress → installed → completed`. No
`project.task`, `calendar.event`, `installation.data`, or invoice is ever
created. Customer sees this read-only; only CS/admin can update it.

## 18. Territory logic

`crm.lead.territory_id` (→ `res.territory`, a custom Studio model).
`city`/`state_id` on the lead can't be used (they mirror CultFit's billing
address, always "Chennai"/"Tamil Nadu," not the actual gym location).
Instead, the request's free-text name is parsed against alias/locality
tables built from real historical CultFit request names
(`lib/region-resolver.ts`), resolved to a state, then that state is
resolved to a Territory via a **live** query against
`res.territory.state_ids` — never a hardcoded state→territory table, so an
Odoo-side reconfiguration is picked up automatically. If detection is
ambiguous or unrecognized, `territory_id` is left unset (never guessed) and
the admin UI flags "Region requires Admin review." Admin can review/set it
at any time; the override re-verifies the id against a live Odoo query
before writing.

## 19. Security architecture

- **Auth:** hand-rolled HS256 JWT (`{sub, email}` only — role is never
  baked into the token) in an httpOnly, `SameSite=Lax`, `Secure`-in-prod
  cookie. Every route re-resolves role fresh from `PORTAL_USERS` per
  request. Passwords are compared via a timing-safe comparison against the
  values configured in environment variables — not hashed, which is an
  acceptable tradeoff for a handful of shared team-login accounts held
  only in Vercel's encrypted env-var store (never a public
  user-registration system with many accounts).
- **Page gating:** `proxy.ts` (Next 16's `middleware.ts` replacement)
  redirects unauthenticated/wrong-role users before a page renders —
  defense in depth, not the primary boundary.
- **CultFit isolation:** every CultFit read/write resolves through
  `CULTFIT_PARTNER_ID` (an id, never a name match — a partner rename in
  production silently broke name-matching once already, dropping visible
  orders from ~85 to 3; never reintroduce name-based matching).
- **Mutation hardening:** every mutating route (`POST`/`PATCH`/`PUT`/
  `DELETE`) calls a shared helper (`lib/route-security.ts`) enforcing
  same-origin + `Content-Type`, before any auth/role check even runs.
  Independently audited 2026-08-13 (see §26): every mutating route has
  correct role gating, the shared security helper, and an explicit
  whitelisted field set — no client body is ever spread directly into an
  Odoo write.
- **No secret ever reaches the client:** `lib/odoo-server.ts` and
  `lib/auth-server.ts` both start with `import 'server-only'`; no
  `'use client'` file imports either. Error responses only ever contain
  fixed, templated application messages (e.g. "PI must have at least one
  line item") — raw Odoo XML-RPC faults/stack traces are always caught and
  replaced with a generic 503, logged server-side only.
- **One open, defense-in-depth gap (not exploitable today, flagged for a
  future pass):** four read-only `portal/cultfit/**` routes (orders list,
  order detail, attachments) rely on `authzDomain()` throwing for
  logistics/CS (who have no `scope`) rather than an explicit role
  allowlist like every sibling route has. Correct today, but fragile
  against a future role addition.
- **`ODOO_API_PASS` rotation — OUTSTANDING HANDOVER SECURITY ACTION.**
  Commit `4994080` (2026-08-03, "harden portal mutation routes and rotate
  credentials") rotated `JWT_SECRET`/`PORTAL_ADMIN_PASS`/
  `PORTAL_CUSTOMER_PASS`/`PORTAL_LOGISTICS_PASS`/`PORTAL_CS_PASS`, but its
  own commit message states explicitly: **"ODOO_API_PASS rotation is
  pending manual Odoo admin action."** As of this handover
  (2026-08-13), there is no evidence it has since been rotated. This
  requires an InBody Odoo administrator to regenerate/reset the service
  account's Odoo credential and update it in Vercel (Local/Preview/
  Production env vars) — it is **not** something this app can safely
  self-rotate, and it was **not** rotated as part of this handover pass
  per your explicit instruction not to rotate without authorization.

## 20. Environment variables (names only — see `PORTAL_ENVIRONMENT.md` for full detail)

| Variable | Required | Purpose |
|---|---|---|
| `ODOO_BASE_URL`, `ODOO_DB`, `ODOO_API_USER`, `ODOO_API_PASS` | Yes | Production Odoo XML-RPC credentials |
| `CULTFIT_PARTNER_ID` | Yes | The one id-based CultFit authorization anchor |
| `JWT_SECRET` | Yes | Session-signing secret |
| `PORTAL_ADMIN_PASS`, `PORTAL_CUSTOMER_PASS` | Yes | The two core account passwords |
| `PORTAL_LOGISTICS_EMAIL` / `PORTAL_LOGISTICS_PASS` | Optional, both-or-neither | Logistics role (fails closed if only one is set) |
| `PORTAL_CS_EMAIL` / `PORTAL_CS_PASS` | Optional, both-or-neither | CS role (fails closed if only one is set) |
| `NEXT_PUBLIC_API_URL` | Yes | Must stay `/api` (same-origin) — a cross-origin value silently breaks the session cookie |
| `ALLOWED_ORIGINS` | Optional | Comma-separated extra origins for the CSRF same-origin check |

Never committed — `.gitignore` excludes every `.env*` file. Must be
configured manually in each environment (local `.env.local`, Vercel
Preview, Vercel Production) via Vercel's dashboard.

## 21. Deployment process

Standard Vercel Git integration, Root Directory `portal_frontend`:
1. Branch off `main`, commit.
2. Push the branch → Vercel auto-builds a **Preview** deployment (its own
   URL, protected by Vercel SSO by default).
3. Test against Preview (it talks to the *same* real production Odoo —
   there is no separate Odoo sandbox; use clearly-labeled TEST records and
   clean them up afterward — cancel the test quotation, archive the test
   lead).
4. Merge to `main`, push → Vercel auto-builds and promotes to
   **Production** automatically.
5. Tag the release (see §25).

`npm run lint` and `npm run build` must both be clean before any merge.

## 22. Production health-check method

```
GET https://inbody-cultfit-portal-mgrl.vercel.app/api/health
```
Returns `{"status":"ok","application":"inbody-cultfit-portal","odoo":"connected"}`
on success (`degraded`/503 if Odoo is unreachable). Never reveals the Odoo
URL, DB name, or credentials, even on failure. This is the fastest way to
confirm the app is up and Odoo connectivity is healthy — check this first
whenever something is reported broken.

## 23. Known limitations

**A. Fixed Amount discount display on the native Odoo PDF.** The
underlying math is correct (Odoo computes the real subtotal/tax/total
correctly for `fixed_amt` mode), but the native quotation QWeb report does
not currently render that mode's effect in the Discount% column the way it
does for Percentage mode. This is a Closyss/Odoo-side report-template fix,
out of scope for this app and deliberately not attempted during this
handover pass (risky Odoo-side QWeb changes should not be made under
handover time pressure). **Workaround:** use Percentage discount mode for
anything that needs to display correctly on the customer PDF today.

**B. Historical (pre-fix) PIs are unchanged.** PIs created before
2026-08-12 still show ₹0 Unit Price for bundle-included accessories (the
bug described in §12) — this was a deliberate choice, not an oversight; no
bulk correction was performed on existing quotations. Only PIs created or
revised after the fix reflect the corrected behavior.

**C. PO PDF extraction is layout-sensitive.** It's a best-effort,
label-proximity text parser built and tested against synthetic PDFs (no
real customer PO template existed to calibrate against). The mandatory
customer review/edit step before submission is the intended safety net —
extraction quality is not a correctness guarantee, and it isn't meant to
be one.

**D. Shared role accounts, honestly described.** All four roles
(`admin`, `customer`, `logistics`, `cs`) are single shared logins for
their whole respective team — **not** per-individual authentication. There
is no per-user audit trail beyond "an admin did X" (recorded as the
fixed `admin@inbody.com` email in Odoo chatter notes, not which specific
person was signed in). Do not describe this as individual-user auth in
any customer- or auditor-facing material. A per-user-account phase (Phase
6) is scoped but not built.

**E. Dispatch status can go stale relative to Odoo.** Once logistics saves
any dispatch metadata via the portal for an order, that metadata becomes
authoritative for that order's displayed status — a later real-world
picking completion in Odoo will not automatically re-promote the portal's
displayed status. Logistics staff need to update status themselves.

**F. Login rate limiting is best-effort only** (in-memory, 5 attempts/15
min per IP+email) — resets on cold start, not shared across serverless
instances. A speed bump, not a hard guarantee; no external rate-limiting
service is used per the project's "no paid service unless required" rule.

**G. `ODOO_API_PASS` rotation is still pending** — see §19, this is the
one outstanding security action item from this handover.

## 24. Troubleshooting

| Symptom | Likely cause / first check |
|---|---|
| `/api/health` returns `degraded` | Odoo is unreachable — check Odoo's own uptime first, this app has no control over that |
| A role can't log in | Confirm both halves of that role's env var pair are set in the environment you're testing (logistics/CS fail closed on a partial config) |
| "Region requires Admin review" on every new request | Not a bug by itself — check whether the request name matches a known locality; if a genuinely new city needs support, extend `lib/region-resolver.ts`'s alias tables |
| PI publish fails with "no valid Sales Price" | The product's Odoo `list_price` isn't configured — fix in Odoo, not the portal (the portal deliberately refuses to fabricate a price) |
| A generic 503 / "temporarily unavailable" | Odoo timeout/network failure (15s timeout) — check Odoo health; the raw fault is logged server-side only (Vercel function logs), never shown to the user |
| PDF download 404s | Either genuinely not published yet, or a different order's id was guessed — the portal deliberately returns an identical safe 404 for both cases, by design (never confirms/denies existence to an unauthorized caller) |

## 25. Rollback / release tags

Single Next.js app, no database migrations — a code rollback is a
complete rollback. To roll back: `git revert` the relevant commit(s) and
push to `main` (or use Vercel's "Promote to Production" on a prior
deployment from the dashboard for an instant rollback without a new git
commit). Chatter notes already posted to Odoo during a bad deploy's
lifetime are harmless historical text and don't need cleanup.

Release tags on `main` (chronological):
- `phase-4-production`
- `portal-security-hardening-production`
- `cultfit-defaults-region-native-pi-production`
- `cultfit-bundle-pricing-terms-production` (2026-08-12 — T&C automation + bundle-pricing fix)
- `cultfit-portal-v1.0-production` — **this handover's tag, see §29**

## 26. Final QA status (this handover pass, 2026-08-13)

Full results in the separate final report delivered alongside this
document. Summary: production health confirmed, all 4 roles' login/
landing-page/cross-role-rejection behavior verified live against
Production, pricing/bundle/T&C verified via a controlled test on Preview
(identical code to what's now in Production) plus independent code audit,
invoice/PO/logistics/CS/territory/defaults logic independently audited by
4 parallel code-review passes against the actual current source (not just
docs), full mutating-route security inventory completed. **Zero
Severity-A (submission-blocking) bugs found.** A small number of
Severity-B items are documented in §23 above and were left as-is per the
"don't risk today's handover on non-blocking changes" policy.

## 27. Handover checklist

- [x] Production is live and healthy (`/api/health` → `ok`/`connected`)
- [x] Production runs the latest `main` commit
- [x] All 4 roles tested: login, landing page, cross-role rejection
- [x] Pricing/bundle/T&C behavior verified correct
- [x] PI/PO/Invoice/Dispatch/Installation workflows code-audited, no
      Severity-A defects found
- [x] Security route inventory completed, no exploitable gaps found
- [x] This handover document created
- [x] Existing docs reconciled (see the note at the top of
      `PORTAL_SECURITY_AND_TESTING.md`)
- [ ] **`ODOO_API_PASS` rotation** — outstanding, requires an InBody Odoo
      admin (see §19)
- [ ] Decide on Phase 6 (per-user accounts) timeline, if/when wanted —
      not started, not required for this handover

---

## 28. Quick operational guides

### Admin — how to run a PI end-to-end

1. Log in at `/login` with the admin account → lands on `/admin`.
2. Click **Requests** in the top nav to see portal-submitted requests, or
   find the order in the main **Orders** list.
3. Open the request. If Territory shows "requires Admin review," set it
   manually if you know the correct one.
4. **Assign Salesperson** (required before a PI can be created).
5. Click **Create Draft PI**. The main product and any bundle-included
   accessories appear automatically, each at its real Odoo price (Unit
   Price is always read-only).
6. To add another product: use the search box under the line table (search
   by name or code — not limited to the main-product bundle), pick a
   quantity and discount, click **Add**.
7. To change an existing line: edit **Quantity** or **Discount %** (or
   switch to **Fixed Amount** mode) inline, click **Save**.
8. Set the **Validity Date**, then click **Publish PI**. This generates
   Odoo's native quotation PDF and makes it visible to the customer.
9. If the customer requests a correction, use **Create Revision** to
   cancel the current quotation and start a fresh one — do this rather
   than editing a published PI directly.
10. Once the customer submits a PO, open the **PO** tab on the same
    request to **Approve** or **Request Correction**.

### Customer — how to place and track an order

1. Log in with the CultFit account → lands on `/dashboard`.
2. **New Order Request**: pick the InBody model and quantity, COCO/FOFO,
   optional delivery address/notes, submit.
3. Track it under **My Requests**. Once InBody publishes a quotation, it
   appears on the request page — review it and **Download PI** (the real
   Odoo PDF) before deciding.
4. **Confirm** it, or **Request Correction** with a comment if something's
   wrong.
5. After confirming, an **Upload PO** option appears — upload your PO PDF,
   review the auto-extracted fields (fix anything the extraction got
   wrong), then submit.
6. Once InBody approves the PO, **Logistics & Delivery** and **Invoice**
   sections appear — download the invoice PDF, track dispatch status.
7. **Installation** status appears once InBody's CS team schedules it —
   read-only, updates automatically as CS progresses it.

### Logistics — how to update dispatch

1. Log in with the logistics account → lands on `/logistics`.
2. Use the search/filter bar to find the order (by customer, salesperson,
   PO/invoice/delivery status, or courier).
3. Open the order. If more than one posted invoice exists, select the
   correct one under **Invoice**.
4. Under **Dispatch**, set courier name, AWB/tracking reference, tracking
   URL (must be `http`/`https`), scheduled date, and the delivery status
   that matches reality (`not_started` → `logistics_processing` →
   `ready_to_dispatch` → `dispatched` → `in_transit` → `delivered`, or flag
   a delivery issue). Save.
5. This never touches the PI, PO approval, or installation — those stay
   admin/CS territory.

### CS — how to schedule and complete an installation

1. Log in with the CS account → lands on `/cs`.
2. Find the order via search/filter (mirrors the logistics dashboard).
3. Open it, and under **Installation** set status, scheduled date/time,
   and notes. Save — this is the first save that "claims" the order as
   Assigned CS.
4. Progress status through `scheduled → in_progress → installed →
   completed` as the real-world installation proceeds, adding completion
   date/notes at the end.
5. The customer sees this read-only automatically — no separate
   notification step needed.
