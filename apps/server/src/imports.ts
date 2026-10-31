import { createHash } from 'node:crypto';
import { type ReconstructedHand, ggParser, parseHandHistoryText, publicState, reconstructHand, reviewSpots, legalActions, initialSrs, reviewSrs, masteryEstimate } from '@pdl/core';
import { Router } from 'express';
import JSZip from 'jszip';
import multer from 'multer';
import { z } from 'zod';
import { requireUser } from './auth';
import { prisma } from './db';
import { HttpError, notFound, parse } from './http';
import { recordAttempt } from './learning';

const MAX_FILE = 20 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 500;
const MAX_UNZIPPED = 100 * 1024 * 1024;
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_FILE, files: 1 } });

/** Extract .txt hand-history files from an upload (TXT or ZIP). */
export async function extractTexts(filename: string, buf: Buffer): Promise<{ name: string; text: string }[]> {
  const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
  if (!isZip) return [{ name: filename, text: buf.toString('utf8') }];
  const zip = await JSZip.loadAsync(buf);
  const entries = Object.values(zip.files).filter((f) => !f.dir && /\.txt$/i.test(f.name) && !f.name.startsWith('__MACOSX'));
  if (entries.length > MAX_ZIP_ENTRIES) throw new HttpError(413, 'too_many_files', `ZIP contains more than ${MAX_ZIP_ENTRIES} text files`);
  let total = 0;
  const out: { name: string; text: string }[] = [];
  for (const e of entries) {
    const text = await e.async('string');
    total += text.length;
    if (total > MAX_UNZIPPED) throw new HttpError(413, 'too_large', 'Unzipped content too large');
    out.push({ name: e.name, text });
  }
  return out;
}

function serialize(h: ReconstructedHand) {
  const { raw: _raw, ...parsed } = h.parsed;
  return { parsed, positions: h.positions, heroPosition: h.heroPosition, allInSeen: h.allInSeen, potComputed: h.potComputed, tableSize: h.table.players.length };
}

export async function importBuffer(userId: string, filename: string, buf: Buffer) {
  const sha256 = createHash('sha256').update(buf).digest('hex');
  const texts = await extractTexts(filename, buf);
  const file = await prisma.importedFile.create({ data: { userId, filename: filename.slice(0, 200), sha256, sizeBytes: buf.length, status: 'completed' } });
  let parsedCount = 0;
  let dup = 0;
  let failed = 0;
  const formats = new Set<string>();
  const seenInUpload = new Set<string>();
  for (const t of texts) {
    const res = parseHandHistoryText(t.text);
    if (res.format) formats.add(res.format);
    for (const e of res.errors) {
      failed++;
      await prisma.importError.create({ data: { userId, importedFileId: file.id, externalHandId: e.handId, message: `${t.name}: ${e.message}`.slice(0, 1000), lineNo: e.line ?? null, raw: e.raw.slice(0, 20000) } });
    }
    for (const h of res.hands) {
      const key = `${h.parsed.site}:${h.parsed.handId}`;
      const exists = seenInUpload.has(key) || (await prisma.handHistory.findUnique({ where: { userId_site_externalHandId: { userId, site: h.parsed.site, externalHandId: h.parsed.handId } } }));
      if (exists) {
        dup++;
        continue;
      }
      seenInUpload.add(key);
      const tournament = h.parsed.tournamentId
        ? await prisma.tournament.upsert({
            where: { userId_site_externalId: { userId, site: h.parsed.site, externalId: h.parsed.tournamentId } },
            create: { userId, site: h.parsed.site, externalId: h.parsed.tournamentId, name: h.parsed.tournamentName },
            update: {},
          })
        : null;
      await prisma.handHistory.create({
        data: {
          userId,
          importedFileId: file.id,
          tournamentId: tournament?.id ?? null,
          site: h.parsed.site,
          externalHandId: h.parsed.handId,
          playedAt: h.parsed.playedAt ? new Date(`${h.parsed.playedAt}Z`) : null,
          heroName: h.parsed.heroName,
          heroPosition: h.heroPosition,
          tableSize: h.table.players.length,
          bigBlind: h.parsed.bigBlind,
          allIn: h.allInSeen,
          potComputed: h.potComputed,
          raw: h.parsed.raw,
          parsed: serialize(h) as object,
          actions: { create: h.parsed.actions.map((a, i) => ({ seq: i, street: a.street, player: a.player, type: a.type, amount: a.amount, allIn: a.allIn, isHero: a.player === h.parsed.heroName })) },
        },
      });
      parsedCount++;
    }
  }
  const status = parsedCount + dup === 0 && failed > 0 ? 'failed' : 'completed';
  return prisma.importedFile.update({
    where: { id: file.id },
    data: { handsParsed: parsedCount, handsDuplicate: dup, handsFailed: failed, format: [...formats].join(',') || null, status },
  });
}

async function loadHand(userId: string, id: string) {
  const hand = await prisma.handHistory.findFirst({ where: { id, userId } });
  if (!hand) throw notFound('Hand not found');
  const rec = reconstructHand(ggParser.parse(hand.raw));
  return { hand, rec, spots: reviewSpots(rec) };
}

export const importsRouter = Router();

importsRouter.post('/', upload.single('file'), async (req, res) => {
  const userId = requireUser(req);
  if (!req.file) throw new HttpError(400, 'no_file', 'Upload a .txt or .zip file in the "file" field');
  const result = await importBuffer(userId, req.file.originalname, req.file.buffer);
  const errors = await prisma.importError.findMany({ where: { importedFileId: result.id, userId }, select: { externalHandId: true, message: true, lineNo: true } });
  res.status(201).json({ ...result, errors });
});

importsRouter.get('/', async (req, res) => {
  const userId = requireUser(req);
  res.json(await prisma.importedFile.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 }));
});

importsRouter.get('/:id', async (req, res) => {
  const userId = requireUser(req);
  const file = await prisma.importedFile.findFirst({ where: { id: String(req.params.id), userId }, include: { errors: { select: { externalHandId: true, message: true, lineNo: true } } } });
  if (!file) throw notFound();
  res.json(file);
});

export const handsRouter = Router();

handsRouter.get('/', async (req, res) => {
  const userId = requireUser(req);
  const q = parse(z.object({ limit: z.coerce.number().int().min(1).max(200).default(50), allIn: z.enum(['true', 'false']).optional() }), req.query);
  const hands = await prisma.handHistory.findMany({
    where: { userId, ...(q.allIn ? { allIn: q.allIn === 'true' } : {}) },
    orderBy: [{ playedAt: 'desc' }, { createdAt: 'desc' }],
    take: q.limit,
    select: { id: true, externalHandId: true, playedAt: true, heroPosition: true, tableSize: true, bigBlind: true, allIn: true, potComputed: true, parsed: true, tournament: { select: { name: true, externalId: true } }, _count: { select: { actions: { where: { isHero: true } } } } },
  });
  res.json(
    hands.map(({ parsed, _count, ...h }) => {
      const p = (parsed as { parsed: { heroCards: string[] | null; level: string | null } }).parsed;
      return { ...h, heroCards: p.heroCards, level: p.level, heroDecisions: _count.actions };
    }),
  );
});

/** Hand summary without Hero's actions (so spots can be quizzed). */
handsRouter.get('/:id', async (req, res) => {
  const userId = requireUser(req);
  const { hand, rec, spots } = await loadHand(userId, String(req.params.id));
  const answered = new Set(
    (await prisma.decisionAttempt.findMany({ where: { userId, attemptType: 'imported', itemRef: { startsWith: `${hand.id}:` } }, select: { itemRef: true } })).map((a) => Number(a.itemRef.split(':')[1])),
  );
  res.json({
    id: hand.id,
    externalHandId: hand.externalHandId,
    playedAt: hand.playedAt,
    tournament: rec.parsed.tournamentName,
    level: rec.parsed.level,
    blinds: { smallBlind: rec.parsed.smallBlind, bigBlind: rec.parsed.bigBlind, ante: rec.parsed.ante },
    heroName: rec.parsed.heroName,
    heroPosition: rec.heroPosition,
    heroCards: rec.parsed.heroCards,
    tableSize: rec.table.players.length,
    allIn: rec.allInSeen,
    warnings: rec.parsed.warnings,
    spots: spots.map((s, i) => ({ index: i, street: s.street, answered: answered.has(i), facingBet: s.facts.toCallBB > 0 })),
  });
});

handsRouter.get('/:id/spots/:index', async (req, res) => {
  const userId = requireUser(req);
  const { hand, rec, spots } = await loadHand(userId, String(req.params.id));
  const i = Number(req.params.index);
  const spot = spots[i];
  if (!spot) throw notFound('Spot not found');
  const state = rec.statesBefore[spot.actionIndex]!;
  res.json({
    handId: hand.id,
    index: i,
    street: spot.street,
    heroId: rec.parsed.heroName,
    positions: rec.positions,
    bigBlind: rec.parsed.bigBlind,
    state: publicState(state, rec.parsed.heroName!),
    legal: legalActions(state),
    facts: spot.facts,
    // Original action is withheld until the user commits.
  });
});

handsRouter.post('/:id/spots/:index/answer', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(z.object({ clientAttemptId: z.string().min(8).max(100), action: z.object({ type: z.enum(['fold', 'check', 'call', 'bet', 'raise']), amount: z.number().int().positive().optional() }) }), req.body);
  const { hand, rec, spots } = await loadHand(userId, String(req.params.id));
  const i = Number(req.params.index);
  const spot = spots[i];
  if (!spot) throw notFound('Spot not found');
  const state = rec.statesBefore[spot.actionIndex]!;
  const legal = legalActions(state)!;
  const a = body.action;
  const legalOk =
    (a.type === 'fold' && legal.canFold) ||
    (a.type === 'check' && legal.canCheck) ||
    (a.type === 'call' && legal.toCall > 0) ||
    ((a.type === 'bet' ? legal.canBet : a.type === 'raise' ? legal.canRaise : false) && a.amount !== undefined && a.amount <= legal.maxRaiseTo && (a.amount >= legal.minRaiseTo || a.amount === legal.maxRaiseTo));
  if (!legalOk) throw new HttpError(400, 'illegal_action', 'That action is not legal here');
  const original = spot.heroAction;
  const sameType = original.type === a.type;
  const bb = rec.parsed.bigBlind;
  const result = {
    handId: hand.id,
    index: i,
    yourAction: a,
    originalAction: { type: original.type, amount: original.amount, allIn: original.allIn },
    matchesOriginal: sameType && (a.amount === undefined || Math.abs((a.amount - original.amount) / bb) <= 0.5),
    facts: spot.facts,
    note: {
      en: 'Hand histories do not contain the information needed to compute EV for this spot, and the showdown result is not evidence of a correct or incorrect decision. Use the exact facts below and save the spot to your queue to study it.',
      vi: 'Lịch sử ván bài không chứa đủ thông tin để tính EV cho tình huống này, và kết quả showdown không phải bằng chứng quyết định đúng hay sai. Hãy dùng các dữ kiện chính xác bên dưới và lưu tình huống vào hàng đợi để học.',
    },
  };
  const outcome = await recordAttempt({
    userId,
    clientAttemptId: body.clientAttemptId,
    attemptType: 'imported',
    itemRef: `${hand.id}:${i}`,
    reviewType: 'imported',
    reviewRef: `${hand.id}:${i}`,
    mode: 'practice',
    action: a,
    graded: false,
    gradeBasis: 'none',
    ratingEligible: false,
    isError: false,
    gradingMethodVersion: 'imported-v1',
    street: spot.street,
    heroPosition: rec.heroPosition ?? undefined,
    effectiveStackBB: spot.facts.effectiveStackBB,
    difficulty: 3,
    skills: [],
    concepts: [],
    leakOpportunities: [],
    optionLeaks: [],
    sourceClass: 'EXPERIMENTAL',
    result,
  });
  res.json(outcome.result);
});

/** Save an imported spot to the spaced-repetition queue (due now). */
handsRouter.post('/:id/spots/:index/queue', async (req, res) => {
  const userId = requireUser(req);
  const { hand, spots } = await loadHand(userId, String(req.params.id));
  const i = Number(req.params.index);
  if (!spots[i]) throw notFound('Spot not found');
  const now = new Date();
  const s = initialSrs(now);
  const itemRef = `${hand.id}:${i}`;
  await prisma.reviewItem.upsert({
    where: { userId_itemType_itemRef: { userId, itemType: 'imported', itemRef } },
    create: { userId, itemType: 'imported', itemRef, dueAt: now, ease: s.ease, mastery: 0 },
    update: { dueAt: now },
  });
  void reviewSrs;
  void masteryEstimate;
  res.json({ ok: true, itemRef });
});
