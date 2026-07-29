# Portal Environment Variables — Reference

This file is tracked in git (unlike `.env.local`/`.env.example`, which this repo's
`.gitignore` excludes entirely — see the note at the bottom). No secret values are
included anywhere in this document.

## `CULTFIT_PARTNER_ID` (required — Local, Preview, and Production)

```
CULTFIT_PARTNER_ID=1822
```

- **What it is:** the Odoo `res.partner` id of the single canonical CultFit
  commercial partner. It is the one server-side anchor every CultFit-scoped read
  and write in the portal resolves through (`lib/odoo-server.ts`, `cultfitDomain()`
  and `resolveCultFitPartnerId()`), via `partner_id.commercial_partner_id = CULTFIT_PARTNER_ID`.
  `commercial_partner_id` already resolves any child/location contact up to its
  top-level company, so this one id covers every CultFit location without needing
  to enumerate them individually.
- **Server-only.** This variable is read only in server-only files
  (`import 'server-only'` at the top of `lib/odoo-server.ts`). It is never sent to
  the browser, never included in a client bundle, and never referenced from any
  `'use client'` component.
- **The customer never supplies or modifies this.** No API route accepts a
  `partner_id` (or any spelling of it) from a request body or query string for any
  CultFit read or write — it is always resolved server-side from this
  configuration value (or, for the New Order Request flow, optionally from the
  authenticated account's own fixed `partner_ids` scope in `PORTAL_USERS` if one is
  configured — still never client-supplied).
- **Must be added manually in Vercel** (Project Settings → Environment Variables)
  for each environment that needs it — it is not committed anywhere, so a fresh
  environment without it configured will not work until it's added there.
- **Fails closed, not open, if missing or invalid.** `cultfitDomain()` and
  `resolveCultFitPartnerId()` both explicitly check `Number.isInteger(...) &&  > 0`
  and throw a clear internal error if the value is missing or malformed — every
  CultFit-scoped route then returns a generic 503 rather than silently falling
  back to "no restriction" or "match everything." It will never silently narrow or
  widen customer access.
- **Why this exists instead of name matching:** the portal originally identified
  CultFit by matching the partner's *name* against a handful of substrings
  (`cultfit`, `curefit`, `cult fit`, …). On 2026-07-29, InBody's team renamed the
  canonical CultFit partner in production from "CULTFIT HEALTHCARE PRIVATE
  LIMITED" to "CULT.FIT LIMITED" — mid-session, while this feature was being
  built — and the rename didn't match any existing pattern, which silently
  dropped the matched-order count from ~85 to 3 for every existing CultFit view
  (dashboard, admin, order detail), not just the new request pages. An id survives
  a rename; a name match does not. **Partner-name matching must not be used as the
  authorization source** — it is kept in the code only as an inert, opt-in
  diagnostic (`checkCultFitPartnerDrift()` in `lib/odoo-server.ts`) that compares
  the id-based count against what name-matching would find, purely for manual
  drift-checking, and it never affects what a customer or admin can actually see.

### How to find/verify this value

In Odoo, search `res.partner` for the CultFit company record (`is_company = true`,
no `parent_id`) and use its `id` — or, equivalently, take the `commercial_partner_id`
of any known CultFit-linked `crm.lead`.

## Operational notes (not new env vars, just documented behavior)

- **`industry_id` is mandatory on `crm.lead` in this Odoo instance** (an
  instance-specific customization, not stock Odoo). The portal resolves it
  dynamically by name ("Fitness") rather than hardcoding the id — verified live
  that 100% of existing CultFit leads use this value.
- **`sub_industry_id` is also mandatory**, but unlike industry there is no single
  dominant historical value (CultFit leads split across "High Budget Fitness" /
  "Medium Budget Fitness" / "Low Budget Fitness"). The portal currently defaults
  every new request to **"High Budget Fitness"** as a temporary placeholder to
  satisfy the required field — this is *not* a verified-correct classification
  per request, since the customer-facing form has no field to determine it.
  **This is intentionally not exposed on the customer form.** InBody staff may
  correct this classification manually in Odoo on a per-request basis; revisit
  if a real input for it is ever needed.
- **New Opportunities intentionally have no salesperson** (`user_id` is
  explicitly sent as `false`, not merely omitted — Odoo's own team/onchange
  defaults will silently auto-assign one if the key is left out entirely). Admin
  assigns the salesperson manually afterward.

## Why this file exists instead of `.env.example`

This repository's `.gitignore` excludes every `.env*` file, including
`.env.example` — none of them are tracked in git at all (confirmed: `git ls-files`
matches nothing named `.env*`). That's a pre-existing repo convention, not
something this change alters. Practical consequence: any new required variable
(like `CULTFIT_PARTNER_ID`) needs to be documented somewhere that *is* tracked —
this file — and added manually to each environment (local `.env.local`, and
Vercel's dashboard for Preview/Production) since it won't travel with the code.
