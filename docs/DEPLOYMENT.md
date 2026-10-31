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
`render.yaml` (repo root of this workspace) defines the service and database. Build: `npm ci && npm run build`; pre-deploy: `npm run db:migrate`; start: `npm start`. Content is validated and seeded at boot (idempotent).

## Manual
```bash
cd poker-decision-lab
npm ci
npm run build              # core typecheck, prisma generate, web build + bundle answer-leak guard
DATABASE_URL=... npm run db:migrate
DATABASE_URL=... APP_SECRET=... NODE_ENV=production npm start
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
