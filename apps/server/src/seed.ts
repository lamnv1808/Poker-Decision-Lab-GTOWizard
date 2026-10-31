import { seedContent } from './content';
import { prisma } from './db';

const r = await seedContent();
console.log(JSON.stringify(r, null, 2));
await prisma.$disconnect();
process.exit(r.rejected.length ? 1 : 0);
