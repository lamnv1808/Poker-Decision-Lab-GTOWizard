# Render PostgreSQL 18 → Neon: migration plan (2026-11-02, not executed)

Status: **planning + isolated rehearsal only**. Production still runs on Render (`dpg-dbj9sk49v7es739gggl0-a`,
expires **2026-12-01 02:05 UTC**). Nothing here switches production; every production step below needs explicit
owner approval.

## 1. Discovery

| Item | Render (production) | Neon (verified 2026-11-02) |
|---|---|---|
| Server | PostgreSQL 18 (pg_dump 18.6 dumps it) | PostgreSQL **18.6** (`SHOW server_version`) |
| Account / project | Render free DB, Singapore | Org `lamnv1808@gmail.com` (Free plan). No project existed; a **test** project `pdl-migration-rehearsal` (`red-heart-65209714`, `aws-ap-southeast-1` Singapore, branch `rehearsal`, database `pdl`, role `pdl_owner`) was created for the rehearsal — $0, contains no data |
| Limits | 1 GB, no backups, expires | branch logical size limit **1 GiB** (API), autoscaling 0.25 CU, scale-to-zero after 5 min idle, history retention 6 h; free-plan compute allowance — confirm in the console |
| Size | dump 33 MB (custom, compressed), ~170 MB as a fresh restore (measured earlier) | fits; ~17 % of 1 GiB |
| Extensions | `plpgsql` only (no `CREATE EXTENSION` in any migration) | `plpgsql` |
| Schema | 15 Prisma migrations, 34 tables incl. `_prisma_migrations` | all 15 migrations (132 statements) applied on Neon in one transaction: 33 tables + 77 indexes + 77 PK/FK/unique constraints = identical to a local migrate-deploy database without `_prisma_migrations` (then reset to empty) |
| Data (backup 20261102T1031Z) | User 13 · RealHand 52,523 · RealDecision 78,821 · Annotation 1,097 · DecisionAttempt 256 · contexts v3 = 78,704 | — |

Application facts that matter: Prisma 6.19.3 with one `DATABASE_URL`; `npm start` runs `prisma migrate deploy`
on every boot (needs a direct, non-PgBouncer connection); default Prisma pool; the context backfill and leak
memory run in the background after boot.

**Incompatibilities found: none at schema level.** Configuration decisions:

* Use Neon's **direct** endpoint (host without `-pooler`) for `DATABASE_URL`, with `sslmode=require` and
  `connect_timeout=15`. No code change. (The pooled endpoint would need `pgbouncer=true` plus a `directUrl`
  for migrations — a schema change we do not need at this size: one app instance, small Prisma pool.)
* TLS is mandatory on Neon (`sslmode=require`); Render already uses TLS externally.
* Cold start: Neon suspends after 5 min idle and resumes in ~0.5–2 s on the first query; Render's free web
  service itself sleeps after inactivity, so both cold starts can stack on the first request. `connect_timeout=15`
  covers it; Prisma retries the connection on the next request.

## 2. Data migration method

`pg_dump -Fc` (pg_dump 18) of the whole database → `pg_restore --no-owner --no-acl --exit-on-error` into an
**empty** Neon database. This is the method the weekly job already uses and verifies every week. It preserves
primary keys, foreign keys, unique constraints, sequences, timestamps, JSON columns and `_prisma_migrations`
(the app then finds nothing to migrate). Logical replication is not needed at 33 MB.

Validation (automated in `pdl-backup/.github/workflows/isolated-check.yml`, `neon: true`):

1. target must be empty, else refuse;
2. restore with `--exit-on-error` (all constraints re-created after data ⇒ referential integrity proven);
3. per table: row count **and** an MD5 over every row's text form, ordered — local restore vs Neon must be identical;
4. `scripts/integrity.sql` on Neon (9 checks = 0);
5. `prisma migrate deploy` on Neon reports nothing to apply; the app boots on Neon, registers a throw-away user,
   reads the session, deals a hand; timings for the same aggregate on both databases.

Writes between copy and cutover: **write freeze** (below). At 33 MB a full final dump+restore takes ~2–3 min,
so a short maintenance window is simpler and safer than replication.

## 3. Rehearsal (isolated, no production impact) — needs one owner action

The sandbox cannot open TCP connections to Neon; GitHub runners can. Owner action: in the Neon console copy the
connection string of project *pdl-migration-rehearsal* → database `pdl` and add it as repository secret
`NEON_REHEARSAL_URL` in `lamnv1808/pdl-backup`. Then Claude runs *isolated-check* with `neon: true`. The
rehearsal copies the newest **backup** (not production) into the Neon test project; that is a copy of real
user data in a new place, so it is gated on that owner action.

## 4. Cutover (needs approval; target ≤ 2026-11-20)

Pre-flight (T-1 day): green weekly backup + restore drill; green Neon rehearsal on the latest backup; a fresh,
empty Neon production branch/database; owner on hand.

1. **Backup**: run weekly-backup; it must be green (encrypted, restored, integrity ok).
2. **Freeze writes**: suspend the Render web service (Render dashboard → service → Suspend). No app = no writes.
   Announce ~15 min maintenance.
3. **Final copy**: run the Neon rehearsal path against the *production* Neon database: pg_dump of Render (read-only)
   → restore into empty Neon → per-table counts + checksums Render vs Neon identical → integrity.sql = 0.
   Record the counts and checksums (cutover baseline).
4. **Switch**: Render service → Environment → `DATABASE_URL` = Neon direct URL (owner pastes it; never in chat).
   Resume the service. Render's own database stays untouched.
5. **Verify**: deployed commit unchanged (bundle hash), `/api/health`, owner login, History shows the same hands,
   Today/My Leaks load, one simulated hand plays and grades; `migrate deploy` in the boot log found nothing to do.
6. **Backups follow the data**: owner updates `PDL_DATABASE_URL` in `pdl-backup` to the Neon direct URL; run
   weekly-backup immediately; it must be green.

**Abort** (resume on Render, nothing lost — Render was never written to) if any of: restore error; any count or
checksum differs; integrity check ≠ 0; app fails to boot or log in on Neon; p95 latency of the smoke requests
> 2× Render's; Neon storage > 80 % of the branch limit.

## 5. Rollback after cutover

* Before any new user write on Neon: set `DATABASE_URL` back to Render, redeploy. Zero loss.
* After writes on Neon (Render is now stale): freeze (suspend service) → pg_dump Neon → restore into an empty
  database (Render after `DROP SCHEMA public CASCADE` — destructive, needs approval — or any other empty
  Postgres 18) → same count/checksum verification → switch `DATABASE_URL` → resume. Neon holds the superset, so
  nothing is lost.
* Rollback is only possible while Render's database exists: cut over by **2026-11-20** so there are ≥ 10 days of
  fallback before it expires on 2026-12-01.

## 6. Performance comparison

Measured on production (Render web + Render DB, from the sandbox, authenticated QA account, 5 samples each,
2026-11-02): `/api/auth/me` 0.39–0.95 s, `/api/daily/plan` 0.41–0.94 s, `/api/history` 0.41–0.43 s,
`/api/leaks/real` 0.38–0.99 s (network floor ~0.38 s). The Neon rehearsal records query timings on both
databases from the same runner; the cutover smoke repeats the production measurements. Not yet measured: the
owner account's heavy pages on Neon.
