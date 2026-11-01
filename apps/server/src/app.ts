import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import cookieParser from 'cookie-parser';
import express, { type NextFunction, type Request, type Response } from 'express';
import { adminRouter } from './admin';
import { historyRouter } from './history';
import { realLeaksRouter } from './leakEngine';
import { memoryRouter } from './leakMemory';
import { dailyRouter } from './daily';
import { improvementRouter } from './improvement';
import { invitesRouter } from './invites';
import { trainingProgressRouter } from './trainingProgress';
import { analyticsRouter } from './analytics';
import { authRouter, loadUser, preferencesRouter } from './auth';
import { env, isProd } from './env';
import { errorHandler } from './http';
import { gtoRouter } from './gto';
import { postflopRouter } from './postflop';
import { realRouter } from './realhands/routes';
import { exportRouter } from './export';
import { handsRouter, importsRouter } from './imports';
import { mathRouter } from './mathlab';
import { bookmarksRouter, notesRouter, reviewRouter } from './review';
import { runsRouter, scenariosRouter } from './runs';
import { simRouter } from './sim';
import { mixedRouter } from './mixed';
import { prisma } from './db';

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '200kb' }));
  app.use(cookieParser());
  // Security headers
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'same-origin');
    if (isProd) res.setHeader('Strict-Transport-Security', 'max-age=15552000');
    next();
  });
  // CORS for the dev web server (production serves the SPA from the same origin)
  const origins = env.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
  app.use((req, res, next) => {
    const origin = req.get('origin');
    if (origin && origins.includes(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE');
      res.setHeader('Vary', 'Origin');
    }
    if (req.method === 'OPTIONS') return void res.sendStatus(204);
    next();
  });
  // CSRF: state-changing requests must come from an allowed origin (cookies are SameSite=Lax too)
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (['POST', 'PUT', 'DELETE'].includes(req.method)) {
      const origin = req.get('origin');
      const host = `${req.protocol}://${req.get('host')}`;
      if (origin && origin !== host && !origins.includes(origin)) return void res.status(403).json({ error: 'bad_origin' });
    }
    next();
  });
  app.get('/api/health', async (_req, res) => {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true });
  });
  app.use('/api', loadUser);
  app.use('/api/auth', authRouter);
  app.use('/api/preferences', preferencesRouter);
  app.use('/api/scenarios', scenariosRouter);
  app.use('/api/runs', runsRouter);
  app.use('/api/math', mathRouter);
  app.use('/api/review', reviewRouter);
  app.use('/api/bookmarks', bookmarksRouter);
  app.use('/api/notes', notesRouter);
  app.use('/api/imports', importsRouter);
  app.use('/api/hands', handsRouter);
  app.use('/api/real', realRouter);
  app.use('/api/export', exportRouter);
  app.use('/api/admin', adminRouter);
  app.use('/api/history', historyRouter);
  app.use('/api/leaks/real', realLeaksRouter);
  app.use('/api/memory', memoryRouter);
  app.use('/api/daily', dailyRouter);
  app.use('/api/improvement', improvementRouter);
  app.use('/api/invites', invitesRouter);
  app.use('/api/training-progress', trainingProgressRouter);
  app.use('/api/sim', simRouter);
  app.use('/api/mixed', mixedRouter);
  app.use('/api/gto/postflop', postflopRouter);
  app.use('/api/gto', gtoRouter);
  app.use('/api', analyticsRouter);
  app.use('/api', (_req, res) => void res.status(404).json({ error: 'not_found' }));

  // Serve the built SPA in production
  const here = dirname(fileURLToPath(import.meta.url));
  const webDist = join(here, '../../web/dist');
  if (existsSync(webDist)) {
    app.use(express.static(webDist, { index: false, maxAge: '1h' }));
    app.get(/^(?!\/api).*/, (_req, res) => res.sendFile(join(webDist, 'index.html')));
  }
  app.use(errorHandler);
  return app;
}
