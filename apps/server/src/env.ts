import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  APP_SECRET: z.string().min(8).default('dev-secret-change-me'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
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
