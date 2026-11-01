import { createHmac, randomInt, timingSafeEqual } from 'node:crypto';
import { QUIZ_KINDS, type QuizKind, generateQuiz, gradeQuiz, quizDifficulty, GRADING_METHOD_VERSION, isError } from '@pdl/core';
import { Router } from 'express';
import { z } from 'zod';
import { requireUser } from './auth';
import { env } from './env';
import { HttpError, parse } from './http';
import { recordAttempt } from './learning';
import { prisma } from './db';

/** Quizzes are issued as signed tokens (kind, seed, level, user) so answers are graded server-side. */
function sign(payload: string) {
  return createHmac('sha256', env.APP_SECRET).update(payload).digest('base64url');
}
export function issueToken(userId: string, kind: QuizKind, seed: number, level: number) {
  const payload = Buffer.from(JSON.stringify({ u: userId, k: kind, s: seed, l: level })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}
function readToken(userId: string, token: string) {
  const [payload, sig] = token.split('.');
  if (!payload || !sig) throw new HttpError(400, 'invalid_token');
  const expected = Buffer.from(sign(payload));
  const got = Buffer.from(sig);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) throw new HttpError(400, 'invalid_token');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString()) as { u: string; k: QuizKind; s: number; l: 1 | 2 | 3 };
  if (data.u !== userId) throw new HttpError(403, 'forbidden');
  return data;
}

export const mathRouter = Router();

mathRouter.get('/quiz', (req, res) => {
  const userId = requireUser(req);
  const q = parse(z.object({ kind: z.enum(QUIZ_KINDS).optional(), level: z.coerce.number().int().min(1).max(3).default(2) }), req.query);
  const kind = q.kind ?? QUIZ_KINDS[randomInt(QUIZ_KINDS.length)]!;
  const seed = randomInt(1, 2 ** 31 - 1);
  const quiz = generateQuiz(kind, seed, q.level as 1 | 2 | 3);
  res.json({ token: issueToken(userId, kind, seed, q.level), kind, level: q.level, skill: quiz.skill, prompt: quiz.prompt, unit: quiz.unit, tolerance: quiz.tolerance, formula: quiz.formula });
});

mathRouter.post('/quiz/answer', async (req, res) => {
  const userId = requireUser(req);
  const body = parse(z.object({ token: z.string().min(10).max(2000), value: z.number().finite(), clientAttemptId: z.string().min(8).max(100), mode: z.enum(['practice', 'rated']).default('rated') }), req.body);
  const t = readToken(userId, body.token);
  const quiz = generateQuiz(t.k, t.s, t.l);
  const { grade, error } = gradeQuiz(quiz, body.value);
  const session =
    (await prisma.trainingSession.findFirst({ where: { userId, kind: 'math', mode: body.mode, endedAt: null, startedAt: { gt: new Date(Date.now() - 2 * 3600 * 1000) } }, orderBy: { startedAt: 'desc' } })) ??
    (await prisma.trainingSession.create({ data: { userId, kind: 'math', mode: body.mode } }));
  const result = { kind: quiz.kind, prompt: quiz.prompt, value: body.value, answer: quiz.answer, unit: quiz.unit, tolerance: quiz.tolerance, error, grade, steps: quiz.steps, formula: quiz.formula, source: { classification: 'MATH_VERIFIED' } };
  const outcome = await recordAttempt({
    userId,
    clientAttemptId: body.clientAttemptId,
    sessionId: session.id,
    attemptType: 'quiz',
    itemRef: `quiz:${quiz.kind}:${quiz.level}:${quiz.seed}`,
    reviewType: 'quiz',
    reviewRef: `${quiz.kind}`,
    mode: body.mode,
    action: { value: body.value },
    graded: true,
    grade,
    gradeBasis: 'exact',
    ratingEligible: true,
    isError: isError(grade),
    gradingMethodVersion: GRADING_METHOD_VERSION,
    difficulty: quizDifficulty(quiz),
    skills: [...new Set([quiz.skill, 'math' as const])],
    concepts: [quiz.kind],
    leakOpportunities: quiz.kind === 'potOdds' || quiz.kind === 'callEv' ? ['potOdds'] : quiz.kind === 'combos' ? ['comboCounting'] : quiz.kind === 'icm' ? ['icmAdjustments'] : [],
    optionLeaks: isError(grade) ? (quiz.kind === 'potOdds' || quiz.kind === 'callEv' ? ['potOdds'] : quiz.kind === 'combos' ? ['comboCounting'] : quiz.kind === 'icm' ? ['icmAdjustments'] : []) : [],
    sourceClass: 'MATH_VERIFIED',
    track: 'fundamentals',
    result,
  });
  res.json(outcome.result);
});
