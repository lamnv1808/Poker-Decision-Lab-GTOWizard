import { randomInt } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import { inviteHash, requireUser } from './auth';
import { prisma } from './db';
import { ownerEmails } from './env';
import { HttpError, parse } from './http';

/** Owner-only invite management for the private lab (5–10 friends). */
export const invitesRouter = Router();
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O/1/I confusion

async function requireOwner(userId: string) {
  const u = await prisma.user.findUniqueOrThrow({ where: { id: userId }, select: { email: true } });
  if (!ownerEmails.has(u.email)) throw new HttpError(403, 'forbidden', 'Only the owner can manage invites');
}

invitesRouter.post('/', async (req, res) => {
  const userId = requireUser(req);
  await requireOwner(userId);
  const body = parse(z.object({ note: z.string().trim().max(80).optional(), days: z.number().int().min(1).max(30).default(7) }), req.body ?? {});
  const open = await prisma.inviteCode.count({ where: { createdById: userId, usedById: null, expiresAt: { gt: new Date() } } });
  if (open >= 20) throw new HttpError(409, 'too_many_invites', 'Too many unused invites');
  const code = Array.from({ length: 10 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('');
  const inv = await prisma.inviteCode.create({ data: { codeHash: inviteHash(code), createdById: userId, note: body.note ?? null, expiresAt: new Date(Date.now() + body.days * 86400000) } });
  // the plain code is shown exactly once; only its hash is stored
  res.status(201).json({ id: inv.id, code, expiresAt: inv.expiresAt, note: inv.note });
});

invitesRouter.get('/', async (req, res) => {
  const userId = requireUser(req);
  await requireOwner(userId);
  const list = await prisma.inviteCode.findMany({ where: { createdById: userId }, orderBy: { createdAt: 'desc' }, take: 50 });
  const users = new Map((await prisma.user.findMany({ where: { id: { in: list.map((i) => i.usedById).filter((x): x is string => !!x) } }, select: { id: true, displayName: true } })).map((u) => [u.id, u.displayName]));
  res.json(list.map((i) => ({ id: i.id, note: i.note, createdAt: i.createdAt, expiresAt: i.expiresAt, usedAt: i.usedAt, usedBy: i.usedById ? users.get(i.usedById) ?? '—' : null, status: i.usedById ? 'used' : i.expiresAt < new Date() ? 'expired' : 'open' })));
});

invitesRouter.delete('/:id', async (req, res) => {
  const userId = requireUser(req);
  await requireOwner(userId);
  await prisma.inviteCode.deleteMany({ where: { id: String(req.params.id), createdById: userId, usedById: null } });
  res.json({ ok: true });
});
