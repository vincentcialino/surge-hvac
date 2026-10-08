import 'dotenv/config';
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer } from 'ws';
import pg from 'pg';
import path from 'path';
import { fileURLToPath } from 'url';

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

if (!process.env.DATABASE_URL) {
  console.error('\n❌  DATABASE_URL not set.');
  console.error('   Copy .env.example → .env and add your Postgres URL.\n');
  process.exit(1);
}

// ── DATABASE ──────────────────────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('localhost')
    ? false
    : { rejectUnauthorized: false },
});

async function q(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows;
}
async function q1(sql, params = []) {
  const { rows } = await pool.query(sql, params);
  return rows[0] || null;
}

// Create tables
await pool.query(`
  CREATE TABLE IF NOT EXISTS leads (
    id         SERIAL PRIMARY KEY,
    name       TEXT NOT NULL,
    phone      TEXT DEFAULT '',
    email      TEXT DEFAULT '',
    service    TEXT DEFAULT 'General HVAC',
    area       TEXT DEFAULT '',
    zip        TEXT DEFAULT '',
    source     TEXT DEFAULT 'Web Form',
    intent     INTEGER DEFAULT 75,
    status     TEXT DEFAULT 'new',
    notes      TEXT DEFAULT '',
    value      INTEGER DEFAULT 0,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE IF NOT EXISTS campaigns (
    id       SERIAL PRIMARY KEY,
    name     TEXT,
    platform TEXT,
    status   TEXT DEFAULT 'active',
    budget   REAL DEFAULT 0,
    spend    REAL DEFAULT 0,
    leads    INTEGER DEFAULT 0,
    cpl      REAL DEFAULT 0,
    ctr      REAL DEFAULT 0
  );
`);

// Seed campaigns if empty
const { count } = await q1('SELECT COUNT(*)::int as count FROM campaigns');
if (count === 0) {
  await pool.query(`
    INSERT INTO campaigns (name, platform, status, budget) VALUES
    ('Google LSA — Dallas Metro',    'Google LSA',    'active', 1200),
    ('Google Search — HVAC Repair',  'Google Search', 'active', 800),
    ('Meta — Homeowner Targeting',   'Meta Ads',      'active', 600),
    ('Retargeting — Site Visitors',  'Retargeting',   'paused', 300)
  `);
}

// ── WEBSOCKET ─────────────────────────────────────────────────────
const app = express();
const server = createServer(app);
const wss = new WebSocketServer({ server });

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data });
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}

wss.on('connection', ws => {
  ws.send(JSON.stringify({ type: 'connected', data: {} }));
});

// ── MIDDLEWARE ────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(__dirname));

// ── LEADS API ─────────────────────────────────────────────────────

app.get('/api/leads', async (req, res) => {
  const { status, source, search, limit = 200 } = req.query;
  let sql = 'SELECT * FROM leads WHERE 1=1';
  const params = [];

  if (status && status !== 'all') {
    params.push(status);
    sql += ` AND status = $${params.length}`;
  }
  if (source) {
    params.push(source);
    sql += ` AND source = $${params.length}`;
  }
  if (search) {
    params.push(`%${search}%`);
    sql += ` AND (name ILIKE $${params.length} OR area ILIKE $${params.length} OR service ILIKE $${params.length})`;
  }
  params.push(parseInt(limit));
  sql += ` ORDER BY created_at DESC LIMIT $${params.length}`;

  res.json(await q(sql, params));
});

app.get('/api/leads/stats', async (req, res) => {
  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

  const [total, today, newCount, intent, pipeline, monthly] = await Promise.all([
    q1('SELECT COUNT(*)::int as n FROM leads'),
    q1('SELECT COUNT(*)::int as n FROM leads WHERE created_at >= $1', [todayStart]),
    q1("SELECT COUNT(*)::int as n FROM leads WHERE status = 'new'"),
    q1('SELECT COALESCE(AVG(intent),0)::int as n FROM leads'),
    q1("SELECT COALESCE(SUM(value),0)::int as n FROM leads WHERE status IN ('new','contacted','booked')"),
    q1('SELECT COUNT(*)::int as n FROM leads WHERE created_at >= $1', [monthStart]),
  ]);

  res.json({
    total: total.n, today: today.n, newCount: newCount.n,
    avgIntent: intent.n, pipeline: pipeline.n, monthly: monthly.n,
  });
});

app.get('/api/leads/daily', async (req, res) => {
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const rows = await q(`
    SELECT created_at::date::text AS day, COUNT(*)::int AS count
    FROM leads WHERE created_at >= $1
    GROUP BY day ORDER BY day ASC
  `, [cutoff]);
  res.json(rows);
});

app.get('/api/leads/trend', async (req, res) => {
  const days = parseInt(req.query.days) || 30;
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  const rows = await q(`
    SELECT created_at::date::text AS day, COUNT(*)::int AS count
    FROM leads WHERE created_at >= $1
    GROUP BY day ORDER BY day ASC
  `, [cutoff]);
  res.json(rows);
});

app.post('/api/leads', async (req, res) => {
  const { name, phone, email, service, area, zip, source, intent, notes, value } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });

  const intentScore = parseInt(intent) || calcIntent(service, source);
  const estValue    = parseInt(value)  || estimateValue(service);

  const lead = await q1(`
    INSERT INTO leads (name, phone, email, service, area, zip, source, intent, notes, value)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
    RETURNING *
  `, [name, phone||'', email||'', service||'General HVAC', area||'', zip||'', source||'Web Form', intentScore, notes||'', estValue]);

  // Bump campaign lead count
  const camp = await q1("SELECT id FROM campaigns WHERE platform = $1 AND status = 'active' LIMIT 1", [source]);
  if (camp) await pool.query('UPDATE campaigns SET leads = leads + 1 WHERE id = $1', [camp.id]);

  broadcast('new_lead', lead);
  res.status(201).json(lead);
});

app.patch('/api/leads/:id', async (req, res) => {
  const { status, notes } = req.body;
  const id = parseInt(req.params.id);
  if (status) await pool.query('UPDATE leads SET status = $1 WHERE id = $2', [status, id]);
  if (notes !== undefined) await pool.query('UPDATE leads SET notes = $1 WHERE id = $2', [notes, id]);
  const updated = await q1('SELECT * FROM leads WHERE id = $1', [id]);
  if (!updated) return res.status(404).json({ error: 'not found' });
  broadcast('lead_updated', updated);
  res.json(updated);
});

app.delete('/api/leads/:id', async (req, res) => {
  const id = parseInt(req.params.id);
  await pool.query('DELETE FROM leads WHERE id = $1', [id]);
  broadcast('lead_deleted', { id });
  res.json({ ok: true });
});

// ── CAMPAIGNS API ─────────────────────────────────────────────────

app.get('/api/campaigns', async (req, res) => {
  res.json(await q('SELECT * FROM campaigns ORDER BY id'));
});

app.patch('/api/campaigns/:id', async (req, res) => {
  const { status, budget, spend } = req.body;
  const id = parseInt(req.params.id);
  if (status) await pool.query('UPDATE campaigns SET status = $1 WHERE id = $2', [status, id]);
  if (budget !== undefined) await pool.query('UPDATE campaigns SET budget = $1 WHERE id = $2', [budget, id]);
  if (spend  !== undefined) await pool.query('UPDATE campaigns SET spend  = $1 WHERE id = $2', [spend,  id]);
  res.json(await q1('SELECT * FROM campaigns WHERE id = $1', [id]));
});

// ── HELPERS ───────────────────────────────────────────────────────

function calcIntent(service, source) {
  let s = 70;
  if (service && /emergency|repair/i.test(service)) s += 20;
  if (service && /install|replace/i.test(service)) s += 10;
  if (source === 'Google LSA')    s += 8;
  if (source === 'Google Search') s += 5;
  return Math.min(s + Math.floor(Math.random() * 8), 99);
}

function estimateValue(service) {
  const map = {
    'Emergency AC': 500, 'AC Repair': 380, 'AC Install': 4200,
    'Heater Repair': 300, 'Heater Install': 3100, 'Full System Replace': 9000,
    'Mini-Split Install': 2100, 'Duct Cleaning': 380, 'Maintenance': 150,
  };
  return map[service] || 400;
}

// ── ROUTES ────────────────────────────────────────────────────────
app.get('/',          (_, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/dashboard', (_, res) => res.sendFile(path.join(__dirname, 'dashboard.html')));
app.get('/intake',    (_, res) => res.sendFile(path.join(__dirname, 'intake.html')));

// ── START ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`\n🔥 SURGE running at http://localhost:${PORT}`);
  console.log(`   Dashboard → http://localhost:${PORT}/dashboard`);
  console.log(`   Intake    → http://localhost:${PORT}/intake`);
  console.log(`   API       → http://localhost:${PORT}/api/leads\n`);
});
