# Poker Decision Lab — backups (private repository)

This repository holds only automation and documentation. **It never contains a database dump, a database
URL or a passphrase.** Backups are encrypted (GPG, AES-256) before they leave the GitHub runner and are stored
in private object storage (Cloudflare R2 or Backblaze B2) and as private workflow artifacts.

| Workflow | When | What it proves |
|---|---|---|
| `weekly-backup` | Sundays 19:17 UTC + on demand | production can be dumped consistently; the dump restores into an isolated Postgres 18 with every key/constraint, passes the integrity checks and boots the app; the encrypted file decrypts back to the same SHA-256; the upload to object storage is complete; old points are pruned (keeps 8 weeks, never fewer than 4) |
| `restore-drill` | 1st of every month 20:41 UTC + on demand | the newest **stored** backup can be downloaded, decrypted and restored by anyone holding the passphrase — and that the weekly job is still running (fails if the newest point is older than 8 days) |

Any failure opens an issue in this repository and GitHub e-mails you.

## Secrets (Settings → Secrets and variables → Actions → New repository secret)

| Secret | Where it comes from |
|---|---|
| `PDL_DATABASE_URL` | Render dashboard → database *Poker Lab* → Connect → **External Database URL** |
| `BACKUP_PASSPHRASE` | Generate a long random password (≥ 20 characters) in your password manager and keep it there. Without it no backup can ever be decrypted — including by you. |
| `BACKUP_S3_BUCKET` | the private bucket's name |
| `BACKUP_S3_ENDPOINT` | R2: `https://<account-id>.r2.cloudflarestorage.com` · B2: `https://s3.<region>.backblazeb2.com` |
| `BACKUP_S3_ACCESS_KEY_ID`, `BACKUP_S3_SECRET_ACCESS_KEY` | an API key limited to that one bucket, read + write |
| `BACKUP_S3_REGION` | B2 only: the region in the endpoint (e.g. `us-west-004`); R2: leave unset |

Optional variable `BACKUP_KEEP_WEEKS` (default 8).

## Recover (works without Render, without Claude, without any development environment)

You need: the passphrase (password manager), access to this repository or the bucket, and any computer with
`gpg` and PostgreSQL 18 client tools (`pg_restore`, `psql`).

1. Download the newest folder `weekly/<date>/` from the bucket (or the newest *weekly-backup* artifact).
2. Decrypt and verify: `gpg -d pdl-<date>.dump.gpg > pdl.dump` (asks for the passphrase), then
   `sha256sum pdl.dump` must print the same value as `pdl-<date>.sha256`.
3. Create an empty Postgres 18 database (Neon, Render, Supabase or local) and restore:
   `pg_restore --no-owner --no-acl --exit-on-error --dbname "$NEW_DATABASE_URL" pdl.dump`
4. Check: `psql "$NEW_DATABASE_URL" -At -F '|' -f scripts/integrity.sql` — every line must end in `|0`.
5. Point the web service's `DATABASE_URL` at the new database and redeploy. Delete `pdl.dump`.

Expected: RPO ≤ 7 days (take an on-demand run before risky changes); RTO 30–60 minutes.

## Troubleshooting

* *secret … is missing* — add the secret above. * *connection refused / timeout* — the Render database may be
suspended or expired; restore from the newest point instead. * *newest backup is N days old* — check the
*weekly-backup* runs and that the workflow is still enabled in the Actions tab (and that the repository is
still private: the workflows refuse to run in a public one). * *checksum mismatch* — do not use that point; use the previous one and open an issue.
