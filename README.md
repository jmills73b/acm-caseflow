# ACM Caseflow

A web app for Anita's costs-consultancy business, replacing the spreadsheet
previously used to log invoices, track chargeable time, manage clients and
documents, and estimate UK income tax / National Insurance liability.

## Status

Built and functionally complete: all ten dashboard features below are implemented,
tested, and deploy automatically to a Cloudflare environment on every merge to `main`
(see [CI/CD](docs/ARCHITECTURE.md#deployment--ci)). **This is not yet a live
production system** — before it becomes the system of record for the business, it
needs to go through business acceptance testing (BAT), and a two-environment
(staging/production) deployment strategy is still to be decided.

The original requirements doc (10 epics, 39 stories) and GitHub Issues backlog cover
the initial build plan; the app has since grown well beyond that scope (time keeping,
client notes, tasks & reminders, document storage) as real usage surfaced more of
what the spreadsheet was doing. For what's actually built today, see
[**`docs/ARCHITECTURE.md`**](docs/ARCHITECTURE.md) — the current technical reference,
covering the data model, every API route, the frontend structure, auth, and
deployment topology in detail.

## What's built

| Feature | What it does |
|---|---|
| Clients | Client list with contact details, tag categories, and prospective/active/closed status |
| Time Keeping | Log chargeable time against a client in configurable billing units |
| Invoice Management | Log invoices, track status through to payment, see performance by client |
| Performance & Targets | Track actual income against this month's target |
| Invoice Generator | Batch eligible invoices into a consolidated bill, generate the PDF |
| Expenses | Log and categorise business expenses |
| Tax & NI Estimate | Estimate the current tax year's income tax and National Insurance |
| Tasks & Reminders | Recurring and one-off to-dos, with due dates, history, and client follow-ups |
| Documents | Encrypted per-client document storage, searchable across every client |
| Correspondence | Draft client letters with an AI reviewer for compliance and personal data |
| Admin & Settings | Manage every category list, billing settings, feature toggles, and account tools |

Every feature above except Clients and Admin & Settings can be individually hidden
from the dashboard via Admin & Settings → Account → Features.

## Stack (free to run, one paid-per-use exception)

| Layer | Choice |
|---|---|
| Frontend | Cloudflare Pages |
| API | Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Object storage | Cloudflare R2 (encrypted document storage) |
| CI | GitHub Actions |
| Auth | Built into the Worker, invite-code-gated — no third-party auth product |
| AI (Correspondence only) | Anthropic API — a few pence per letter, the one line item that isn't free |

Everything except Correspondence's AI calls stays at effectively £0/month at this
scale, with nothing that sleeps, pauses, or requires a paid tier for the expected
workload.

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for branching, testing expectations, and the
Definition of Done.
