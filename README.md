# Designathon X — Permanent Credential & Registration System

Next.js 15 · TypeScript · Tailwind · PostgreSQL (Neon free tier, or any Postgres 15+) · Vercel

Numbered teams (Team 001…) with four permanent participant slots (P1–P4). Every team and slot has a
permanent, unique, Argon2id-hashed PIN that survives renames, edits and imports. Two arenas consume them:

* **Problem Statement Arena** (`/arena/problems`) — team number/name + **team PIN** → one atomic, capacity-safe lock per team.
* **Goodies Arena** (`/arena/goodies`) — **employee ID + personal slot PIN** → one permanent reservation per employee, stock-safe.
* **Organizer console** (`/admin`) — problem statements & goodies (with quantities), projector QR screens with open/close, generate/extend teams, import CSV/XLSX, walk-ins, edits, slips (PDF), Excel report, event controls, audit log.

See [`docs/CREDENTIAL_POLICY.md`](docs/CREDENTIAL_POLICY.md) for the credential rules and the supervised reissue process.

## Architecture

```
Browser ──► Next.js route handlers (authorize, validate, CSRF origin check)
              │  service role only
              ▼
          PostgreSQL functions (one transaction each) ──► tables with RLS deny-all,
          immutability triggers, unique indexes, row locks
```
* **The database enforces the rules**, not just the UI: unique team number per event, P1–P4 unique per team (⇒ max 4),
  one active identity per employee, one assignment per team, one reservation per employee, unique PIN fingerprints,
  immutable credentials/teams/slots/history, append-only audit log.
* Concurrency: `lock_problem` locks team row → problem row and re-counts capacity; `reserve_goodie` locks slot row →
  goodie row. Verified with concurrent races against real PostgreSQL.
* Sessions: 256-bit random token in an httpOnly cookie, only its SHA-256 stored; re-validated on every request
  (credential still active, slot still held by the same identity). Works across refreshes and devices.
* Rate limiting: 5 failed PINs / 15 min per team or employee ID, 60 / 15 min per IP (venues share NAT).
* Admin roles: `viewer` < `registrar` < `admin` < `superadmin`, plus a separate `can_issue_credentials` flag for anything that reveals or replaces PINs.

## Setup

1. **Database:** in Vercel → your project → **Storage → Create Database → Neon (Free) → Connect to project**.
   This adds `DATABASE_URL` / `DATABASE_URL_UNPOOLED`. Any PostgreSQL 15+ also works.
2. **Secrets** (Vercel → Settings → Environment Variables), each from `openssl rand -base64 32`:
   `DX_PIN_PEPPER`, `DX_VAULT_KEY`, `CRON_SECRET`. Keep them stable for the whole event.
3. **First organizer:** set `DX_BOOTSTRAP_ADMIN_EMAIL` and `DX_BOOTSTRAP_ADMIN_PASSWORD` (≥ 12 chars).
4. **Deploy.** Every build runs `scripts/migrate.mjs` first: applies new migrations once, ensures the
   least-privilege runtime role `dx_app`, seeds `db/seed.sql` on the first run, creates the organizer.
   Problem statements and goodies are managed in the console (**Problem statements** / **Goodies** pages).
5. **More organizers / password reset:**
   `DATABASE_URL=<unpooled url> node scripts/create-admin.mjs someone@corp.com registrar "Name" [--issuer]`
6. **Goodies survey (before the event, no PIN):** console → **Goodies** to add each goodie with a photo, name and
   quantity → **Goodies survey** to copy the link / download the QR for the email and **Open survey**. Participants
   enter employee ID + name, pick one goodie and submit; counts update live. Download the Excel report any time.
7. **Problem Statement QR is shown on screen, not printed:** console → Problem statements / Goodies →
   **Show QR screen** (full-screen, for a projector) with an **Open / Close arena** button and live counts.

Local: `cp .env.example .env.local`, set `DATABASE_URL`, `npm install`, `npm run db:migrate`, `npm run dev`.

## Deploy (Vercel Hobby works)
* Push to `main` → Vercel builds (migrations run automatically) and deploys.
* `vercel.json` sets the Mumbai region (`bom1`) and a daily cron for `/api/cron/maintenance` (`CRON_SECRET`).
* Security model: the app connects as `dx_app` (no owner rights, cannot alter tables or disable the
  immutability triggers); RLS is on for every table; organizer sessions are httpOnly cookies backed by
  revocable server-side sessions; passwords and PINs are Argon2id hashes.

## Event-day runbook
| When | Do |
|---|---|
| T-3 days | Teams & credentials → Generate 50 teams. Batch-print **all** credential slips (A4, 2/page). Import online registrations. |
| T-1 day | Re-print slips for registered teams if names changed (PINs unchanged). Destroy the package once printed, or let it expire. |
| Doors open | Walk-ins: Walk-in → pick unused team → print credential slip (only while the package is live; otherwise Reissue). |
| Problem selection | Event controls → open Problem Statement Arena. |
| Goodies | Event controls → open Goodies Arena (auto-freezes participant changes). |
| Lost PIN | Superadmin → team → Reissue PIN (reason required) → print slip. |

## Event-day capacity (600–1000 participants)

Load-tested with **250 teams / 1000 participants + 2 phones per team, all from one IP address**
(`tests/load/arena.load.test.ts`): ~6,600 requests in 33 s at 200 concurrent users on a single
2-core machine, **zero 5xx, zero 429**, 1000/1000 goodies reserved exactly once, 250/250 problems
locked exactly once, no overselling, every double-tap safely rejected. Vercel runs many instances
in parallel, so production latency is far lower than that single-machine run.

Built-in safeguards for a crowd:
* **Shared venue Wi-Fi:** per-IP limit is 2000 failed PINs / 15 min (`DX_RL_IP_MAX`); brute force is
  stopped by the strict per-team / per-employee limit (5 / 15 min, `DX_RL_TARGET_MAX`).
* **Polling:** adaptive and jittered — 12 s while choosing, 60 s once locked, none after a goodie is
  reserved, paused in background tabs, instant refresh when the tab returns.
* **Team search** is cached at Vercel's edge for 15 s.
* **Hot rows** (one problem, one goodie) are serialized with row locks — correctness never depends on timing.

**Recommended plans for the event day**
| Service | Plan | Why |
|---|---|---|
| Vercel | Hobby is technically sufficient | Hobby's terms are personal/non-commercial — your call for a company event. |
| Neon | Free works; Launch (pay-per-use) if you want more headroom | Free scales to zero when idle and autoscales up to 2 CU; first request after idle takes a moment. |

Before doors open: open both arena pages once (warms functions), confirm the cron secret, and keep a
printed fallback list of team numbers. Run the load test against a staging copy with
`DX_LOAD_BASE_URL` / `DX_LOAD_DATABASE_URL` if you change anything.

## Tests
```
npm test            # unit + PostgreSQL integration (needs Postgres 15+ at DX_TEST_PG)
npm run test:e2e    # HTTP smoke test against a running server (see tests/e2e header)
npm run test:load   # 1000-participant load test against a running server (see tests/load header)
npm run build       # type-check + production build
```
`tests/db/credentials.test.ts` covers every required scenario: 50 teams/200 slots, PIN uniqueness, rename/edit
permanence, P3 add keeps credential, P2 removal keeps slot+history, duplicate employees, single problem lock under
10-way concurrency, capacity races, one-goodie-per-employee under concurrency, stock races, no reservation transfer,
rate limiting, role/RLS protection of credentials, package expiry, compromised-on-replacement + reissue, multi-device sessions,
and atomic no-overwrite imports.

## Import formats
* **Participant-based**: one row per person — `Team Number` (optional) · `Team Name` · `Name` · `Employee ID` · `Email` (optional).
  Rows group by team number (or team name); members fill P1…Pn in row order.
* **Team-based**: one row per team — `Team Number` (optional) · `Team Name` · `P1 Name` · `P1 Employee ID` · `P1 Email` … `P4 …`.

Without a team number, teams take the next vacant pre-generated number. Occupied teams are never overwritten; every
problem (duplicates, bad IDs, missing teams, size 2–4) is reported in the preview and nothing is imported until it is clean.

## Notes
* Slips use standard PDF fonts (Latin-1). Non-Latin names print with `?`; embed a Unicode TTF via `@pdf-lib/fontkit` if needed.
* `npm audit` may report advisories in transitive dev/build dependencies; review before go-live.
