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

## Controls (owner requirements A1/A2)

| Requirement | How it is met | Status |
|---|---|---|
| Weekly automatic encrypted backup | GitHub Actions schedule, `pg_dump` → GPG AES-256 | ready; needs the private repo + secrets |
| Off-platform storage | private workflow artifact (GitHub) and, optionally, private S3-compatible bucket | ready |
| Retention | artifacts 35 days (≥ 4 weekly points); bucket lifecycle rule recommended 8 weeks | configurable |
| Integrity verification | SHA-256 of the plaintext, decrypt round-trip check, full `pg_restore --exit-on-error` (all keys/constraints), app integrity report | every run |
| Restore drill | every weekly run restores into an isolated Postgres 18 and smoke-tests the server (exceeds monthly); plus the owner's own monthly drill below | every run |
| Success/failure monitoring | job summary with counts; failure opens an issue + GitHub e-mail | every run |
| Recovery independent of Render and of Claude | passphrase in the owner's password manager and GitHub secrets; dumps in GitHub/bucket; restore needs only `gpg` + `pg_restore` | by design |
| No secrets in Git, logs or chat | secrets only in GitHub Actions secrets; the workflow never echoes them; dumps never committed | by design |

The backup taken from a temporary Claude sandbox on 2026-11-02 was encrypted with a key that existed only in
that sandbox. It is **not** a recoverable backup: the key and the encrypted file were deleted on purpose. The
owner's recoverable copies are the weekly job's artifacts once it runs, and the 2026-11-01 file delivered
earlier (unencrypted — keep it in private storage or delete it once weekly backups exist).

### Owner's monthly restore drill (no Claude involved)

1. Actions → latest green *weekly-backup* run → download the artifact.
2. `gpg -d pdl-*.dump.gpg > pdl.dump` (passphrase from your password manager); compare `sha256sum pdl.dump` with the `.sha256` file.
3. Restore into a throw-away database (local Postgres 18, or a free Neon branch once available) with the
   commands in "Restore" below, then run the integrity report: it must print `"ok": true`.
4. Delete the decrypted file and the throw-away database.

## One-time setup of the weekly job (owner)

The application repository is public, and artifacts of a public repository can be downloaded by any
GitHub user, so the job must live in a private repository (it refuses to run otherwise):

1. Create a **private** GitHub repository, e.g. `pdl-backups`.
2. Add repository secrets (Settings → Secrets and variables → Actions):
   - `PDL_DATABASE_URL` — Render dashboard → the *Poker Lab* database → Connect → **External Database URL**.
   - `BACKUP_PASSPHRASE` — a long random passphrase (≥ 20 characters). Store it in your password manager too:
     without it no backup can be decrypted.
3. Copy `ops/backup/weekly-backup.yml` to `.github/workflows/weekly-backup.yml` in that repository.
4. Optional, recommended: create a private bucket (Cloudflare R2 or Backblaze B2 have free tiers), an
   access key limited to that bucket, a lifecycle rule deleting objects after 8 weeks, and add the
   `BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` secrets.
5. Actions → *weekly-backup* → **Run workflow** once; check the run is green and the summary shows the
   counts and `integrity ok: True`. Then tell Claude the run is green (no links to files or secrets needed).

Failure alerting: a failed run opens an issue in that repository and GitHub e-mails you about the failed
workflow. The monthly restore drill also fails if the newest backup is older than 8 days — if the issue
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
