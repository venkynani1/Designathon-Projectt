# Credential policy & supervised reissue

## What is permanent
| Item | Changes when… |
|---|---|
| Team UUID, team number | Never (DB trigger blocks updates and deletes) |
| Slot UUID, slot number P1–P4 | Never |
| Team PIN, P1–P4 PINs | Only through **supervised reissue** (below). Never on rename, name/email edits, imports, adding or removing members. |
| Team name, participant name/email | Any time (audited) |

## How PINs are stored
* Generated with Node's CSPRNG (`crypto.randomInt`), 6 digits, weak patterns rejected; never derived from team numbers or employee IDs.
* Stored as **Argon2id** hashes (19 MiB, t=2). Verification is constant-time and always performs one Argon2 computation (unknown team/employee uses a dummy hash).
* Uniqueness: an HMAC-SHA256 fingerprint keyed by `DX_PIN_PEPPER` (outside the DB) has a UNIQUE index per event — no PIN value is ever reused within an event, including retired ones.
* Printable plaintext exists only inside an **AES-256-GCM sealed package** (`DX_VAULT_KEY`, outside the DB, bound to the package id) that expires after `events.package_ttl_hours` (default 72 h). An hourly cron destroys expired ciphertext. Admins can destroy a package early.

## Issuance
1. An admin with *credential issuance* permission generates teams → a package is created.
2. Before expiry, print **credential slips** (Teams & credentials → batch print, or per team). Printing marks each PIN `disclosed_at`.
3. Hand each team its slip; teammates detach their own coupon. The team leader keeps the team-PIN section.
4. Destroy the package once everything is printed (optional; it self-destructs at expiry).

## When a PIN can't be printed
PINs **cannot be recovered from hashes**. If the package has expired, slips show `REISSUE`. A superadmin with issuance permission uses **Reissue PIN** (team detail). This:
* revokes the old credential (kept for history; can never be reactivated),
* creates version *n+1* with a new random PIN and a new 24 h package,
* logs out every device using the old PIN,
* writes an audit record with the mandatory reason.
The team/slot identity, number, assignment and reservations are unaffected.

## Participant replacement
* Replacing or removing an occupant releases their identity (history kept) and **never transfers** their goodie reservation.
* If that slot's PIN was already disclosed (`disclosed_at` set), it is flagged **compromised**: logins with it fail with "visit the registration desk" until reissued — the former participant's knowledge grants nothing to anyone.
* If it was never disclosed, the original permanent PIN stays valid for the new occupant.

## Freeze
Opening the Goodies Arena freezes identity changes (add/remove/replace/import). After that only a **superadmin** may make changes, with a reason (≥10 chars); each is audited as `*.privileged`. Renames and spelling/email fixes stay allowed.
