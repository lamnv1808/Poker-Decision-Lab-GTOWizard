# Poker Decision Lab

Cloud-ready Texas Hold'em **decision-training** platform for intermediate-to-advanced MTT players: realistic 6/8/9-max tables, Hero and Villain training on branching decision trees, honest math (pot odds, MDF, bluff ratios, ICM, bounties), Glicko-2 skill ratings, leak detection, spaced repetition and GGPoker hand-history review — in English and Vietnamese.

It trains decision quality. It does not offer or promote real-money play, and it never presents heuristic content as solver output.

- Architecture, data model, risks: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
- Phase checklist & limitations: [`docs/IMPLEMENTATION_CHECKLIST.md`](docs/IMPLEMENTATION_CHECKLIST.md)
- Adding content: [`docs/CONTENT_WORKFLOW.md`](docs/CONTENT_WORKFLOW.md)
- Running & deploying: [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)

```bash
npm ci
cp apps/server/.env.example apps/server/.env
npm run db:migrate
npm run dev:server   # :8080
npm run dev:web      # :5173
```
