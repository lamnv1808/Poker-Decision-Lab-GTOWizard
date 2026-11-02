# Backups and recovery

Production runs on Render's **free** Postgres plan: no platform backups, no point-in-time recovery, no
export, and the database **expires on 2026-12-01 02:05 UTC** (Render API, verified 2026-11-02). Our own
backups are therefore the only recovery path.

## What exists

| Mechanism | What it produces | Verified by |
|---|---|---|
| **Weekly job** (`ops/backup/weekly-backup.yml`, GitHub Actions in a *private* repository) | `pg_dump` custom-format dump of the whole database (schema, constraints, sequences, migration history), GPG AES-256 encrypted, kept as a private artifact for 35 days (≥ 4 weekly recovery points) | every run restores it into an isolated Postgres 18, runs the app's integrity report and a server smoke test on the copy, and checks the encrypted file decrypts to the same SHA-256 |
| **Break-glass app backup** (`GET /api/admin/backup`) | gzip NDJSON of every table read in one REPEATABLE READ snapshot, with Postgres-computed per-table checksums and the schema version (applied migrations) | `scripts/restore-backup.ts` refuses a non-empty target or a different schema version, loads all-or-nothing, and re-verifies every table's row count and checksum |

The admin backup download is **off in production by default** (`BACKUP_ENDPOINT` unset). Turn it on
only for a one-off backup (set `BACKUP_ENDPOINT=on`, deploy, take the backup, remove it, deploy).

Backups contain password hashes and private hand histories: keep them only in private, access-controlled
storage, encrypted; never commit them to Git.

## One-time setup of the weekly job (owner)

The application repository is public, and artifacts of a public repository can be downloaded by any
GitHub user, so the job must live in a private repository (it refuses to run otherwise):

1. Create a **private** GitHub repository, e.g. `pdl-backups`.
2. Add repository secrets (Settings → Secrets and variables → Actions):
   - `PDL_DATABASE_URL` — Render dashboard → the *Poker Lab* database → Connect → **External Database URL**.
   - `BACKUP_PASSPHRASE` — a long random passphrase (≥ 20 characters). Store it in your password manager too:
     without it no backup can be decrypted.
3. Copy `ops/backup/weekly-backup.yml` to `.github/workflows/weekly-backup.yml` in that repository.
4. Actions → *weekly-backup* → **Run workflow** once; check the run is green and the summary shows the
   counts and `integrity ok: True`.

Failure alerting: a failed run opens an issue in that repository and GitHub e-mails you about the failed
workflow. GitHub disables scheduled workflows after 60 days without repository activity — if the issue
list and the Actions tab stay silent for more than a week, check the workflow is still enabled.

## Restore

**From a weekly dump** (target: any empty Postgres 18 database, e.g. a new Neon or Render database):

```bash
gpg -d pdl-YYYYMMDDTHHMMZ.dump.gpg > pdl.dump              # asks for BACKUP_PASSPHRASE
sha256sum pdl.dump                                           # must equal the .sha256 file
pg_restore --no-owner --no-acl --exit-on-error --dbname "$NEW_DATABASE_URL" pdl.dump
DATABASE_URL="$NEW_DATABASE_URL" npx tsx apps/server/scripts/integrity-report.ts   # "ok": true
DATABASE_URL="$NEW_DATABASE_URL" npx prisma migrate deploy --schema apps/server/prisma/schema.prisma  # only if the code is newer
```

Then point the web service's `DATABASE_URL` at the new database and deploy.

**From a break-glass NDJSON backup:** check out the commit that produced it (the header lists the
migrations), `prisma migrate deploy` on an empty database, then
`DATABASE_URL=… npx tsx apps/server/scripts/restore-backup.ts <file>` → must end with `VERIFIED: N tables`.
Then migrate forward with the current code.

## Expectations

| | Value |
|---|---|
| RPO (data you can lose) | up to 7 days with the weekly job; take a break-glass backup before any risky change |
| RTO (time to restore service) | ~30–60 min: create database (5 min), restore (~1 min for today's ~50 MB), integrity check, switch `DATABASE_URL`, deploy (~5 min) |
| Restore rehearsal | every weekly run restores into an isolated database and smoke-tests the app (exceeds the monthly requirement) |

Measured on 2026-11-02: production backup 48,978,303 bytes (gzip NDJSON) in 6 min 14 s; restore + checksum
verification of all 30 tables in 32 s; `pg_dump` of the same data 49 MB in 6 s, `pg_restore` OK.

## Database expiry contingency (Neon on hold)

The Render free database is deleted after **2026-12-01**. Options, cheapest first:

1. **Neon free** (planned; needs the owner's account permissions): create project (Singapore) → restore the
   latest weekly dump → integrity report → switch `DATABASE_URL` → keep Render until verified.
2. **New Render free database** (if Neon is still blocked): a new free database gets a fresh 30-day life.
   Render limits how many free databases a workspace may have (one at the time of writing — check the
   dashboard), so this may require deleting the expiring one first: only after a fresh weekly dump has been
   restored and verified elsewhere. Repeats monthly — a stop-gap.
3. **Paid Render Postgres** (smallest plan, a few dollars per month — confirm the current price; needs
   approval): no expiry, platform backups.

Deadline for deciding: **2026-11-20**, leaving 10 days for the move and verification.
