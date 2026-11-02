import { createApp } from './app';
import { purgeExpiredSessions } from './auth';
import { seedContent } from './content';
import { env } from './env';
import { backfillAllContexts } from './realhands/import';

const app = createApp();
// Publish any new validated content versions at boot (idempotent; invalid content is rejected).
seedContent()
  .then((r) => console.log(`content: ${r.created.length} created, ${r.unchanged.length} unchanged, ${r.rejected.length} rejected`, r.rejected))
  .catch((e) => console.error('content seed failed', e));
purgeExpiredSessions()
  .then((n) => n && console.log(`sessions: purged ${n} expired`))
  .catch((e) => console.error('session purge failed', e));
app.listen(env.PORT, () => {
  console.log(`Poker Decision Lab API on :${env.PORT}`);
  // after start-up so health checks pass first
  if (env.NODE_ENV !== 'test') setTimeout(() => void backfillAllContexts().catch((e) => console.error('context backfill failed', e)), 10_000);
});
