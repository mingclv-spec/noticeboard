import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const root = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(join(root, 'public', 'index.html'));
mkdirSync(join(root, 'data'), { recursive: true });
const db = new DatabaseSync(join(root, 'data', 'market.db'));
db.exec(`
  PRAGMA journal_mode=WAL;
  CREATE TABLE IF NOT EXISTS markets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    unit TEXT NOT NULL DEFAULT 'USD',
    status TEXT NOT NULL DEFAULT 'open',
    closes_at TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS predictions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    market_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    value REAL NOT NULL,
    comment TEXT NOT NULL DEFAULT '',
    delete_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    FOREIGN KEY(market_id) REFERENCES markets(id)
  );
  CREATE INDEX IF NOT EXISTS idx_predictions_market ON predictions(market_id, created_at DESC);
`);
const count = db.prepare('SELECT COUNT(*) AS n FROM markets').get().n;
if (!count) {
  db.prepare('INSERT INTO markets (title, description, unit, status, closes_at, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    process.env.MARKET_TITLE || 'What will Anthropic’s share price be?',
    process.env.MARKET_DESCRIPTION || 'Enter your estimate in US dollars. This is a free community prediction survey, not a financial product or a real-money market. The market administrator should publish the event and resolution date before treating predictions as a forecast.',
    'USD', 'open', process.env.MARKET_CLOSES_AT || null, Date.now()
  );
}
const hash = (s) => createHash('sha256').update(String(s)).digest('hex');
const makeCode = () => randomBytes(5).toString('hex').toUpperCase().slice(0, 8);
const clean = (v, max) => String(v ?? '').replace(/[\\u0000-\\u001f\\u007f]/g, ' ').trim().slice(0, max);
const hits = new Map();
function limited(ip) {
  const now = Date.now(), windowMs = 5 * 60 * 1000;
  const recent = (hits.get(ip) || []).filter(t => now - t < windowMs);
  recent.push(now); hits.set(ip, recent);
  if (hits.size > 5000) hits.clear();
  return recent.length > 10;
}
function send(res, status, data) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}
function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', chunk => { size += chunk.length; if (size > 16 * 1024) { reject(new Error('Request too large')); req.destroy(); } else chunks.push(chunk); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}
function marketPayload() {
  const market = db.prepare('SELECT * FROM markets ORDER BY id DESC LIMIT 1').get();
  const rows = db.prepare('SELECT id, name, value, comment, created_at FROM predictions WHERE market_id = ? ORDER BY created_at DESC').all(market.id);
  const values = rows.map(r => Number(r.value)).sort((a,b) => a-b);
  const mean = values.length ? values.reduce((a,b)=>a+b,0) / values.length : null;
  const median = values.length ? (values.length % 2 ? values[(values.length-1)/2] : (values[values.length/2-1] + values[values.length/2]) / 2) : null;
  return { market, stats: { count: values.length, mean, median, min: values[0] ?? null, max: values.at(-1) ?? null }, predictions: rows.map(({id,name,value,comment,created_at})=>({id,name,value:Number(value),comment,created_at:Number(created_at)})) };
}
const server = createServer(async (req,res) => {
  const url = new URL(req.url, 'http://localhost');
  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
  try {
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(html);
    }
    if (req.method === 'GET' && url.pathname === '/api/market') return send(res,200,marketPayload());
    if (req.method === 'GET' && url.pathname === '/healthz') return send(res,200,{ok:true,db:'sqlite'});
    if (req.method === 'POST' && url.pathname === '/api/predictions') {
      if (limited(ip)) return send(res,429,{error:'Too many submissions. Please try again later.'});
      const body = await readJson(req);
      const name = clean(body.name,40) || 'Anonymous';
      const comment = clean(body.comment,240);
      const value = Number(body.value);
      if (!Number.isFinite(value) || value <= 0 || value > 1000000) return send(res,400,{error:'Enter a price greater than $0 and no more than $1,000,000.'});
      const market = db.prepare('SELECT id,status FROM markets ORDER BY id DESC LIMIT 1').get();
      if (!market || market.status !== 'open') return send(res,409,{error:'This prediction market is closed.'});
      const code = makeCode();
      const result = db.prepare('INSERT INTO predictions (market_id,name,value,comment,delete_hash,created_at) VALUES (?,?,?,?,?,?)').run(market.id,name,value,comment,hash(code),Date.now());
      return send(res,201,{id:Number(result.lastInsertRowid),delete_code:code});
    }
    const del = url.pathname.match(/^\\/api\\/predictions\\/(\\d+)$/);
    if (req.method === 'DELETE' && del) {
      const row = db.prepare('SELECT id,delete_hash FROM predictions WHERE id=?').get(Number(del[1]));
      if (!row) return send(res,404,{error:'Prediction not found.'});
      const supplied = hash(String(req.headers['x-delete-code'] || '').toUpperCase());
      const a = Buffer.from(supplied), b = Buffer.from(row.delete_hash);
      if (a.length !== b.length || !timingSafeEqual(a,b)) return send(res,403,{error:'Incorrect delete code.'});
      db.prepare('DELETE FROM predictions WHERE id=?').run(row.id);
      return send(res,200,{ok:true});
    }
    return send(res,404,{error:'Not found.'});
  } catch (error) { console.error(error); return send(res,400,{error:'Request could not be processed.'}); }
});
const port = Number(process.env.PORT || 8790);
server.listen(port,'0.0.0.0',()=>console.log(`Anthropic Price Predictions listening on ${port}`));
