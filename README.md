# Designathon X — Permanent Credential & Registration System

Next.js 15 · TypeScript · Tailwind · Supabase (PostgreSQL, Auth, Storage) · Vercel

Numbered teams (Team 001…) with four permanent participant slots (P1–P4). Every team and slot has a
permanent, unique, Argon2id-hashed PIN that survives renames, edits and imports. Two arenas consume them:

* **Problem Statement Arena** (`/arena/problems`) — team number/name + **team PIN** → one atomic, capacity-safe lock per team.
* **Goodies Arena** (`/arena/goodies`) — **employee ID + personal slot PIN** → one permanent reservation per employee, stock-safe.
* **Organizer console** (`/admin`) — generate/extend teams, import CSV/XLSX, walk-ins, edits, slips (PDF), Excel report, event controls, audit log.

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

1. **Supabase**: create a project. Apply migrations (`supabase link` then `supabase db push`), or paste
   `supabase/migrations/*.sql` into the SQL editor in order. Then run `supabase/seed.sql` (edit event name, QR URLs, problem statements, goodies first).
2. **Admins**: create users in Supabase Auth (email/password), then:
   ```sql
   insert into admin_users (user_id, email, role, can_issue_credentials)
   select id, email, 'superadmin', true from auth.users where email = 'you@company.com';
   ```
   Disable public sign-ups in Supabase Auth settings.
3. **Problem documents**: upload PDFs to the private `problem-docs` bucket and set `problem_statements.document_path`
   (served to verified teams via 10-minute signed URLs).
4. **Environment**: copy `.env.example` → `.env.local`; generate `DX_PIN_PEPPER`, `DX_VAULT_KEY` with `openssl rand -base64 32`.
   Keep the pepper stable for the whole event. Store both only in Vercel env vars / a secret manager.
5. `npm install && npm run dev`

## Deploy (Vercel)
* Import the repo, set all env vars from `.env.example` (Production + Preview), deploy.
* `vercel.json` sets the Mumbai region (`bom1`, change to match your Supabase region), 60 s limits for PDF/provisioning routes,
  and an hourly cron for `/api/cron/maintenance` (authorized with `CRON_SECRET`).
* Optional: set `DX_DATABASE_URL` (Supabase transaction pooler) + `DX_DATABASE_ROLE=service_role` to call the same
  functions over direct PostgreSQL instead of PostgREST.

## Event-day runbook
| When | Do |
|---|---|
| T-3 days | Teams & credentials → Generate 50 teams. Batch-print **all** credential slips (A4, 2/page). Import online registrations. |
| T-1 day | Re-print slips for registered teams if names changed (PINs unchanged). Destroy the package once printed, or let it expire. |
| Doors open | Walk-ins: Walk-in → pick unused team → print credential slip (only while the package is live; otherwise Reissue). |
| Problem selection | Event controls → open Problem Statement Arena. |
| Goodies | Event controls → open Goodies Arena (auto-freezes participant changes). |
| Lost PIN | Superadmin → team → Reissue PIN (reason required) → print slip. |

## Tests
```
npm test            # unit + PostgreSQL integration (needs Postgres 15+ at DX_TEST_PG)
npm run test:e2e    # HTTP smoke test against a running server (see tests/e2e header)
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
