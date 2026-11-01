/**
 * Pack a Real Hand Source v2 directory into one gzip JSONL bundle (one `{hand, decisions, quizzes}`
 * per line) for upload to PUT /api/admin/bundles. The bundle contains private hand histories:
 * keep it out of the repository.
 * Usage: npx tsx scripts/build-bundle.ts <real-hand-source dir> <out.jsonl.gz>
 */
import { createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { dirSource } from '../src/realhands/import';

const [dir, out] = [process.argv[2], process.argv[3]];
if (!dir || !out) throw new Error('usage: build-bundle.ts <dir> <out.jsonl.gz>');
let n = 0;
async function* lines() {
  for await (const b of dirSource(dir!)()) {
    n++;
    yield `${JSON.stringify(b)}\n`;
  }
}
await pipeline(Readable.from(lines()), createGzip({ level: 9 }), createWriteStream(out));
console.log(`${n} hands → ${out}`);
