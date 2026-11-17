import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(__dirname, 'public', 'index.html'));
const USE_PG = !!process.env.DATABASE_URL;
const ADMIN = process.env.ADMIN_TOKEN || '';

const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
const newCode = () => randomBytes(5).toString('hex').toUpperCase().slice(0, 8);

// ---- Reply password -------------------------------------------------------
// Set REPLY_PASSWORD, or keep it in .reply-password (gitignored) next to this file.
// If neither exists a random one is generated once and written there.
function loadReplyPassword() {
  if (process.env.REPLY_PASSWORD) return process.env.REPLY_PASSWORD;
  const file = join(__dirname, '.reply-password');
  if (existsSync(file)) {
    const v = readFileSync(file, 'utf8').trim();
    if (v) return v;
  }
  const pwd = randomBytes(6).toString('base64url').slice(0, 10);
  writeFileSync(file, pwd + '\n', { mode: 0o600 });
  try { chmodSync(file, 0o600); } catch {}
  console.log('[noticeboard] generated reply password:', pwd, '(saved to .reply-password)');
  return pwd;
}

const REPLY_PASSWORD = loadReplyPassword();
// Session token derived from the password, so it survives restarts.
const COOKIE_NAME = 'nb_reply';
const TOKEN = createHmac('sha256', hash('nb-reply-v1:' + REPLY_PASSWORD)).update('reply-access').digest('base64url');

function safeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

const unlocked = (req) => safeEq(cookies(req)[COOKIE_NAME] || '', TOKEN);

let store;

if (USE_PG) {
  const { Pool } = await import('pg');
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.PGSSL === 'off' ? false : { rejectUnauthorized: false },
  });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS posts (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at BIGINT NOT NULL,
      delete_code TEXT
    );
    ALTER TABLE posts ADD COLUMN IF NOT EXISTS delete_code TEXT;
    CREATE TABLE IF NOT EXISTS replies (
      id SERIAL PRIMARY KEY,
      post_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at BIGINT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_replies_post ON replies(post_id);
  `);
  store = {
    listPosts: async () => (await pool.query('SELECT id, name, body, created_at FROM posts ORDER BY created_at DESC LIMIT 200')).rows,
    listReplies: async (id) => (await pool.query('SELECT id, name, body, created_at FROM replies WHERE post_id = $1 ORDER BY created_at ASC', [id])).rows,
    countReplies: async () => (await pool.query('SELECT post_id, COUNT(*)::int AS n FROM replies GROUP BY post_id')).rows,
    addPost: async (n, b, t, codeHash) => (await pool.query('INSERT INTO posts (name, body, created_at, delete_code) VALUES ($1,$2,$3,$4) RETURNING id', [n, b, t, codeHash])).rows[0].id,
    addReply: async (p, n, b, t) => { await pool.query('INSERT INTO replies (post_id, name, body, created_at) VALUES ($1,$2,$3,$4)', [p, n, b, t]); },
    getPost: async (id) => (await pool.query('SELECT id, delete_code FROM posts WHERE id = $1', [id])).rows[0],
    deletePost: async (id) => {
      await pool.query('DELETE FROM replies WHERE post_id = $1', [id]);
      await pool.query('DELETE FROM posts WHERE id = $1', [id]);
    },
  };
} else {
  const { DatabaseSync } = await import('node:sqlite');
  mkdirSync(join(__dirname, 'data'), { recursive: true });
  const db = new DatabaseSync(join(__dirname, 'data', 'board.db'));
  db.exec(`
    CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, delete_code TEXT);
    CREATE TABLE IF NOT EXISTS replies (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, name TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS idx_replies_post ON replies(post_id);
  `);
  const cols = db.prepare('PRAGMA table_info(posts)').all().map((c) => c.name);
  if (!cols.includes('delete_code')) db.exec('ALTER TABLE posts ADD COLUMN delete_code TEXT');

  const q = {
    posts: db.prepare('SELECT id, name, body, created_at FROM posts ORDER BY created_at DESC LIMIT 200'),
    replies: db.prepare('SELECT id, name, body, created_at FROM replies WHERE post_id = ? ORDER BY created_at ASC'),
    counts: db.prepare('SELECT post_id, COUNT(*) AS n FROM replies GROUP BY post_id'),
    addPost: db.prepare('INSERT INTO posts (name, body, created_at, delete_code) VALUES (?, ?, ?, ?)'),
    addReply: db.prepare('INSERT INTO replies (post_id, name, body, created_at) VALUES (?, ?, ?, ?)'),
    getPost: db.prepare('SELECT id, delete_code FROM posts WHERE id = ?'),
    delReplies: db.prepare('DELETE FROM replies WHERE post_id = ?'),
    delPost: db.prepare('DELETE FROM posts WHERE id = ?'),
  };
  store = {
    listPosts: async () => q.posts.all(),
    listReplies: async (id) => q.replies.all(id),
    countReplies: async () => q.counts.all(),
    addPost: async (n, b, t, codeHash) => Number(q.addPost.run(n, b, t, codeHash).lastInsertRowid),
    addReply: async (p, n, b, t) => { q.addReply.run(p, n, b, t); },
    getPost: async (id) => q.getPost.get(id),
    deletePost: async (id) => { q.delReplies.run(id); q.delPost.run(id); },
  };
}

const hits = new Map();
function limited(ip) {
  const now = Date.now();
  const win = 5 * 60 * 1000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > 20;
}

// Tighter limit for password attempts: 10 tries per 10 minutes per IP.
const tries = new Map();
function tooManyTries(ip) {
  const now = Date.now();
  const win = 10 * 60 * 1000;
  const arr = (tries.get(ip) || []).filter((t) => now - t < win);
  arr.push(now);
  tries.set(ip, arr);
  if (tries.size > 5000) tries.clear();
  return arr.length > 10;
}

const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function json(res, code, obj) {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function readBody(req, limit = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  const secure = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';

  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(html);
    }

    // --- reply password session ---
    if (req.method === 'GET' && url.pathname === '/api/session') {
      return json(res, 200, { unlocked: unlocked(req) });
    }

    if (req.method === 'POST' && url.pathname === '/api/unlock') {
      if (tooManyTries(ip)) return json(res, 429, { error: 'Too many attempts — try again later.' });
      const { password } = await readBody(req);
      if (!safeEq(clean(password, 200), REPLY_PASSWORD)) return json(res, 403, { error: 'Wrong password.' });
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': COOKIE_NAME + '=' + TOKEN + '; Path=/; HttpOnly; SameSite=Lax; Max-Age=' + 60 * 60 * 24 * 14 + (secure ? '; Secure' : ''),
      });
      return res.end(JSON.stringify({ unlocked: true }));
    }

    if (req.method === 'POST' && url.pathname === '/api/lock') {
      res.writeHead(200, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'set-cookie': COOKIE_NAME + '=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0' + (secure ? '; Secure' : ''),
      });
      return res.end(JSON.stringify({ unlocked: false }));
    }

    if (req.method === 'GET' && url.pathname === '/api/posts') {
      const isOpen = unlocked(req);
      const posts = await store.listPosts();
      const counts = new Map();
      for (const row of await store.countReplies()) counts.set(Number(row.post_id), Number(row.n));
      const out = [];
      for (const p of posts) {
        const item = { ...p, created_at: Number(p.created_at), reply_count: counts.get(Number(p.id)) || 0 };
        // Reply bodies never leave the server unless the password cookie is valid.
        item.replies = isOpen
          ? (await store.listReplies(p.id)).map((r) => ({ ...r, created_at: Number(r.created_at) }))
          : [];
        out.push(item);
      }
      return json(res, 200, { posts: out, unlocked: isOpen });
    }

    if (req.method === 'POST' && url.pathname === '/api/posts') {
      if (limited(ip)) return json(res, 429, { error: 'Too fast — take a breather.' });
      const { name, body } = await readBody(req);
      const n = clean(name, 40) || 'Anonymous';
      const b = clean(body, 2000);
      if (b.length < 2) return json(res, 400, { error: 'Too short.' });
      const code = newCode();
      const id = await store.addPost(n, b, Date.now(), hash(code));
      return json(res, 201, { id, delete_code: code });
    }

    const r = url.pathname.match(/^\/api\/posts\/(\d+)\/replies$/);
    if (req.method === 'POST' && r) {
      if (!unlocked(req)) return json(res, 401, { error: 'Enter the reply password first.', need_password: true });
      if (limited(ip)) return json(res, 429, { error: 'Too fast — take a breather.' });
      const postId = Number(r[1]);
      if (!(await store.getPost(postId))) return json(res, 404, { error: 'Post not found.' });
      const { name, body } = await readBody(req);
      const n = clean(name, 40) || 'Anonymous';
      const b = clean(body, 2000);
      if (b.length < 1) return json(res, 400, { error: 'Too short.' });
      await store.addReply(postId, n, b, Date.now());
      return json(res, 201, { ok: true });
    }

    const d = url.pathname.match(/^\/api\/posts\/(\d+)$/);
    if (req.method === 'DELETE' && d) {
      const id = Number(d[1]);
      const post = await store.getPost(id);
      if (!post) return json(res, 404, { error: 'Post not found.' });
      const adminOk = ADMIN !== '' && String(req.headers['x-admin-token'] || '') === ADMIN;
      const codeOk = post.delete_code && hash(String(req.headers['x-delete-code'] || '').toUpperCase()) === post.delete_code;
      if (!adminOk && !codeOk) return json(res, 403, { error: 'Wrong or missing delete code.' });
      await store.deletePost(id);
      return json(res, 200, { ok: true });
    }

    if (url.pathname === '/healthz') return json(res, 200, { ok: true, db: USE_PG ? 'postgres' : 'sqlite', replies: 'password' });
    json(res, 404, { error: 'not found' });
  } catch (err) {
    console.error(err);
    json(res, 400, { error: 'Something went wrong, please try again.' });
  }
});

const port = Number(process.env.PORT || 8787);
server.listen(port, '0.0.0.0', () => console.log('noticeboard listening on ' + port + ' db=' + (USE_PG ? 'postgres' : 'sqlite') + ' replies=password-protected'));
