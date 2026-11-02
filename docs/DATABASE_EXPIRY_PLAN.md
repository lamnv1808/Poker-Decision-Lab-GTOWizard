# Render free database expiry — recommendation (2026-11-02)

**Facts.** Production uses Render Postgres *free* (`dpg-dbj9sk49v7es739gggl0-a`, Postgres 18, Singapore).
The Render API reports `expiresAt 2026-12-01T02:05Z`. Render's documentation says free databases expire 30 days
after creation, have no backups, and only **one** free database can be active per workspace. A grace period
follows the expiry (third-party sources say about two weeks; not confirmed in Render's own docs — do not rely on it).
Data size: ~170 MB as a fresh copy (445 MB on the current disk including bloat from interrupted imports).

## Options

| | A. Neon Free on a personal account | B. Upgrade the Render database in place | C. New Render free database each month |
|---|---|---|---|
| Cost | $0 | paid plan (smallest ≈ $6–7/month per third-party listings — **confirm in the dashboard**); above the $0–5 target | $0 |
| Migration | restore the latest weekly dump, integrity check, switch `DATABASE_URL` | none (same database, same URL) | delete old → create new → restore → switch, every month |
| Limits | 0.5 GB storage per project (~34 % used today), 100 CU-hours/month, scales to zero after 5 min idle | plan-dependent; backups on paid plans | 1 GB, no backups, 30-day life |
| Risk | storage headroom shrinks if friends import large histories (mitigation: app-level gzip of raw hands, ~6×) | lowest operational risk | downtime and data-loss risk every month — **not recommended** |
| Blocker | Neon access was on hold because the company-managed account lacks permissions — a **personal** Neon account avoids that | budget approval | — |

## Recommendation

1. **Preferred: A — Neon Free on a personal account**, created by you (the only manual part: sign up, create a
   project in Singapore, copy its connection string into Render's `DATABASE_URL` when we switch). Everything else is
   already automated and tested: the weekly dump restores with `pg_restore`, `scripts/integrity.sql` verifies it,
   the app boots on the restored copy. Switch only after a green restore into Neon; keep Render untouched until the
   app has run on Neon for a few days.
2. **Fallback: B — upgrade the Render database in place** if A is not done by **2026-11-20**. It needs no migration,
   but costs a few dollars a month above the $0–5 target, so it needs your approval.
3. Do not use C.

Either way, the weekly backup and the monthly restore drill must be green **before** any switch, and the switch
itself (changing production `DATABASE_URL`) will be asked for explicitly.

Sources: [Render — Deploy for free](https://render.com/docs/free), [Render changelog: free PostgreSQL instances
expire after 30 days](https://render.com/changelog/free-postgresql-instances-now-expire-after-30-days-previously-90),
[Render — flexible Postgres plans](https://render.com/docs/postgresql-refresh), [Neon pricing](https://neon.com/pricing),
[Neon free plan limits](https://neon.com/faqs/free-plan-limits-and-quotas).
