import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { createApp } from '../src/app';
import { seedContent } from '../src/content';

export const app = createApp();
let seeded: Promise<unknown> | null = null;
export const ensureSeeded = () => (seeded ??= seedContent());

export async function newUser(name = 'u') {
  const agent = request.agent(app);
  const email = `${name}-${randomUUID()}@test.dev`;
  const res = await agent.post('/api/auth/register').send({ email, password: 'correct horse battery', displayName: name });
  if (res.status !== 201) throw new Error(`register failed ${res.status} ${JSON.stringify(res.body)}`);
  return { agent, email, id: res.body.id as string };
}

export const cid = () => `t-${randomUUID()}`;
