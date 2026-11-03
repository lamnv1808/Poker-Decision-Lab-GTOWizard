import { describe, expect, it } from 'vitest';
import { ensureSeeded, newUser } from './helpers';

/**
 * Every Mixed Training setting the setup page offers must either start and serve items through to
 * the summary, or refuse up front with a clear reason — never create a session that cannot serve.
 */
const FOCUS = ['fullhand', 'preflop', 'postflop', 'math', 'villain', 'replay'] as const;
const MIXES = ['balanced', 'heroFocus', 'newOnly', 'weak', 'due'] as const;
const DIFFS = ['adaptive', 'easy', 'medium', 'hard'] as const;

async function run(agent: Awaited<ReturnType<typeof newUser>>['agent'], body: object) {
  const r = await agent.post('/api/mixed/sessions').send(body);
  if (r.status !== 201) return { status: r.status, body: r.body };
  const id = r.body.id as string;
  const served: string[] = [];
  for (let i = 0; i < 3; i++) {
    const n = await agent.post(`/api/mixed/sessions/${id}/next`);
    if (n.status !== 200) return { status: n.status, body: n.body, id, served };
    served.push(n.body.type);
  }
  await agent.post(`/api/mixed/sessions/${id}/end`).expect(200);
  const sum = (await agent.get(`/api/mixed/sessions/${id}/summary`).expect(200)).body;
  return { status: 201, id, served, sum };
}

describe('Mixed Training: every setting starts or refuses clearly', () => {
  it('each single focus (user without imported hands)', async () => {
    await ensureSeeded();
    const u = await newUser('mxfocus');
    const out: Record<string, unknown> = {};
    for (const f of FOCUS) out[f] = await run(u.agent, { focus: [f], mode: 'practice' });
    for (const f of FOCUS.filter((x) => x !== 'replay')) {
      expect((out[f] as { status: number }).status, f).toBe(201);
      expect((out[f] as { served: string[] }).served.length, f).toBe(3);
    }
    // a focus that cannot serve anything for this user is refused before a session exists
    expect(out.replay).toMatchObject({ status: 400, body: { error: 'focus_unavailable' } });
    expect((out.replay as { id?: string }).id).toBeUndefined();
  });

  it('every mix × difficulty × mode with the default focus', async () => {
    await ensureSeeded();
    const u = await newUser('mxmix');
    for (const mix of MIXES)
      for (const difficulty of DIFFS)
        for (const mode of ['practice', 'rated'] as const) {
          const r = await run(u.agent, { mix, difficulty, mode, durationMin: 5 });
          expect(r.status, `${mix}/${difficulty}/${mode}: ${JSON.stringify(r.body ?? '')}`).toBe(201);
          expect(r.served, `${mix}/${difficulty}/${mode}`).toHaveLength(3);
        }
  }, 120_000);
});
