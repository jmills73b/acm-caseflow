# Architecture

A detailed technical reference for ACM Caseflow. For process/branching conventions see
[`CONTRIBUTING.md`](../CONTRIBUTING.md), and for the checklist an AI agent should run
through before calling a new feature done, see [`CLAUDE.md`](../CLAUDE.md). This
document is the "what is actually built and how it fits together" reference — refresh
it when the shape of the system changes, not on every feature.

## Stack & topology

| Layer | Choice | Notes |
|---|---|---|
| Frontend | React + Vite, deployed as Cloudflare Pages | Built as a static SPA (`apps/web`, `npm run build` → `dist/`) |
| API | Hono, deployed as a Cloudflare Worker | `apps/api`, worker name `anita-invoice-tracker-api` |
| Database | Cloudflare D1 (SQLite) | Database `anita-invoice-tracker` |
| Object storage | Cloudflare R2 | Bucket `acm-caseflow-documents`, for uploaded documents |
| CI/CD | GitHub Actions | Lint, unit tests, e2e, then deploy on push to `main` |
| Auth | Built into the Worker | HMAC-signed session cookies, no third-party auth product |

Chosen to run at effectively £0/month for this workload — nothing that sleeps, pauses,
or requires paid tiers at this scale (R2 needed a one-time account activation and a
card on file, but usage is designed to stay well under the free tier — see
[Storage & encryption](#document-storage--encryption)).

### Request flow in the deployed environment

```
Browser
  → Cloudflare Pages (apps/web/dist, static)
  → apps/web/functions/api/[[path]].ts   (Pages Function, proxies /api/* )
  → https://anita-invoice-tracker-api.<account>.workers.dev   (the Worker)
  → D1 (DB) / R2 (DOCUMENTS)
```

The Pages Function proxy exists so the browser only ever talks to one origin. Without
it, the Worker and Pages site would be cross-origin, and Safari's cross-site cookie
blocking would intermittently drop the session cookie (`sameSite: Lax` cookies need a
first-party context to reliably persist). The frontend build carries no
`VITE_API_URL` in production — it calls relative `/api/...` paths and lets the proxy
resolve them. Locally, `VITE_API_URL=http://localhost:8787` points the dev frontend
straight at `wrangler dev`, bypassing the proxy.

### Monorepo layout

```
apps/
  api/            Hono Worker — routes, migrations, wrangler.toml
    src/routes/   One file per resource, each with a co-located *.test.ts
    migrations/   Ordered .sql files, applied via `wrangler d1 migrations apply`
  web/            React/Vite frontend
    src/          Flat — no subfolders; see Frontend section below
    functions/    Cloudflare Pages Functions (the API proxy)
packages/
  core/           Shared TypeScript logic, imported by both apps/api and apps/web
e2e/              Playwright spec(s), run against a real build
docs/             This file
```

## Data model

### Migration history

Migrations live in `apps/api/migrations/`, applied in order by
`wrangler d1 migrations apply anita-invoice-tracker`. Several are structural rebuilds
(SQLite's `ALTER TABLE` can't drop/rename constraints, so widening an enum or changing
a FK means recreating the table) — those are noted below. Several others are one-off,
idempotent data imports from the spreadsheet this app replaces.

| # | File | Summary |
|---|---|---|
| 0001 | `0001_init.sql` | Initial schema: `users`, `clients`, `intermediary_firms` (seeded with Newmans), `tax_year_settings`, `invoices`, `expenses`. |
| 0002 | `0002_relax_tax_year_settings.sql` | Rebuild: only `monthly_target` required up front; rate fields nullable. |
| 0003 | `0003_rename_invoice_statuses.sql` | Rebuild: renames invoice status labels to their current wording, migrates existing rows. |
| 0004 | `0004_invoice_generator.sql` | Adds `invoice_settings`, `invoice_batches`; adds firm contact fields; adds `invoices.matter`/`batch_id`. |
| 0005 | `0005_expense_categories.sql` | Adds `expense_categories` (8 seeded defaults), FK from `expenses`, backfills and drops the old free-text column. |
| 0006 | `0006_account_settings.sql` | Adds `account_settings` singleton — invite-code-gated registration. |
| 0007 | `0007_tax_year_additional_rate.sql` | Adds the UK additional-rate tax band. |
| 0008 | `0008_time_keeping.sql` | Adds `time_categories`, `time_settings`, `hourly_rates`, `time_entries`. |
| 0009 | `0009_client_details.sql` | Adds `clients.email`/`summary`; adds `client_categories` + many-to-many `client_category_links`. |
| 0010 | `0010_client_notes.sql` | Adds `note_categories`, `client_notes`, append-only `client_note_versions`. |
| 0011 | `0011_tasks.sql` | Adds `tasks` + `task_occurrences`. |
| 0012 | `0012_task_client_link.sql` | Adds `tasks.client_id` (nullable) for client follow-ups. |
| 0013 | `0013_task_due_time.sql` | Adds `tasks.due_time` (default `09:30`). |
| 0014 | `0014_disabled_features.sql` | Adds `account_settings.disabled_features` (JSON array) — the feature-toggle system. |
| 0015 | `0015_task_frequency_options.sql` | Rebuild: adds `daily`/`fortnightly`/`four_weekly` frequencies. |
| 0016 | `0016_task_status_and_days.sql` | Rebuild: `paused` boolean → `status` enum, adds `completed_at`, `days_of_week`. |
| 0017 | `0017_tax_year_rate_nudge_task.sql` | Idempotently seeds a yearly recurring task reminding the user to confirm tax rates. |
| 0018 | `0018_import_historical_bills.sql` | One-off idempotent import: ~90 historical clients/invoices (2021/22–2025/26) from the old spreadsheet. |
| 0019 | `0019_backfill_tax_year_rates.sql` | Idempotently backfills 5 prior tax years' rates from 2026/27. |
| 0020 | `0020_import_2026_27_bills.sql` | Idempotent import of the current tax year's ~21 invoices. |
| 0021 | `0021_client_case_status.sql` | Adds `clients.case_status` (defaults `Active` for historical-import correctness). |
| 0022 | `0022_copy_2026_27_rates_to_2025_26.sql` | One-time explicit correction: overwrites 2025/26 rates with 2026/27's. |
| 0023 | `0023_documents.sql` | Adds `document_categories`, `documents` (R2 pointer, AES-GCM `iv`, soft delete). |
| 0024 | `0024_client_fee_estimate.sql` | Adds `clients.fee_estimate`/`fee_estimate_note` (both nullable). |
| 0025 | `0025_user_full_name.sql` | Adds `users.full_name` (nullable — the pre-existing account sets it later via `PATCH /api/me`). |
| 0026 | `0026_correspondence.sql` | Adds `letter_categories`, `letters` (soft delete, like `documents`); adds `account_settings.compliance_guidelines`. |
| 0027 | `0027_correspondence_chat_redesign.sql` | Drops `letter_categories` and `letters`' `letter_category_id`/`amount`/`reference`/`key_date`/`tone`/`bespoke_request` columns; adds `letters.letter_type` (free text). Letter type and every fact/tone detail moved into the drafting conversation itself — no production data depended on the dropped columns yet. |
| 0028 | `0028_ai_model_and_usage.sql` | Adds `account_settings.ai_model` (defaults to Haiku 4.5); adds `ai_usage` (per-call token counts for Correspondence's agents, keyed by `endpoint`/`model`). |
| 0029 | `0029_letter_format.sql` | Adds `letters.format` (`letter`/`email`, defaults to `letter`). |

### Current tables (25)

`users` · `clients` · `intermediary_firms` · `tax_year_settings` · `invoices` ·
`expenses` · `expense_categories` · `invoice_settings` · `invoice_batches` ·
`account_settings` · `time_categories` · `time_settings` · `hourly_rates` ·
`time_entries` · `client_categories` · `client_category_links` · `note_categories` ·
`client_notes` · `client_note_versions` · `tasks` · `task_occurrences` ·
`document_categories` · `documents` · `letters` · `ai_usage`

`apps/api/src/routes/export.ts`'s `TABLES` constant covers 23 of these for account
data export — `users` and `account_settings` are deliberately excluded (credentials
and app config, not business data).

## API routes

Everything is mounted in `apps/api/src/index.ts`. Every route file except `auth.ts`
applies `requireAuth` (`.use("*", requireAuth)`) — there is no per-route permission
system, just signed-in-or-not (see [Auth model](#auth-model)).

| Mount path | File | Endpoints |
|---|---|---|
| `/api` | `auth.ts` | `GET /setup/status`, `POST /setup`, `POST /register`, `POST /login`, `GET /me`, `PATCH /me`, `POST /logout` |
| `/api/account-settings` | `accountSettings.ts` | `GET /`, `PUT /` (invite code), `PUT /features` (dashboard tile toggles), `PUT /compliance-guidelines`, `PUT /ai-model` |
| `/api/client-categories` | `clientCategories.ts` | `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id` |
| `/api/client-notes` | `clientNotes.ts` | `GET /`, `GET /:id`, `POST /`, `POST /:id/versions` |
| `/api/clients` | `clients.ts` | `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id` |
| `/api/document-categories` | `documentCategories.ts` | `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id` |
| `/api/documents` | `documents.ts` | `GET /`, `GET /deleted`, `POST /`, `GET /:id/download`, `DELETE /:id` |
| `/api/expense-categories` | `expenseCategories.ts` | `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id` |
| `/api/expenses` | `expenses.ts` | `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id` |
| `/api/export` | `export.ts` | `GET /` — full JSON backup of business tables |
| `/api/firms` | `firms.ts` | `GET /`, `PATCH /:id` |
| `/api/hourly-rates` | `hourlyRates.ts` | `GET /`, `POST /`, `PATCH /:id` |
| `/api/invoice-batches` | `invoiceBatches.ts` | `GET /`, `GET /:id`, `POST /`, `DELETE /:id` |
| `/api/invoice-settings` | `invoiceSettings.ts` | `GET /`, `PUT /` |
| `/api/invoices` | `invoices.ts` | `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id` |
| `/api/letters` | `letters.ts` | `GET /`, `GET /deleted`, `GET /usage`, `POST /chat`, `POST /review`, `POST /`, `DELETE /:id` |
| `/api/note-categories` | `noteCategories.ts` | `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id` |
| `/api/tasks` | `tasks.ts` | `GET /`, `GET /:id`, `POST /`, `PATCH /:id`, `POST /:id/actions` |
| `/api/tax-year-settings` | `taxYearSettings.ts` | `GET /:startYear`, `POST /:startYear`, `POST /:startYear/split`, `PUT /:startYear/rates` |
| `/api/time-categories` | `timeCategories.ts` | `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id` |
| `/api/time-entries` | `timeEntries.ts` | `GET /`, `POST /`, `PATCH /:id`, `DELETE /:id` |
| `/api/time-settings` | `timeSettings.ts` | `GET /`, `PUT /` |
| `/api/usage` | `usage.ts` | `GET /` — Cloudflare free-tier usage vs. caps |

`GET /api/health` is defined inline in `index.ts`, not a routed file.

Notable business logic worth knowing about, not obvious from the route list alone:

- **Invoices** compute `anita_income` from the tax year's configurable split
  percentage (`taxYearSettings.ts`'s `POST /:startYear/split`), not a hardcoded
  constant — `packages/core`'s `DEFAULT_SPLIT_PERCENTAGE` is only a fallback.
- **Time entries** snapshot `rate_at_entry` from whatever `hourlyRates.ts`'s
  `rateForDate()` resolves to on the entry's date, so a later rate correction doesn't
  silently rewrite historical entries unless `PATCH /hourly-rates/:id` explicitly
  requests a retroactive update.
- **Invoice batches** snapshot letterhead/bank details onto the batch at creation
  time — editing `invoice_settings` later doesn't alter already-sent batches.
- **Client notes** are append-only (`client_note_versions`) — editing a note adds a
  new version rather than overwriting, so history is preserved.
- **Tasks** advance `next_due_date` through a recurrence engine
  (`packages/core/src/taskRecurrence.ts`) on each logged action, rather than storing a
  precomputed schedule.
- **Fee estimate vs. actual** (`clients.fee_estimate`): compared against
  `SUM(invoices.total_amount)` for the client (`billedToDate`, computed via a
  correlated subquery, not stored) — the gross fee billed to the paying party, not
  `anita_income`, since the estimate is what the client/firm was quoted. Scoped to the
  *client*, not a matter, because `invoices.matter` is currently free text rather than
  a first-class entity — a client re-engaging for an unrelated second matter blends
  its billed total into the same figure as the first, unless the estimate is manually
  reset. A dedicated `matters` table would fix this but wasn't built; the client-level
  version was chosen as the smaller, well-precedented change.
- **Correspondence** (`letters.ts`) drafts a letter through an open-ended conversation
  with the drafting agent (`POST /letters/chat`) rather than a single-shot generate:
  the letter type is free text, and every fact/tone detail is discussed in the
  conversation itself. The chat endpoint is stateless — the frontend
  (`LetterGeneratorPage.tsx`) holds the full message history and resends it on every
  turn; nothing about the conversation is persisted server-side, only the final
  accepted draft. The one thing that *isn't* conversational is personal data: guided
  fields for anything identifying (name, address) are converted to placeholder tokens
  (e.g. `{{CLIENT_NAME}}`) before the conversation starts, and that token list is baked
  into the system prompt fresh on every call — so the drafting agent's prompt only
  ever contains token names, not values, for the whole conversation, not just the
  first turn. There's no redaction step to get wrong, because the model is never given
  anything to redact. `POST /letters/review` always runs a deterministic regex scan
  (`packages/core`'s `scanForPii`) as a hard gate regardless of whether
  `ANTHROPIC_API_KEY` is configured; the AI-based compliance/tone review layered on
  top of that is advisory only (its flags are never a pass/fail gate) and reads its
  ruleset from `account_settings.compliance_guidelines` — free text the account holder
  maintains themselves, since only they know which regulatory framework actually
  applies to their practice. Both agents share one account-wide model choice
  (`account_settings.ai_model`, Admin's AI settings panel — Haiku 4.5 or Sonnet 5, see
  `AI_MODELS` in `anthropic.ts`), and every call's token counts are logged to
  `ai_usage` (`endpoint`/`model`/`input_tokens`/`output_tokens`); `GET /letters/usage`
  aggregates that into a per-model and total estimated-cost figure (from Anthropic's
  published per-token pricing, computed by this app — not a live account balance) for
  the Usage admin tab. `letters.format` (`letter` or `email`) is chosen alongside letter
  type before drafting starts and changes the drafting agent's system prompt — an email
  gets a `Subject:` line and no postal address block, a letter doesn't. A saved letter
  can be reopened from Correspondence history (`GET /letters` already returns
  `draftBody`, nothing extra to fetch) and, from either the live draft or a reopened
  one, exported: `apps/web/src/letterExport.ts` generates a Word (`docx` package) or
  PDF (`pdf-lib`, lazy-imported like `invoicePdf.ts`) file client-side from the draft
  text verbatim (tokens included), which either just downloads or — if "Also save this
  file to Documents" is ticked — also uploads through the existing Documents feature
  (`uploadDocument`, direction `outbound`), landing in R2 encrypted like any other
  document. Nothing about the export path touches the AI or sends the letter anywhere
  new; it's the same accepted draft, repackaged.

## Frontend

All `.tsx` files live flat in `apps/web/src/` (no subfolders). Roughly three kinds:

- **Dashboard tile pages** — one per `Dashboard.tsx` tile (see below): `ClientsPage`,
  `TimeKeepingPage`, `InvoicesPage`, `PerformancePage`, `InvoiceGeneratorPage`,
  `ExpensesPage`, `TaxPage`, `TasksPage`, `AllDocumentsPage`, `LetterGeneratorPage`,
  `AdminPage`.
- **Admin sub-panels**, composed inside `AdminPage.tsx`'s rail nav (Categories /
  Billing / Account) — one `*Manager.tsx`/`*Panel.tsx` per manageable list or setting:
  `ClientCategoryManager`, `NoteCategoryManager`, `DocumentCategoryManager`,
  `ExpenseCategoryManager`, `TimeCategoryManager`, `TimeRateManager`,
  `InvoiceSettingsManager`, `TaxRatesManager`, `AiSettingsPanel` (model choice +
  compliance guidelines — both feed Correspondence's agents), `FeatureManager`,
  `InviteCodePanel`, `ProfileManager`, `UsagePanel` (Cloudflare free-tier usage +
  Correspondence's AI token/cost ledger), `AppearanceManager`.
- **Shared components**: `Brand`, `ThemeQuickSwitch`, `TaskQuickPanel`,
  `DayOfWeekPicker`, `FollowUpPicker`, `MarkdownToolbar`, `icons` (the `<Icon />`
  component and its `IconName` union — see [Icon system](#icon-system)). Plus
  `App.tsx` (auth/setup state resolution), `main.tsx` (entry point), `SignedInApp.tsx`
  (screen routing shell), `SetupPage.tsx`, `LoginPage.tsx`.

Client-scoped detail pages (`ClientNotesPage`, `ClientDocumentsPage`) are reached
*from* `ClientsPage`, not from the dashboard directly.

### Installing to a phone home screen

`apps/web/public/manifest.webmanifest` plus the icon set in `apps/web/public/icons/`
and `apps/web/public/apple-touch-icon.png` make the app installable from a phone
browser's "Add to Home Screen" — it launches with its own icon, name, and no browser
chrome (`display: "standalone"`), rather than opening as a bookmarked tab. `index.html`
links the manifest and sets the iOS-specific `apple-mobile-web-app-*` meta tags Safari
needs (Chrome/Android reads the manifest directly). The icon is a plain solid-ink
square with "AC" in Fraunces — the same wordmark seal as `Brand.tsx`'s header mark,
rendered at icon scale — kept within a safe center zone so it isn't clipped by
Android's various maskable-icon shapes. No screen or feature files changed; this is
static assets plus `index.html` only. Vite copies everything under `public/` to the
build output root as-is, so these paths need no build-step wiring.

### Dashboard tiles

| key | name | toggleable? |
|---|---|---|
| `clients` | Clients | No — foundational, other features reference client records |
| `time` | Time Keeping | Yes |
| `invoices` | Invoice Management | Yes |
| `performance` | Performance & Targets | Yes |
| `invoice-generator` | Invoice Generator | Yes |
| `expenses` | Expenses | Yes |
| `tax` | Tax & NI Estimate | Yes |
| `tasks` | Tasks & Reminders | Yes |
| `documents` | All Documents | Yes |
| `correspondence` | Correspondence | Yes |
| `admin` | Admin & Settings | No — where the toggle UI itself lives |

### Feature toggle system

Two independent lists have to agree, or the toggle 400s the moment someone tries to
save it: `apps/web/src/FeatureManager.tsx`'s `FEATURES` array (renders the checkboxes)
and `apps/api/src/routes/accountSettings.ts`'s `TOGGLEABLE_FEATURES` array (server-side
validation on `PUT /api/account-settings/features`). `Dashboard.tsx`'s tile filter
(`TILES.filter(tile => !disabledFeatures.includes(tile.key))`) is generic and needs no
change once both lists agree — see [`CLAUDE.md`](../CLAUDE.md) for the full checklist
this belongs to.

## Design system

All styling lives in one file, `apps/web/src/styles.css` — there is no per-component
CSS, no CSS-in-JS, no utility framework. This is deliberate at the current scale, but
it means consistency depends entirely on reusing what's already there rather than the
tooling catching drift. Before writing new page-level CSS, check whether an existing
class already does the job.

### Tokens & themes

Colors and fonts are CSS custom properties on `:root`, redefined per theme rather than
hardcoded per rule:

| Token | Purpose |
|---|---|
| `--ink` / `--ink-soft` / `--ink-faint` | primary / secondary / tertiary text |
| `--paper` / `--paper-raised` | page background / card-and-panel background |
| `--line` / `--line-strong` | hairline and stronger borders |
| `--error` / `--warn` | the only two hue-based "meaning" colors |
| `--button-bg` / `--button-fg` | primary button fill/text (aliases `--ink`/`--paper` except in Feel Good) |
| `--display` | heading font stack: `"Fraunces", Georgia, "Iowan Old Style", serif` (self-hosted woff2, weights 400/600) |
| `--sans` | body/UI font stack: system font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Arial, sans-serif`) |

There is deliberately no `--accent`/`--success` token — status is conveyed by fill,
outline, or dash weight on `--ink` (see [Status pills](#status-pill-convention))
rather than by color, keeping color reserved for `--error`/`--warn` and (in one theme)
the primary button.

**Three themes**: `light`, `dark`, `feelgood` ("Feel Good"), selected via a
`data-theme` attribute on `<html>` (`:root[data-theme="..."]` blocks in `styles.css`
redeclare the token set). No attribute at all means "follow the OS" — a
`@media (prefers-color-scheme: dark)` block supplies the dark values in that case.
Feel Good is the only theme that breaks from monochrome ink/paper: it overrides
`--button-bg`/`--button-fg` to a violet primary-button accent, the one deliberately
saturated color choice in the app, spent in exactly one place.

Theme state lives in `apps/web/src/theme.ts`: persisted to `localStorage` (key
`acm-theme`, not account settings — it's a per-device preference, not per-account),
applied via `applyTheme()` which sets/clears the `data-theme` attribute, and broadcast
across mounted components via a `CustomEvent("acm-theme-change")` so the header quick
switch (`ThemeQuickSwitch.tsx`) and the full picker in Admin & Settings
(`AppearanceManager.tsx`) stay in sync with each other. `main.tsx` calls
`applyTheme(getStoredTheme())` before `createRoot(...).render(...)` to avoid a flash
of the default theme on load.

**Any new UI must be checked against all three themes**, not just light — Feel Good's
accent button and dark's inverted contrast are both easy to break by hardcoding a
color instead of using a token.

### Reusable component classes

The shared layout/component vocabulary, in rough order of how widely it's used. All
of these appear across multiple otherwise-unrelated pages — reach for one of these
before inventing a new class:

- **App shell** (rendered once, wraps every signed-in page): `.page`, `.page-header`,
  `.page-header-right`, `.page-header-buttons` (all in `SignedInApp.tsx`).
- **Page structure**: `.back-link` ("← Back" at the top of a page), `.sr-only`,
  `.loading`, `.empty`, `.error`, `.hint`.
- **Data tables**: `.ledger` (primary data table), `.month-detail-table` (nested/admin
  detail table), `.table-scroll` (horizontal-scroll wrapper with edge-fade shadow
  cues for tables wider than the viewport).
- **Forms**: `.edit-panel` (boxed add/edit form), `.edit-row` / `.edit-field`
  (inline edit layout), `.form` (vertical flex form), `.filters` (search/filter bar),
  `.quick-add` (inline quick-add row), `.chip` / `.chip-group` (toggleable tag chips).
- **Actions**: `button.secondary` / `.secondary` (secondary button/link — note
  `a.secondary` exists too, for download-style links styled like a button),
  `.danger` (destructive action), `.row-actions` (button group in a table row),
  `.page-primary-action` (page-level "+ Add X" button wrapper).
- **Navigation**: `.hero-grid` / `.hero-tile` (the dashboard hub tiles, incl. an
  `.upcoming` "Coming soon" variant), `.admin-layout` / `.admin-rail` /
  `.admin-content` (Admin & Settings' rail nav), `.subtabs` / `.subtab`
  (horizontally-scrolling sub-tab row), `.mode-toggle` (segmented toggle control).
- **Stat display**: `.client-stat` / `.client-stats`, `.stat-groups` — dashboard-style
  stat tiles reused on several record pages (Clients, Expenses, Invoices, Time
  Keeping) and the Dashboard hub's own headline "Overview" row (`Dashboard.tsx`:
  received this tax year, outstanding, tasks needing attention, cumulative
  performance vs target). `.client-stat .n.stat-warn` flags a figure that needs
  action (via `--warn`, no new hue). `.section-eyebrow` is the small uppercase
  label above a section (e.g. "Overview" / "Everything else" on the Dashboard).

### Icon system

Every button/link across the app pairs a hand-drawn SVG icon with its existing text
label — icons are a scan aid for a solo practitioner, not a replacement for the label,
so nothing is icon-only. All icons live in one file, `apps/web/src/icons.tsx`: a
`PATHS: Record<IconName, JSX.Element>` map of hand-drafted `<path>`/`<circle>`/`<line>`
primitives in a 24×24 viewBox (1.8px stroke, round caps/joins, `fill: none`,
`stroke: currentColor`), rendered via a single `<Icon name="..." />` component. There
is no icon library — the CSP that governs both this bundle and published artifacts
avoids third-party icon CDNs, and hand-drawing keeps every icon visually consistent
with the pre-existing sun/moon icons in `ThemeQuickSwitch.tsx` (whose `SunIcon`/
`MoonIcon`/`SmileIcon` are exported and reused as-is by `AppearanceManager.tsx`, rather
than redrawn, so the header quick switch and the full Appearance picker always show
identical icons).

**One icon, one meaning, everywhere.** Edit is always the pencil, Delete always the
bin, Save always the check mark, regardless of which page or record type it appears
on — there are no per-entity icon variants. `.icon` sizes at `1.1em` (so it scales
automatically with whichever button's font-size context it's in — 15px default
buttons, 12px `.row-actions` buttons, 12.5px `.back-link`) via a `size="lg"` prop
(`.icon-lg`, fixed 22px) reserved for the Dashboard tile headings, which sit in a
`.tile-heading` flex wrapper alongside `.tile-name`. A single combined selector —
`button, a.secondary, .back-link { display: inline-flex; align-items: center; gap:
6px; }` in `styles.css` — aligns an icon with its label the same way in every button
variant at once; a button with no icon child renders identically to before.

**Documents vs. Invoices, the one deliberate collision to avoid**: Invoices get a
ledger/receipt icon (a billing *record*, nothing downloadable). Invoice Generator gets
a printer icon, used identically for both "Generate invoice" and "Download PDF" since
both are the same "produce a PDF right now" operation. Documents get a folder icon for
the section and a tray-download icon used *only* for Documents' own Download action,
nowhere else in the app. The printer (produce) and the tray (retrieve) never share an
icon or cross that boundary, even though both end with a file leaving the browser. The
10 dashboard-tile/section icons (Clients, Time Keeping, Invoices, Performance, Invoice
Generator, Expenses, Tax, Tasks, Documents, Admin) are identity anchors for
navigation, not verbs, and stay fixed per section.

### Status pill convention

A shared base `.status` pill (rounded, `1px solid var(--ink)` border), with meaning
conveyed by fill/border style rather than hue — solid ink fill for a completed/closed
state, dashed faint border for not-started/in-progress, plain outline for everything
in between. Concrete status classes are generated dynamically from the status string
(e.g. `InvoicesPage.tsx`'s `statusClass()`, `ClientsPage.tsx`'s local
`caseStatusClass()`) rather than hardcoded per value — a new status value picks up the
right pill treatment automatically as long as it goes through one of these helpers.

### Layout & responsiveness

No formal spacing-scale variables — margins/padding are ad hoc px values, but an
informal rhythm of `24 / 20 / 16 / 14 / 10 / 6px` recurs throughout; match it rather
than introducing new values. Responsive tile grids (`.hero-grid`, `.client-stats`,
`.stat-groups`) consistently use `grid-template-columns: repeat(auto-fit,
minmax(Npx, 1fr))` rather than fixed column counts. Breakpoints are `max-width`-based
and page-container width grows in two steps (`900px`, `1300px`); auth screens
(`.page-narrow`, `SetupPage.tsx`/`LoginPage.tsx`) are a fixed 360px at every viewport
and deliberately not responsive.

## Shared core package

`packages/core/src/` — plain TypeScript, built on Web Crypto only (no Node-only APIs),
so the same code runs unmodified in the Worker, in the Vite frontend bundle, and under
Vitest. Each file has a co-located `*.test.ts`.

| File | Purpose |
|---|---|
| `auth.ts` | PBKDF2-SHA256 password hashing, HMAC-signed session token create/verify |
| `income.ts` | `calculateAnitaIncome()` — applies the split % to an invoice total |
| `invoiceStatus.ts` | `INVOICE_STATUSES` + validator — single source of truth for the invoice lifecycle |
| `clientCaseStatus.ts` | `CLIENT_CASE_STATUSES` (Prospective/Active/Closed) + validator |
| `taxYear.ts` | UK tax-year math (6th-to-5th year boundaries, tax-month bucketing) |
| `tax.ts` | Self-employed sole-trader income tax + Class 2/4 NI calculator |
| `taskRecurrence.ts` | Task due-date engine — frequencies, weekday restriction, month clamping |

## Auth model

Multi-user, gated by a shared invite code (not strictly single-user, despite the
original README description):

- **Bootstrap**: the *first* account is created via `POST /api/setup` with no invite
  code (nobody exists yet to have set one). `GET /api/setup/status` is public and only
  reveals whether any account exists yet, driving whether the frontend shows
  `SetupPage` or `LoginPage`.
- **Every subsequent account** goes through `POST /api/register`, requiring a valid
  `inviteCode` matched against the singleton `account_settings.invite_code` (settable
  by any signed-in user via `InviteCodePanel.tsx`).
- **Sessions**: HMAC-SHA256-signed, self-contained tokens (`{userId, exp}` + signature,
  no server-side session store), 7-day lifetime, stored as an `httpOnly`, `secure`,
  `sameSite: Lax` cookie named `session`. `Lax` works because the Pages Function proxy
  (see [Topology](#request-flow-in-the-deployed-environment)) keeps requests
  same-origin from the browser's point of view.
- **Passwords**: minimum 8 characters, PBKDF2-SHA256 (100,000 iterations, random
  16-byte salt). Login returns an identical error for "no such user" and "wrong
  password" to avoid revealing account existence.
- There is no role/permission system beyond signed-in-or-not — every account sees the
  same Admin & Settings screens.
- **Display name**: `users.full_name` (nullable) is required on `/setup` and
  `/register` going forward; the one account that predates the column sets it via
  `PATCH /api/me` (`ProfileManager.tsx`, under Admin & Settings → Account → Your
  name). `SignedInApp.tsx` uses it to show a time-of-day greeting ("Good
  morning/afternoon/evening, {name}") in the header, computed from the browser's local
  time; it falls back to showing the email when no name is set.

## Document storage & encryption

Uploaded documents (`documents.ts`) go through:

1. Validation — extension *and* declared content-type must both match an allow-list
   (PDF, .doc, .docx, .eml, .msg), capped at 25 MB per file (`MAX_SIZE_BYTES`).
2. A storage-ceiling check — `STORAGE_CEILING_BYTES = 8 * 1024 * 1024 * 1024` (8 GiB),
   computed by summing `documents.size` across **all** documents including
   soft-deleted ones (their R2 objects are never actually removed). This is a real
   technical backstop, comfortably under R2's actual 10 GB free-tier limit.
3. Application-layer encryption (`documentEncryption.ts`) — AES-GCM via Web Crypto,
   using `DOCUMENT_ENCRYPTION_KEY` (a base64 32-byte secret) and a fresh random 12-byte
   IV per file, persisted in `documents.iv` since it's needed again to decrypt. This
   sits on top of R2's own at-rest encryption, using a key R2 itself never has.
4. The encrypted bytes are written to R2; only a pointer (bucket key) and metadata
   live in D1.

Deletes are soft (`deleted_at`/`deleted_by`) — the row and the R2 object both survive,
recoverable/auditable via `GET /api/documents/deleted` and the "Deleted documents"
admin tab.

The Usage panel (`usage.ts`) computes R2 storage from the app's own D1 accounting
(`SUM(documents.size)`) rather than calling Cloudflare's R2 API — this app is the sole
writer to the bucket, so D1 is already authoritative, and it avoids a third Cloudflare
API permission scope.

## Deployment & CI

`apps/api/wrangler.toml`: Worker `anita-invoice-tracker-api`, D1 binding `DB` →
`anita-invoice-tracker`, R2 binding `DOCUMENTS` → `acm-caseflow-documents`. Secrets
(`SESSION_SECRET`, `DOCUMENT_ENCRYPTION_KEY`, `CF_API_TOKEN`, `CF_ACCOUNT_ID`,
`ANTHROPIC_API_KEY`) are set via GitHub Actions at deploy time, not committed — all
but `SESSION_SECRET` are optional on `Env` and degrade to a clear "not configured" 500
rather than breaking the app or its tests if unset. `ANTHROPIC_API_KEY` powers
Correspondence's drafting/review agents (see `letters.ts` and the Correspondence
bullet under [Notable business logic](#api-routes)) — get a key from
console.anthropic.com and add it as a repo secret; there is a small per-letter cost
once it's live, unlike everything else in this stack.

`.github/workflows/ci.yml` — three jobs on every push/PR:

1. **`lint-and-test`** — `npm run lint` (eslint), `npm test` (vitest, all unit tests).
2. **`e2e`** — Playwright against a real `wrangler dev` + `vite build && vite preview`,
   uploads the report as an artifact on failure.
3. **`deploy`** (only on push to `main`, after the two jobs above are green) —
   applies D1 migrations remotely, ensures the R2 bucket and Pages project exist,
   deploys the Worker, builds the frontend, deploys to Cloudflare Pages.

The R2-bucket-provisioning step deliberately runs before any other `wrangler-action`
step in the job: that action silently runs `wrangler deploy` as a fallback on any step
that only declares `secrets:` without an explicit `command:`, which previously broke
deploys when the R2 binding existed in `wrangler.toml` before the bucket did.

This pipeline currently deploys to a single Cloudflare environment on every merge to
`main` — there is no separate staging/production split yet. See the note in
[`README.md`](../README.md#status) about the two-environment strategy still to be
decided before go-live.

## Testing

- **Unit**: Vitest, `npm test`. Every API route file and every `packages/core`
  file has a co-located `*.test.ts`.
- **E2E**: Playwright, `npm run test:e2e`. Deliberately minimal — one spec
  (`e2e/critical-path.spec.ts`), one browser (Chromium): create account → add a
  client inline → add an invoice → confirm it renders correctly on the ledger → back
  to dashboard. Runs against a real build (`wrangler dev` + `vite build && vite
  preview`), not mocks, with a fresh local D1 per run.
