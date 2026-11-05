import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  APP_SECRET: z.string().min(8).default('dev-secret-change-me'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
  /** invite = sign-up needs an owner-issued code (private lab); open = anyone. Default: invite in production. */
  REGISTRATION: z.enum(['invite', 'open']).optional(),
  /** Comma-separated emails allowed to create invites. */
  OWNER_EMAILS: z.string().default(''),
  /**
   * The admin backup download (GET /api/admin/backup). Off by default in production: weekly
   * backups are taken with pg_dump by a scheduled job; switch on only for a break-glass backup.
   */
  BACKUP_ENDPOINT: z.enum(['on', 'off']).optional(),
  /** Decision Quality Engine verdicts in training feedback (evidence-labelled). Off unless set to 'on'. */
  DQE_FEEDBACK: z.enum(['on', 'off']).optional(),
  /** Decision Maths section in Full Hand feedback (Phase 4B Gate 1). Default off. */
  DQE_DECISION_MATHS: z.enum(['on', 'off']).optional(),
});

const parsed = Env.safeParse(process.env);
if (!parsed.success) {
  const missing = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
  console.error(
    `\nConfiguration error: missing or invalid environment variable(s): ${missing}.\n` +
      'Set DATABASE_URL to your PostgreSQL connection string (on Render: link a Postgres database or paste its Internal Database URL),\n' +
      'and APP_SECRET to a long random string. See docs/DEPLOYMENT.md.\n',
  );
  process.exit(1);
}
export const env = parsed.data;
if (env.NODE_ENV === 'production' && env.APP_SECRET === 'dev-secret-change-me') {
  throw new Error('APP_SECRET must be set in production');
}
export const isProd = env.NODE_ENV === 'production';
export let registrationMode: 'invite' | 'open' = env.REGISTRATION ?? (isProd ? 'invite' : 'open');
/** Tests only: switch registration mode. */
export function setRegistrationMode(m: 'invite' | 'open') {
  registrationMode = m;
}
export const ownerEmails = new Set(env.OWNER_EMAILS.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean));
export let backupEndpointOn = (env.BACKUP_ENDPOINT ?? (isProd ? 'off' : 'on')) === 'on';
/** Tests only. */
export function setBackupEndpoint(on: boolean) {
  backupEndpointOn = on;
}
