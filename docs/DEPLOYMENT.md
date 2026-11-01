# Deployment

One web service (Node 20+) serving the API and the built SPA, plus managed PostgreSQL (Render, Neon, Supabase Postgres…).

## Environment
| Var | Notes |
|---|---|
| `DATABASE_URL` | Postgres connection string |
| `APP_SECRET` | 32+ random bytes (`openssl rand -hex 32`); signs Math Lab tokens. Required in production |
| `NODE_ENV` | `production` (enables Secure cookies, HSTS) |
| `PORT` | provided by the host |
| `CORS_ORIGINS` | empty in production (same origin) |

## Render

**Recommended: Blueprint.** Dashboard → New → Blueprint → pick this repository. `render.yaml` creates the web service *and* the Postgres database, links `DATABASE_URL`, and generates `APP_SECRET`.

**Existing manually created Web Service** (no database attached):
1. Dashboard → New → PostgreSQL → create it in the same region as the web service.
2. Web service → Environment → add:
   - `DATABASE_URL` = the database's **Internal Database URL**
   - `APP_SECRET` = a long random string (`openssl rand -hex 32`)
   - `NODE_ENV` = `production`
3. Web service → Settings: Build Command `npm ci --include=dev && npm run build`, Start Command `npm start`, Health Check Path `/api/health`.
4. Manual Deploy → Deploy latest commit.

`npm start` applies pending migrations, then starts the server, which validates and seeds scenario content (idempotent). Node is pinned to 22 via `.node-version` and `engines`.

## Manual
```bash
cd poker-decision-lab   # repository root
npm ci
npm run build              # core typecheck, prisma generate, web build + bundle answer-leak guard
DATABASE_URL=... APP_SECRET=... NODE_ENV=production npm start   # migrates, then serves
```

## Local development
```bash
cp apps/server/.env.example apps/server/.env   # point at a local Postgres
npm run db:migrate && npm run dev:server        # API on :8080
npm run dev:web                                 # Vite on :5173 (proxies /api)
```

## Tests
```bash
npm test                    # core + server integration (needs Postgres DB pdl_test) + web components
npm run test:e2e            # Playwright, uses DB pdl_e2e_test
```
Test setups drop/recreate the schema only for databases whose name ends in `_test`.
