import { Router } from 'express';
import { requireUser } from './auth';
import { prisma } from './db';

/** Export / backup of everything the user owns. Raw hand histories only on request (?raw=1). */
export const exportRouter = Router();
exportRouter.get('/', async (req, res) => {
  const userId = requireUser(req);
  const raw = req.query.raw === '1';
  const [user, prefs, attempts, ratings, ratingHistory, reviews, bookmarks, notes, annotations, decisions, hands] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true, displayName: true, createdAt: true } }),
    prisma.userPreference.findUnique({ where: { userId } }),
    prisma.decisionAttempt.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.rating.findMany({ where: { userId } }),
    prisma.ratingHistory.findMany({ where: { userId }, orderBy: { createdAt: 'asc' } }),
    prisma.reviewItem.findMany({ where: { userId } }),
    prisma.bookmark.findMany({ where: { userId } }),
    prisma.userNote.findMany({ where: { userId } }),
    prisma.annotation.findMany({ where: { userId }, orderBy: [{ decisionId: 'asc' }, { version: 'asc' }] }),
    prisma.realDecision.findMany({ where: { userId }, select: { id: true, externalId: true, familyId: true, street: true, status: true, issues: true, split: true, topics: true, observed: true } }),
    raw ? prisma.realHand.findMany({ where: { userId }, select: { handId: true, raw: true, status: true, issues: true } }) : Promise.resolve([]),
  ]);
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Content-Disposition', `attachment; filename="poker-decision-lab-export-${new Date().toISOString().slice(0, 10)}.json"`);
  res.send(JSON.stringify({ exportedAt: new Date().toISOString(), format: 'pdl-export-v1', user, preferences: prefs, attempts, ratings, ratingHistory, reviewItems: reviews, bookmarks, notes, annotations, realDecisions: decisions, realHands: hands }));
});
