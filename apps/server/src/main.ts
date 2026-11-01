import { createApp } from './app';
import { purgeExpiredSessions } from './auth';
import { seedContent } from './content';
import { env } from './env';

const app = createApp();
// Publish any new validated content versions at boot (idempotent; invalid content is rejected).
seedContent()
  .then((r) => console.log(`content: ${r.created.length} created, ${r.unchanged.length} unchanged, ${r.rejected.length} rejected`, r.rejected))
  .catch((e) => console.error('content seed failed', e));
purgeExpiredSessions()
  .then((n) => n && console.log(`sessions: purged ${n} expired`))
  .catch((e) => console.error('session purge failed', e));
app.listen(env.PORT, () => console.log(`Poker Decision Lab API on :${env.PORT}`));
