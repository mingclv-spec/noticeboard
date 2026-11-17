#!/usr/bin/env node
// Seed the board with the questions in questions.json (in display order).
// Usage:
//   node seed.mjs                       # post questions to http://localhost:8787
//   BASE_URL=https://app.onrender.com node seed.mjs
//   ADMIN_TOKEN=xxx node seed.mjs --clear   # wipe every post first
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE = (process.env.BASE_URL || 'http://localhost:' + (process.env.PORT || 8787)).replace(/\/$/, '');
const ADMIN = process.env.ADMIN_TOKEN || '';
const clear = process.argv.includes('--clear');

const questions = JSON.parse(readFileSync(join(__dirname, 'questions.json'), 'utf8'));

if (clear) {
  if (!ADMIN) {
    console.error('ADMIN_TOKEN is required to clear the board.');
    process.exit(1);
  }
  const { posts } = await (await fetch(BASE + '/api/posts', { cache: 'no-store' })).json();
  for (const p of posts) {
    const res = await fetch(BASE + '/api/posts/' + p.id, { method: 'DELETE', headers: { 'x-admin-token': ADMIN } });
    console.log('deleted #' + p.id, res.status);
  }
}

// The board lists newest first, so post in reverse to show 1..N top to bottom.
for (const q of [...questions].reverse()) {
  const res = await fetch(BASE + '/api/posts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: q.name || 'Ming', body: q.body }),
  });
  const j = await res.json().catch(() => ({}));
  console.log(res.status, j.id ? '#' + j.id : JSON.stringify(j), (q.body || '').slice(0, 50));
}

const { posts } = await (await fetch(BASE + '/api/posts', { cache: 'no-store' })).json();
console.log('board now has ' + posts.length + ' posts');
