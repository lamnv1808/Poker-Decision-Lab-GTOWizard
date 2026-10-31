import { createHash, randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import { prisma } from './db';
import { isProd } from './env';
import { HttpError, parse } from './http';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, keylen: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
export const SESSION_COOKIE = 'pdl_session';
const SESSION_DAYS = 30;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scrypt(password, salt, 64, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, saltB64, keyB64] = stored.split('$');
  if (alg !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const key = await scrypt(password, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return timingSafeEqual(key, expected);
}

const tokenHash = (t: string) => createHash('sha256').update(t).digest('hex');

async function createSession(res: Response, userId: string, userAgent?: string) {
  const token = randomBytes(32).toString('base64url');
  const expiresAt = new Date(Date.now() + SESSION_DAYS * 86400000);
  await prisma.session.create({ data: { tokenHash: tokenHash(token), userId, expiresAt, userAgent: userAgent?.slice(0, 200) } });
  res.cookie(SESSION_COOKIE, token, { httpOnly: true, sameSite: 'lax', secure: isProd, expires: expiresAt, path: '/' });
}

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
  }
}

export async function loadUser(req: Request, _res: Response, next: NextFunction) {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token) {
    const s = await prisma.session.findUnique({ where: { tokenHash: tokenHash(token) } });
    if (s && s.expiresAt > new Date()) req.userId = s.userId;
  }
  next();
}

export function requireUser(req: Request): string {
  if (!req.userId) throw new HttpError(401, 'unauthenticated', 'Sign in required');
  return req.userId;
}

/** Simple fixed-window limiter for credential endpoints (per IP + email). */
const attempts = new Map<string, { n: number; reset: number }>();
function rateLimit(key: string, max = 8, windowMs = 10 * 60 * 1000) {
  const now = Date.now();
  const e = attempts.get(key);
  if (!e || e.reset < now) {
    attempts.set(key, { n: 1, reset: now + windowMs });
    return;
  }
  e.n++;
  if (e.n > max) throw new HttpError(429, 'rate_limited', 'Too many attempts, try again later');
}
export function resetRateLimits() {
  attempts.clear();
}

const Email = z.string().trim().toLowerCase().email().max(200);
const Password = z.string().min(8).max(200);

async function profile(userId: string) {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId }, include: { preference: true } });
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    createdAt: user.createdAt,
    preferences: user.preference ?? { language: 'en', defaultMode: 'practice', explanationView: 'quick', strategyView: 'gto', showBB: true },
  };
}

export const authRouter = Router();

authRouter.post('/register', async (req, res) => {
  const body = parse(z.object({ email: Email, password: Password, displayName: z.string().trim().min(1).max(60), language: z.enum(['en', 'vi']).default('en') }), req.body);
  rateLimit(`reg:${req.ip}`, 20);
  const exists = await prisma.user.findUnique({ where: { email: body.email } });
  if (exists) throw new HttpError(409, 'email_taken', 'An account with this email already exists');
  const user = await prisma.user.create({
    data: { email: body.email, passwordHash: await hashPassword(body.password), displayName: body.displayName, preference: { create: { language: body.language } } },
  });
  await createSession(res, user.id, req.get('user-agent'));
  res.status(201).json(await profile(user.id));
});

authRouter.post('/login', async (req, res) => {
  const body = parse(z.object({ email: Email, password: z.string().min(1).max(200) }), req.body);
  rateLimit(`login:${req.ip}:${body.email}`);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  // Same error for unknown email and wrong password (no account enumeration).
  if (!user || !(await verifyPassword(body.password, user.passwordHash))) throw new HttpError(401, 'invalid_credentials', 'Incorrect email or password');
  await createSession(res, user.id, req.get('user-agent'));
  res.json(await profile(user.id));
});

authRouter.post('/logout', async (req, res) => {
  const token = req.cookies?.[SESSION_COOKIE] as string | undefined;
  if (token) await prisma.session.deleteMany({ where: { tokenHash: tokenHash(token) } });
  res.clearCookie(SESSION_COOKIE, { path: '/' });
  res.json({ ok: true });
});

authRouter.get('/me', async (req, res) => {
  if (!req.userId) {
    res.status(401).json({ error: 'unauthenticated' });
    return;
  }
  res.json(await profile(req.userId));
});

export const preferencesRouter = Router();
preferencesRouter.put('/', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(
    z.object({
      language: z.enum(['en', 'vi']).optional(),
      defaultMode: z.enum(['practice', 'rated']).optional(),
      explanationView: z.enum(['quick', 'deep']).optional(),
      strategyView: z.enum(['gto', 'exploit']).optional(),
      showBB: z.boolean().optional(),
      displayName: z.string().trim().min(1).max(60).optional(),
    }),
    req.body,
  );
  const { displayName, ...prefs } = body;
  if (displayName) await prisma.user.update({ where: { id: userId }, data: { displayName } });
  await prisma.userPreference.upsert({ where: { userId }, create: { userId, ...prefs }, update: prefs });
  res.json(await profile(userId));
});
