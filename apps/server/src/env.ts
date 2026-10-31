import { z } from 'zod';

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  APP_SECRET: z.string().min(8).default('dev-secret-change-me'),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().default(8080),
  CORS_ORIGINS: z.string().default('http://localhost:5173'),
});

export const env = Env.parse(process.env);
if (env.NODE_ENV === 'production' && env.APP_SECRET === 'dev-secret-change-me') {
  throw new Error('APP_SECRET must be set in production');
}
export const isProd = env.NODE_ENV === 'production';
