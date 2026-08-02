# InBody/CultFit Portal — Security & Testing Reference

Last updated: 2026-07-14, as part of a security hardening pass covering customer data isolation, auth, and stage-update integrity. No secrets are included in this file.

---

## 1. Architecture

Single Next.js 16 (App Router) application, deployed to Vercel. No separate backend — `app/api/**` route handlers talk to production Odoo directly over hand-rolled XML-RPC (`lib/odoo-server.ts`). There used to be a FastAPI middleware (`portal_backend/`); it has been fully retired and is not used by any current code path.

```
Browser
  │  httpOnly session cookie (same-origin)
  ▼
Next.js API routes (app/api/**)  ──XML-RPC──▶  Production Odoo 19
  │
  ▼
Next.js pages (app/**), gated server-side by proxy.ts
```

- `lib/odoo-server.ts` — XML-RPC client, all CultFit business logic, authorization domain building. Never imported client-side (`import 'server-only'` enforces this at build time).
- `lib/auth-server.ts` — JWT signing/verification, the httpOnly session cookie, and `PORTAL_USERS` (the only user store — two hardcoded accounts, see §3).
- `lib/stage-config.ts` — single source of truth for portal stage labels/keys/chip colors. Imported by both server code (`odoo-server.ts`) and client pages — do not redeclare `STAGE_LABELS` anywhere else.
- `proxy.ts` — Next.js 16's replacement for `middleware.ts`. Server-side page gating (redirects unauthenticated/wrong-role users before a protected page renders). This is defense in depth, not the primary boundary — every API route independently re-verifies auth and role.

## 2. Authentication flow

1. `POST /api/portal/auth/login` — checks credentials against `PORTAL_USERS`, signs a JWT containing only `{sub, email}` (no role/permissions — see below), and sets it as an **httpOnly, `SameSite=Lax`, `Secure`-in-production** cookie named `portal_session`. The response body contains user display info only — never the token.
2. Every protected route calls `requireAuthUser(req)` (`lib/auth-server.ts`), which reads the cookie, verifies the signature, then **re-resolves role and scope fresh from `PORTAL_USERS`** by email. Role/scope are deliberately never trusted from the token itself — a token only proves identity, so a config change (e.g. revoking someone) takes effect on their very next request instead of waiting up to 7 days for old tokens to expire.
3. `POST /api/portal/auth/logout` clears the cookie.
4. `proxy.ts` runs the same check server-side for page navigation (`/admin`, `/dashboard`, `/orders/*`), redirecting before the page renders.
5. Login has a best-effort in-memory rate limiter (5 attempts / 15 min per IP+email). **Known limitation:** this resets on server cold start and is not shared across serverless instances — it is a speed bump, not a hard guarantee. No external rate-limiting service is used, per the "no paid service unless required" preference.
6. Wrong password and unknown email return the identical generic message (`"Invalid email or password"`) — an attacker cannot enumerate valid accounts from the error alone.

## 3. Admin vs. customer permission rules

There are exactly two accounts, defined in `lib/auth-server.ts` → `PORTAL_USERS`:

| Role | Email | Data access |
|---|---|---|
| `admin` | admin@inbody.com | All CultFit/Curefit orders (same domain as below), plus stage-write endpoints |
| `customer` | cultfit@curefit.com | CultFit/Curefit orders only, via `scope: { kind: 'cultfit_domain' }` |

**Every** CultFit read (list and single-order) and **every** admin write resolves its Odoo domain through `authzDomain()` / `assertCultFitLead()` in `lib/odoo-server.ts` — there is no code path that skips this, including for admin. Two structural guarantees:

- A customer whose `scope` is missing or empty gets `403 { detail: "Customer account is not mapped to an Odoo partner." }` — there is no fallback to broad access. This is the fix for the original "customer sees all 67 orders, same as admin" bug; the underlying flaw was a `partnerId <= 0` fallback that silently widened to "no restriction" instead of failing closed.
- `fetchCultFitOrderById()` and all three admin stage-write functions now unconditionally AND the CultFit/Curefit domain into every query — previously `fetchCultFitOrderById()` had **no domain restriction at all** beyond matching the id, so any authenticated user (customer or admin) could read any `crm.lead` in the entire Odoo instance by guessing an id in `/orders/<id>`. Do not remove this AND when touching these functions.

### Adding a future customer

Add an entry to `PORTAL_USERS` with either:
- `scope: { kind: 'cultfit_domain' }` — reuses the same dynamic CultFit/Curefit name-matching domain admin sees (only appropriate if the new account should see everything an admin sees, scoped to CultFit).
- `scope: { kind: 'partner_ids', partnerIds: [123, 456] }` — an explicit, fixed allowlist of Odoo commercial-partner ids. Use this for any future customer who should see only specific partner(s), not the whole CultFit-style domain.

**Do not** add a customer with no `scope` at all and expect broad access — that will 403, by design.

## 4. FOFO price masking — currently blocked, not implemented

No field on `crm.lead` or `sale.order` in production Odoo encodes FOFO vs. COCO status — confirmed via a live `fields_get` probe (nothing matching `fofo|coco|franchise|owned` in either model). The only trace of "FOFO" anywhere in the dataset is a single partner literally named *"Cult Gomti Nagar Lucknow FOFO -UP"* — a human note in a company name, not a structured field, and not a pattern reliable enough to build masking logic on (every other FOFO location, if any exist, would silently not follow this naming convention).

**Do not** build masking on a name-substring heuristic. This needs an actual Odoo field (Studio-added or otherwise) before it can be implemented. Until then, `CocoFofoType`/`coco_fofo_type` and the fields that would depend on it have been removed from the codebase rather than left as dead types that invite someone to wire UI to a field that doesn't exist.

## 5. Stage-update flow and audit log

- Admin selects a target stage in the "Update Portal Stage" panel (`app/orders/[id]/page.tsx`), enters a required reason, and confirms via a browser confirm dialog before the request fires. The save button is disabled while the request is in flight (already-existing behavior, not new).
- `POST /api/admin/cultfit/orders/[id]/set_stage` (or `.../stage` for next/prev) verifies `role === 'admin'`, validates the order id and stage key, confirms the lead is within the CultFit domain (`assertCultFitLead`), writes the new `deal_status_id` (or `stage_id` for the final "won" stage) to `crm.lead`, then posts an **internal chatter note** on that same lead via Odoo's native `message_post` (subtype `mail.mt_note`) recording old stage → new stage, the admin's email, and the reason.
- This chatter note **is** the audit log. No new database was introduced — Odoo's own `mail.thread` is reused, so InBody staff see the history directly on the lead in Odoo, with zero new infrastructure. Posting the note is best-effort: if it fails, the stage write still succeeds (the business action matters more than the log entry), and the failure is logged server-side only.
- The "Update Deal Status" panel (payment/installation/vendor-portal/confirmation-mail fields) has been **removed** from the UI. Its backing Odoo fields don't exist in production — the API route previously faked a 200 success while silently writing nothing; it now returns an honest `501` if hit directly, and the dead UI that could never succeed was removed rather than left to mislead admins.

## 6. Document downloads (quotation/invoice PDFs)

This was a real, working feature (`ir.attachment` search on the linked `sale.order`/`account.move` records) that silently regressed to a permanent empty stub during the FastAPI → Next.js migration. It has been restored in `lib/odoo-server.ts` (`fetchOrderAttachments` / `fetchAttachmentData`), with one fix versus the original implementation: attachment downloads now verify the requested attachment id actually belongs to a sale order or invoice reachable from the *authorized* lead before returning its bytes — the original implementation read any attachment id with no ownership check at all, which would have let any authenticated user download any PDF in the whole Odoo instance by guessing an id.

A separate, older "manually uploaded documents" feature (from the deleted FastAPI/custom-Odoo-module era, pointing at `/portal/documents/{id}`) had no backing implementation in this architecture and was removed rather than left as dead code hitting a route that never existed.

## 7. Odoo reliability

- `rpcPost()` (the raw XML-RPC HTTP call) has a 15s timeout via `AbortController`. A timeout or network failure raises `OdooUnavailableError`, which routes turn into a generic `503` — never a raw Odoo fault string or stack trace reaching the client.
- `executeKw()`'s retry-on-stale-uid logic explicitly does **not** retry on `OdooUnavailableError` (timeout/network failure) — only on other errors (e.g. an expired cached uid) — so a genuine Odoo outage fails once and reports quickly instead of doubling the wait.
- `GET /api/health` does a cheap unauthenticated `common.version` XML-RPC call and returns `{status, application, odoo}` — `ok`/200 or `degraded`/503. It never reveals the Odoo URL, DB name, or credentials, even on failure.

## 8. Environment variables

Names only — see `.env.example` for the full annotated list, never commit real values:

| Variable | Purpose |
|---|---|
| `NEXT_PUBLIC_API_URL` | Must stay a same-origin relative path (`/api`) — a cross-origin value silently breaks the httpOnly session cookie |
| `ODOO_BASE_URL`, `ODOO_DB`, `ODOO_API_USER`, `ODOO_API_PASS` | Production Odoo XML-RPC credentials |
| `JWT_SECRET` | Session-signing secret — must be a real random value in production, never the dev default |
| `PORTAL_ADMIN_PASS`, `PORTAL_CUSTOMER_PASS` | The two `PORTAL_USERS` passwords |

No new environment variables were introduced by this pass.

## 9. Local run instructions

```powershell
cd portal_frontend
npm install
# copy .env.example to .env.local and fill in real values (never commit .env.local)
npm run dev
```

Only Next.js is needed locally — it talks directly to production Odoo. There is no local Odoo/database dependency for the portal itself.

## 10. Manual testing checklist

Run against a local dev server (`npm run dev`) unless noted.

**Isolation / IDOR**
- [ ] Admin login → `GET /api/portal/cultfit/orders` returns the full CultFit list.
- [ ] Customer login → same endpoint returns only CultFit/Curefit-domain orders.
- [ ] Fetch a **known non-CultFit** `crm.lead` id directly via `GET /api/portal/cultfit/orders/<id>` as both admin and customer → expect `404`, not the lead's data.
- [ ] Customer with no configured `scope` (temporarily edit `PORTAL_USERS` to test) → expect `403` with the safe message, never a broad-access fallback.

**Admin API**
- [ ] Customer JWT/cookie against any `/api/admin/**` route → `403`.
- [ ] Invalid order id (non-numeric) → `400`, not `503`.
- [ ] Unknown stage key → `400` with a clear message.
- [ ] Admin attempts to move a non-CultFit lead's stage (if a test id is available) → `404`, confirming `assertCultFitLead` blocks it even for staff.
- [ ] `PATCH /api/admin/cultfit/orders/<id>/deal_status` → `501` with an honest message, never a fake `200`.

**Auth**
- [ ] Successful login sets `portal_session` as `HttpOnly` (check DevTools → Application → Cookies) — no token appears anywhere in the response JSON or in `localStorage`.
- [ ] `/admin` as an unauthenticated request → redirects to `/login` (check via `curl -I`, not just in-browser, to confirm it's server-side).
- [ ] `/admin` with a customer cookie → redirects to `/dashboard`; `/dashboard` with an admin cookie → redirects to `/admin`.
- [ ] Tampered cookie (flip one character of the signature) → treated as unauthenticated, redirected to `/login`.
- [ ] `POST /api/portal/auth/logout` clears the cookie; a subsequent data request returns `401`.
- [ ] 6 rapid failed logins with the same email → `429` on the 6th.

**Stage updates**
- [ ] Update Portal Stage requires a non-empty reason, shows a confirm dialog, disables the button while saving, and shows a clear success/error message.
- [ ] Refresh the page after a successful update — the new stage persists (confirms the write actually landed in Odoo, not just optimistic client state).
- [ ] Check the lead's chatter in Odoo directly — the audit note should show old stage → new stage, the admin's email, and the reason.

**Build gate**
- [ ] `npm run lint` — zero errors/warnings.
- [ ] `npm run build` — succeeds with no TypeScript errors.

## 11. Deployment

Standard Vercel flow — push to `main`, Vercel auto-builds and deploys. No new environment variables are required beyond what's already configured on Vercel (verify `NEXT_PUBLIC_API_URL=/api` is set there, matching local).

## 12. Rollback

Revert the relevant commit(s) via `git revert` and push — since this is a single Next.js app with no database migrations involved, a code rollback is a complete rollback. The one thing rollback does **not** undo: chatter notes already posted to Odoo leads during the period the audit-log feature was live — those are just historical text notes and are harmless to leave in place.

## 13. CSRF / same-origin hardening for mutation routes

`security/admin-route-csrf-hardening` closed a gap where several mutating routes (mostly under `/api/admin/**`) had no same-origin or Content-Type check — some had none at all, some had an ad hoc inline copy that varied route to route. Every mutating (`POST`/`PATCH`/`PUT`/`DELETE`) route now goes through one shared helper, `lib/route-security.ts`:

- `checkJsonMutation(req)` — same-origin + `Content-Type: application/json` required. Used by nearly every JSON-body mutation.
- `checkMultipartMutation(req)` — same-origin + `Content-Type: multipart/form-data` required. Used only by the PO PDF extraction upload route.
- `checkBodylessMutation(req)` — same-origin only, no Content-Type requirement. Used by `logout` (a raw `fetch()` with no body/headers in `lib/auth.ts`) and the PI-line `DELETE` (query-param based, no body).

Same-origin check: compares the request's `Origin` header against `req.nextUrl.origin`, plus any extra origins listed in the (pre-existing, previously-unused) `ALLOWED_ORIGINS` env var — a comma-separated list, useful for a Preview deployment's own origin if it needs to be called from elsewhere. A request with **no** `Origin` header is not rejected on origin grounds (normal for same-origin browser navigations/non-CORS requests); it still must satisfy the Content-Type check. Deliberately does **not** trust `X-Forwarded-Host` or any other client-suppliable header — only `Origin` vs. the server's own resolved `nextUrl.origin`, which Vercel's edge routing makes trustworthy per deployment.

Call it first, before auth/role checks, in every mutating handler:

```ts
const rejection = checkJsonMutation(req);
if (rejection) return NextResponse.json({ detail: rejection.detail }, { status: rejection.status });
```

Rejections: `403` for cross-origin, `400` (JSON) or `415` (multipart) for wrong Content-Type. Unsupported HTTP methods need no explicit handling — Next.js's App Router already returns `405` for any method a `route.ts` doesn't export.

Routes covered (all mutating routes in the app as of this pass): `portal/auth/login`, `portal/auth/logout`, `portal/cultfit/requests` (POST), `portal/cultfit/requests/[id]/po/extract` (multipart), `portal/cultfit/requests/[id]/po/submit`, `portal/cultfit/requests/[id]/pi/respond`, `admin/cultfit/orders/[id]/stage`, `admin/cultfit/orders/[id]/set_stage`, `admin/cultfit/orders/[id]/deal_status`, `admin/cultfit/requests/[id]/salesperson`, `admin/cultfit/requests/[id]/territory`, `admin/cultfit/requests/[id]/pi` (POST + PATCH), `admin/cultfit/requests/[id]/pi/publish`, `admin/cultfit/requests/[id]/pi/revise`, `admin/cultfit/requests/[id]/pi/lines` (POST), `admin/cultfit/requests/[id]/pi/lines/[lineId]` (PATCH + DELETE), `admin/cultfit/requests/[id]/po/approve`, `admin/cultfit/requests/[id]/po/request-correction`, `logistics/cultfit/orders/[id]/invoice/select`, `logistics/cultfit/orders/[id]/dispatch`, `cs/cultfit/orders/[id]/installation`. Read-only `GET` routes, PDF download routes, and Next.js's own automatic `405` handling were left untouched.

Existing protections are unchanged and layered underneath this: `requireAuthUser` + role check still run per route (this pass only added the origin/Content-Type layer, it did not touch auth/role logic), server-side ownership checks (`assertCultFitLead`, `verifySOBelongsToLead`, etc.) are untouched, payload whitelisting is untouched, and the httpOnly `SameSite=Lax` cookie is untouched.
