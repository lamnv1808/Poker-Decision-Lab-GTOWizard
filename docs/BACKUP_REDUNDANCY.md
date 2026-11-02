# Second backup destination: Cloudflare R2 vs Backblaze B2 (2026-11-02, recommendation only)

Today: weekly encrypted `pg_dump` (GPG AES-256) kept as a private GitHub Actions artifact for 35 days; restore
verified in every run and by the monthly drill. One copy, one provider. The workflows already support an
S3-compatible bucket (`BACKUP_S3_*` secrets): upload + read-back verification, keep 8 weeks (never fewer than 4),
and the drill prefers the bucket. Adding a destination is configuration only.

## Size and growth

Encrypted backup ≈ 33 MB (13 users, 52.5 k hands). 8 weekly points ≈ 0.27 GB. Even 10× growth (friends importing
their histories) ≈ 2.7 GB — inside both providers' free 10 GB.

| | Cloudflare R2 | Backblaze B2 |
|---|---|---|
| Storage | 10 GB-month free, then $0.015/GB-month | first 10 GB free, then ~$6.95/TB-month |
| Egress (restore downloads) | free | free up to 3× stored, then $0.01/GB |
| Operations | 1 M writes + 10 M reads/month free | free at our volume |
| Signup | Cloudflare account; enabling R2 asks for a payment method even on the free tier | no card needed for the free 10 GB |
| Immutability | bucket lock rules | Object Lock (WORM) per bucket |
| Lifecycle | object lifecycle rules (delete after N days) | lifecycle rules |
| Expected cost for us | **$0/month** | **$0/month** |

Prices from the providers' pricing pages as summarised on 2026-11-02 — confirm in the dashboard before signing up.

## Recommendation: Backblaze B2

Both cost $0 at our size. B2 wins on practicality here: no payment card for the free tier (no surprise bills),
Object Lock protects backups even if the GitHub repo or a key is compromised, and egress only matters for rare
restores. R2 is an equally good choice if you already use Cloudflare.

Setup (owner, ~10 min; Claude then runs and verifies): create a **private** bucket `pdl-backups` (region shown
in the endpoint), enable Object Lock with 14-day governance retention, lifecycle "keep only the last version,
delete after 60 days"; create an application key restricted to that bucket (read+write, no delete-bucket); add
`BACKUP_S3_BUCKET`, `BACKUP_S3_ENDPOINT`, `BACKUP_S3_REGION`, `BACKUP_S3_ACCESS_KEY_ID`,
`BACKUP_S3_SECRET_ACCESS_KEY` to `pdl-backup`. Then: run weekly-backup (uploads + verifies), run restore-drill (it
will now restore **from the bucket**). No workflow change is needed.

## Controls after setup

* **Encryption & keys**: encrypted on the runner before upload; the bucket never sees plaintext. Passphrase in
  the owner's password manager + GitHub secret (fingerprint `525afe0f7b75` printed every run). Bucket key limited
  to one bucket; rotate yearly.
* **Retention**: GitHub artifacts 35 days (≥ 5 points) + bucket 8 weeks (≥ 8 points, never fewer than 4) + Object
  Lock 14 days against deletion.
* **Restore testing**: every weekly run restores its own dump; monthly drill restores the newest *stored* point
  (bucket first) and boots the released app on it; it also fails if the newest point is > 8 days old.
* **Alerting**: any failed run opens an issue in `pdl-backup` and GitHub e-mails the owner.
* **RPO** ≤ 7 days (take an on-demand run before risky changes; we did 5 today). **RTO** 30–60 min
  (download, decrypt, restore ~1 min for 33 MB, verify, switch `DATABASE_URL`).
