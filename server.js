const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const nodemailer = require('nodemailer');
const { google } = require('googleapis');
const { ImapFlow } = require('imapflow');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const HTML_PATH = path.join(__dirname, 'Creed_Jax_Dashboard.html');

const SHEET_ID = process.env.ORG_SHEET_ID || '';
const GMAIL_ADDRESS = process.env.ORG_GMAIL_ADDRESS || '';
const GMAIL_APP_PASSWORD = (process.env.ORG_GMAIL_APP_PASSWORD || '').replace(/\s+/g, '');
const REPLY_TO = process.env.REPLY_TO || 'Jax@usecreed.com';
const IMAP_HOST = process.env.IMAP_HOST || 'imap.gmail.com';
const FOLLOWUP_DAYS = Number.parseInt(process.env.FOLLOWUP_DAYS || '5', 10);
const CACHE_TTL_MS = Number.parseInt(process.env.CACHE_TTL_MS || '60000', 10);
const BULK_CAP = Number.parseInt(process.env.BULK_CAP || '50', 10);
const BULK_DELAY_MS = Number.parseInt(process.env.BULK_DELAY_MS || '1500', 10);

// pipeline -> sheet tab
const TABS = { churches: 'Churches', brands: 'Brands', top: 'Top Churches' };
// Legacy fallback if migration hasn't run yet.
const FALLBACK_TAB = process.env.FALLBACK_TAB || 'Week1';

// Canonical column names the dashboard reads/writes. Missing columns degrade gracefully.
const COLS = {
  org: 'Org Name',
  person: 'Person Name',
  position: 'Person Position',
  email: 'Email/Website',
  reachOut: 'Reach Out Date',
  followStatus: 'Follow Up Status',
  emailFound: 'Email Found',
  bounced: 'Bounced',
  type: 'Type',
  area: 'Area',
  replied: 'Replied',
  replyDate: 'Reply Date',
  lastFollowUp: 'Last Follow Up Date',
  followCount: 'Follow Up Count',
  nextFollowUp: 'Next Follow Up Due',
  notes: 'Notes',
  userCount: 'User Count',
};

// ── Placeholder follow-up templates (EDIT COPY LATER) ────────────────────────
// Intentionally generic stand-ins until real follow-up copy is set.
const FOLLOWUP_TEMPLATES = {
  churches: [
    {
      id: 'church-1',
      label: 'Follow-up 1',
      subject: 'Follow-Up with Creed Bible App',
      body:
        'Hi {person},\n\n' +
        'Circling back on my earlier note about Creed and {org}. ' +
        'My name is Jax, and I lead church partnerships for Creed (https://usecreed.com), ' +
        'a free Bible app built to help churches attract new congregants, retain the ones they have, ' +
        'and open up new revenue streams, all at no cost to your church.\n\n' +
        'Many of your members are very likely already using Creed as part of their daily walk with God, ' +
        'and we would love to help you reach and disciple them directly through the app. ' +
        'It is a simple way to stay connected with your congregation between Sundays and keep your people in the Word all week long.\n\n' +
        'Would you be open to a quick call this week or next? I would love to understand your current pain points, ' +
        'show you how our products work, and see how we can start adding value to {org}.\n\n' +
        'God Bless,\nJax\nCreed Labs\nJax@usecreed.com',
    },
  ],
  brands: [
    {
      id: 'brand-1',
      label: 'Follow-up 1 (placeholder)',
      subject: 'Following up - Creed x {org}',
      body:
        'Hi {person},\n\n' +
        'Wanted to follow up on my earlier note about a possible Creed and {org} collaboration. ' +
        'Happy to share more whenever the timing works.\n\n' +
        'Would you be open to a quick call?\n\n' +
        'Happy creating,\nJax J\nJax@usecreed.com\n\n' +
        '[PLACEHOLDER COPY - update before real sends]',
    },
  ],
  top: [
    {
      id: 'top-1',
      label: 'Follow-up 1 (placeholder)',
      subject: 'Following up - Creed for {org}',
      body:
        'Hi {person},\n\n' +
        'Following up on Creed for {org}. Would love to get a quick call on the books.\n\n' +
        'Happy creating,\nJax J\nJax@usecreed.com\n\n' +
        '[PLACEHOLDER COPY - update before real sends]',
    },
  ],
};

// ── Google Sheets client ─────────────────────────────────────────────────────

function loadServiceAccount() {
  if (process.env.GOOGLE_SA_JSON_B64) {
    return JSON.parse(Buffer.from(process.env.GOOGLE_SA_JSON_B64, 'base64').toString('utf8'));
  }
  if (process.env.GOOGLE_SA_JSON) {
    return JSON.parse(process.env.GOOGLE_SA_JSON);
  }
  const localPath = process.env.GOOGLE_SA_FILE || '/config/creed-sheets-creds.json';
  if (fs.existsSync(localPath)) return JSON.parse(fs.readFileSync(localPath, 'utf8'));
  throw new Error('No Google service account credentials (set GOOGLE_SA_JSON_B64).');
}

let _sheetsClient = null;
function sheetsClient() {
  if (_sheetsClient) return _sheetsClient;
  const sa = loadServiceAccount();
  const auth = new google.auth.JWT(
    sa.client_email, null, sa.private_key,
    ['https://www.googleapis.com/auth/spreadsheets'],
  );
  _sheetsClient = google.sheets({ version: 'v4', auth });
  return _sheetsClient;
}

function colLetter(n) {
  let s = '';
  n += 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ── In-memory cache per tab ──────────────────────────────────────────────────

const cache = {}; // tabName -> { header, rows: [{_row, values:{}}], fetchedAt }

async function fetchTab(tabName) {
  const sheets = sheetsClient();
  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: SHEET_ID,
    range: `${tabName}`,
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const values = resp.data.values || [];
  const header = values[0] || [];
  const orgIdx = header.indexOf(COLS.org);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const raw = values[i];
    const org = orgIdx >= 0 ? raw[orgIdx] : raw[0];
    if (!org || !String(org).trim()) continue;
    const obj = {};
    header.forEach((h, idx) => { obj[h] = raw[idx] !== undefined ? raw[idx] : ''; });
    rows.push({ _row: i + 1, values: obj }); // _row = 1-based sheet row number
  }
  return { header, rows, fetchedAt: Date.now() };
}

async function getTab(tabName, force = false) {
  const c = cache[tabName];
  if (!force && c && (Date.now() - c.fetchedAt) < CACHE_TTL_MS) return c;
  const fresh = await fetchTab(tabName);
  cache[tabName] = fresh;
  return fresh;
}

function tabForPipeline(pipeline) {
  return TABS[pipeline] || TABS.churches;
}

async function getPipelineTab(pipeline, force = false) {
  const tab = tabForPipeline(pipeline);
  try {
    return { tab, data: await getTab(tab, force) };
  } catch (err) {
    if (pipeline === 'churches') {
      const data = await getTab(FALLBACK_TAB, force);
      return { tab: FALLBACK_TAB, data };
    }
    throw err;
  }
}

// ── Status + filtering ───────────────────────────────────────────────────────

function truthy(v) {
  return ['yes', 'true', '1', 'replied', 'bounced'].includes(String(v || '').trim().toLowerCase());
}

function daysSince(dateStr) {
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return null;
  return Math.floor((Date.now() - t) / 86400000);
}

function deriveStatus(v) {
  if (truthy(v[COLS.bounced])) return 'bounced';
  if (truthy(v[COLS.replied])) return 'replied';
  const reach = v[COLS.reachOut];
  const followStatus = String(v[COLS.followStatus] || '').toLowerCase();
  const contacted = (reach && String(reach).trim()) || followStatus.includes('email');
  if (!contacted) return 'not_contacted';
  const lastTouch = v[COLS.lastFollowUp] || v[COLS.reachOut];
  const d = daysSince(lastTouch);
  if (d !== null && d >= FOLLOWUP_DAYS) return 'needs_followup';
  return 'emailed';
}

function shapeRow(r) {
  const v = r.values;
  return {
    rowId: r._row,
    org: v[COLS.org] || '',
    person: v[COLS.person] || '',
    position: v[COLS.position] || '',
    email: v[COLS.email] || '',
    area: v[COLS.area] || '',
    type: v[COLS.type] || '',
    reachOut: v[COLS.reachOut] || '',
    followStatus: v[COLS.followStatus] || '',
    replied: truthy(v[COLS.replied]),
    replyDate: v[COLS.replyDate] || '',
    lastFollowUp: v[COLS.lastFollowUp] || '',
    followCount: Number.parseInt(v[COLS.followCount] || '0', 10) || 0,
    nextFollowUp: v[COLS.nextFollowUp] || '',
    bounced: truthy(v[COLS.bounced]),
    notes: v[COLS.notes] || '',
    userCount: v[COLS.userCount] !== undefined ? v[COLS.userCount] : '',
    status: deriveStatus(v),
  };
}

function applyFilters(rows, { area, status, q }) {
  let out = rows.map(shapeRow);
  if (area) {
    const a = area.toLowerCase();
    out = out.filter(r => r.area.toLowerCase().includes(a));
  }
  if (status) out = out.filter(r => r.status === status);
  if (q) {
    const needle = q.toLowerCase();
    out = out.filter(r =>
      r.org.toLowerCase().includes(needle) ||
      r.person.toLowerCase().includes(needle) ||
      r.email.toLowerCase().includes(needle) ||
      r.area.toLowerCase().includes(needle));
  }
  return out;
}

// ── Sheet writes ─────────────────────────────────────────────────────────────

async function writeCells(tab, rowNumber, updates) {
  const data = cache[tab];
  if (!data) throw new Error('tab not cached');
  const sheets = sheetsClient();
  const requests = [];
  for (const [col, value] of Object.entries(updates)) {
    const idx = data.header.indexOf(col);
    if (idx < 0) continue; // column missing in this tab; skip silently
    requests.push({ range: `${tab}!${colLetter(idx)}${rowNumber}`, values: [[value]] });
  }
  if (!requests.length) return;
  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SHEET_ID,
    requestBody: { valueInputOption: 'USER_ENTERED', data: requests },
  });
  const row = data.rows.find(r => r._row === rowNumber);
  if (row) Object.assign(row.values, updates);
}

// Append a brand new contact row to a pipeline tab, mapped onto the tab header.
async function appendRow(tab, fields) {
  const data = await getTab(tab, true); // refresh so we have the live header
  const header = data.header;
  if (!header.length) throw new Error('sheet header missing');
  const row = header.map(col => {
    const v = fields[col];
    return v === undefined || v === null ? '' : String(v);
  });
  const sheets = sheetsClient();
  await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: tab,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: [row] },
  });
  await getTab(tab, true); // refresh cache so the new row shows immediately
  return { org: fields[COLS.org] || '' };
}

// ── Email send / reply scan ──────────────────────────────────────────────────

function mailer() {
  if (!GMAIL_ADDRESS || !GMAIL_APP_PASSWORD) {
    throw new Error('Gmail is not configured (set ORG_GMAIL_ADDRESS + ORG_GMAIL_APP_PASSWORD).');
  }
  return nodemailer.createTransport({
    host: 'smtp.gmail.com', port: 465, secure: true,
    auth: { user: GMAIL_ADDRESS, pass: GMAIL_APP_PASSWORD },
  });
}

function fillTemplate(str, row) {
  return String(str || '')
    .replace(/\{org\}/g, row.org || 'there')
    .replace(/\{person\}/g, row.person || 'there');
}

async function sendFollowUp(pipeline, tab, rowNumber, templateId, customSubject, customBody, testTo) {
  const data = cache[tab] || await getTab(tab);
  const r = data.rows.find(x => x._row === rowNumber);
  if (!r) throw new Error('row not found');
  const shaped = shapeRow(r);
  const realTo = String(shaped.email || '').trim();
  const test = String(testTo || '').trim();
  const to = test || realTo;
  if (!to || !to.includes('@')) throw new Error(`no valid email for ${shaped.org}`);

  const templates = FOLLOWUP_TEMPLATES[pipeline] || FOLLOWUP_TEMPLATES.churches;
  const tpl = templates.find(t => t.id === templateId) || templates[0];
  const subject = (test ? '[TEST] ' : '') + (customSubject || fillTemplate(tpl.subject, shaped));
  const body = customBody || fillTemplate(tpl.body, shaped);

  await mailer().sendMail({ from: GMAIL_ADDRESS, to, replyTo: REPLY_TO, subject, text: body });

  // Test sends go to your own inbox: never write to the sheet or bump the count.
  if (test) return { org: shaped.org, to, subject, test: true };

  const today = new Date().toISOString().slice(0, 10);
  const next = new Date(Date.now() + FOLLOWUP_DAYS * 86400000).toISOString().slice(0, 10);
  await writeCells(tab, rowNumber, {
    [COLS.lastFollowUp]: today,
    [COLS.followCount]: (shaped.followCount || 0) + 1,
    [COLS.nextFollowUp]: next,
    [COLS.followStatus]: `Followed up ${today}`,
  });
  return { org: shaped.org, to, subject };
}

// Manually mark a row as followed up: no email, no Follow Up Count increment.
// Records today's date so the row leaves the "needs follow-up" queue.
async function markFollowedUp(tab, rowNumber) {
  const data = cache[tab] || await getTab(tab);
  const r = data.rows.find(x => x._row === rowNumber);
  if (!r) throw new Error('row not found');
  const shaped = shapeRow(r);
  const today = new Date().toISOString().slice(0, 10);
  const next = new Date(Date.now() + FOLLOWUP_DAYS * 86400000).toISOString().slice(0, 10);
  await writeCells(tab, rowNumber, {
    [COLS.lastFollowUp]: today,
    [COLS.nextFollowUp]: next,
    [COLS.followStatus]: `Marked followed up ${today}`,
  });
  return { org: shaped.org, markedAt: today };
}

async function scanReplies(pipelines, sinceDays = 30) {
  if (!GMAIL_ADDRESS || !GMAIL_APP_PASSWORD) throw new Error('Gmail is not configured.');
  const index = new Map(); // email -> {pipeline, tab, rowNumber, org}
  for (const p of pipelines) {
    const { tab, data } = await getPipelineTab(p, true);
    for (const r of data.rows) {
      const email = String(r.values[COLS.email] || '').trim().toLowerCase();
      if (email && email.includes('@')) {
        index.set(email, { pipeline: p, tab, rowNumber: r._row, org: r.values[COLS.org] });
      }
    }
  }

  const client = new ImapFlow({
    host: IMAP_HOST, port: 993, secure: true,
    auth: { user: GMAIL_ADDRESS, pass: GMAIL_APP_PASSWORD }, logger: false,
  });
  const matched = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock('INBOX');
    try {
      const since = new Date(Date.now() - sinceDays * 86400000);
      for await (const msg of client.fetch({ since }, { envelope: true, source: true })) {
        const from = msg.envelope?.from?.[0]?.address?.toLowerCase() || '';
        if (!from || !index.has(from)) continue;
        const hit = index.get(from);
        const subject = msg.envelope?.subject || '';
        const snippet = (msg.source ? msg.source.toString('utf8') : '').replace(/=\r?\n/g, '').slice(0, 400);
        matched.push({ ...hit, from, subject, snippet, date: msg.envelope?.date });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => {});
  }

  const seen = new Set();
  for (const m of matched) {
    const key = `${m.tab}:${m.rowNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const today = (m.date ? new Date(m.date) : new Date()).toISOString().slice(0, 10);
    await writeCells(m.tab, m.rowNumber, { [COLS.replied]: 'Yes', [COLS.replyDate]: today });
  }
  return { scanned: index.size, matched };
}

// ── HTTP helpers ─────────────────────────────────────────────────────────────

function sendJson(res, code, payload) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(payload));
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', c => { body += c; if (body.length > 5 * 1024 * 1024) { reject(new Error('body too large')); req.destroy(); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function sendHtml(res) {
  fs.readFile(HTML_PATH, (err, content) => {
    if (err) return sendJson(res, 500, { error: 'Unable to load dashboard HTML.' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(content);
  });
}

function pipelineOf(url) {
  const p = (url.searchParams.get('pipeline') || 'churches').toLowerCase();
  return TABS[p] ? p : 'churches';
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);
  const { pathname } = url;

  try {
    if (req.method === 'GET' && pathname === '/health') return sendJson(res, 200, { ok: true });

    if (req.method === 'GET' && pathname === '/api/config') {
      return sendJson(res, 200, {
        sheetConfigured: !!SHEET_ID,
        gmailConfigured: !!(GMAIL_ADDRESS && GMAIL_APP_PASSWORD),
        followUpDays: FOLLOWUP_DAYS,
        pipelines: Object.keys(TABS),
      });
    }

    if (req.method === 'GET' && pathname === '/api/templates') {
      return sendJson(res, 200, FOLLOWUP_TEMPLATES);
    }

    if (req.method === 'GET' && pathname === '/api/orgs') {
      const pipeline = pipelineOf(url);
      const force = url.searchParams.get('refresh') === '1';
      const { data } = await getPipelineTab(pipeline, force);
      let filtered = applyFilters(data.rows, {
        area: url.searchParams.get('area') || '',
        status: url.searchParams.get('status') || '',
        q: url.searchParams.get('q') || '',
      });
      const sortBy = url.searchParams.get('sort');
      if (sortBy === 'userCount') {
        filtered.sort((a, b) => (Number(b.userCount) || 0) - (Number(a.userCount) || 0));
      } else {
        filtered.sort((a, b) => a.org.localeCompare(b.org));
      }
      const total = filtered.length;
      const page = Math.max(1, Number.parseInt(url.searchParams.get('page') || '1', 10));
      const pageSize = Math.min(500, Math.max(10, Number.parseInt(url.searchParams.get('pageSize') || '100', 10)));
      const start = (page - 1) * pageSize;
      return sendJson(res, 200, {
        pipeline, total, page, pageSize,
        fetchedAt: data.fetchedAt,
        rows: filtered.slice(start, start + pageSize),
      });
    }

    if (req.method === 'GET' && pathname === '/api/areas') {
      const pipeline = pipelineOf(url);
      const { data } = await getPipelineTab(pipeline);
      const set = new Map();
      data.rows.forEach(r => {
        const a = String(r.values[COLS.area] || '').trim();
        if (a) set.set(a, (set.get(a) || 0) + 1);
      });
      const areas = [...set.entries()].sort((x, y) => y[1] - x[1]).map(([area, count]) => ({ area, count }));
      return sendJson(res, 200, { areas });
    }

    if (req.method === 'GET' && pathname === '/api/stats') {
      const pipeline = pipelineOf(url);
      const { data } = await getPipelineTab(pipeline);
      const all = data.rows.map(shapeRow);
      const stats = { total: all.length, not_contacted: 0, emailed: 0, replied: 0, bounced: 0, needs_followup: 0 };
      all.forEach(r => { stats[r.status] = (stats[r.status] || 0) + 1; });
      if (pipeline === 'top') stats.totalUsers = all.reduce((s, r) => s + (Number(r.userCount) || 0), 0);
      return sendJson(res, 200, stats);
    }

    if (req.method === 'POST' && pathname === '/api/sync') {
      const body = JSON.parse((await collectBody(req)) || '{}');
      const pipeline = (body.pipeline && TABS[body.pipeline]) ? body.pipeline : null;
      const targets = pipeline ? [pipeline] : Object.keys(TABS);
      const result = {};
      for (const p of targets) {
        try { const { data } = await getPipelineTab(p, true); result[p] = data.rows.length; }
        catch (e) { result[p] = `error: ${e.message}`; }
      }
      return sendJson(res, 200, { ok: true, counts: result });
    }

    if (req.method === 'PATCH' && pathname.startsWith('/api/orgs/')) {
      const rowNumber = Number.parseInt(pathname.split('/').pop(), 10);
      const body = JSON.parse((await collectBody(req)) || '{}');
      const pipeline = pipelineOf(url);
      const { tab } = await getPipelineTab(pipeline);
      const map = {
        org: COLS.org, person: COLS.person, position: COLS.position, email: COLS.email,
        reachOut: COLS.reachOut, notes: COLS.notes, followStatus: COLS.followStatus, area: COLS.area,
        userCount: COLS.userCount, bounced: COLS.bounced, replied: COLS.replied, type: COLS.type,
      };
      const allowed = {};
      for (const [k, col] of Object.entries(map)) if (k in body) allowed[col] = body[k];
      await writeCells(tab, rowNumber, allowed);
      return sendJson(res, 200, { ok: true, updated: Object.keys(allowed) });
    }

    if (req.method === 'POST' && pathname === '/api/follow-up') {
      const body = JSON.parse((await collectBody(req)) || '{}');
      const pipeline = (body.pipeline && TABS[body.pipeline]) ? body.pipeline : 'churches';
      const { tab } = await getPipelineTab(pipeline);
      const result = await sendFollowUp(pipeline, tab, Number.parseInt(body.rowId, 10), body.templateId, body.subject, body.body, body.testTo);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'POST' && pathname === '/api/orgs') {
      const body = JSON.parse((await collectBody(req)) || '{}');
      const pipeline = (body.pipeline && TABS[body.pipeline]) ? body.pipeline : 'churches';
      const org = String(body.org || '').trim();
      if (!org) return sendJson(res, 400, { error: 'Org name is required.' });
      const { tab } = await getPipelineTab(pipeline);
      const today = new Date().toISOString().slice(0, 10);
      const fields = {
        [COLS.org]: org,
        [COLS.person]: String(body.person || '').trim(),
        [COLS.position]: String(body.position || '').trim(),
        [COLS.email]: String(body.email || '').trim(),
        [COLS.area]: String(body.area || body.city || '').trim(),
        [COLS.type]: String(body.type || (pipeline === 'brands' ? 'Brand' : 'Church')).trim(),
        [COLS.notes]: String(body.notes || '').trim(),
        [COLS.followStatus]: 'Not contacted',
        [COLS.reachOut]: typeof body.reachOut === 'string' ? body.reachOut.trim()
          : (body.reachOut ? today : ''),
      };
      if (pipeline === 'top' && body.userCount !== undefined && body.userCount !== '') {
        fields[COLS.userCount] = body.userCount;
      }
      const result = await appendRow(tab, fields);
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'POST' && pathname === '/api/mark-followed-up') {
      const body = JSON.parse((await collectBody(req)) || '{}');
      const pipeline = (body.pipeline && TABS[body.pipeline]) ? body.pipeline : 'churches';
      const { tab } = await getPipelineTab(pipeline);
      const result = await markFollowedUp(tab, Number.parseInt(body.rowId, 10));
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'POST' && pathname === '/api/follow-up/bulk') {
      const body = JSON.parse((await collectBody(req)) || '{}');
      const pipeline = (body.pipeline && TABS[body.pipeline]) ? body.pipeline : 'churches';
      const { tab } = await getPipelineTab(pipeline);
      const rowIds = (Array.isArray(body.rowIds) ? body.rowIds : []).slice(0, BULK_CAP).map(n => Number.parseInt(n, 10));
      const sent = [], failed = [];
      for (const rowId of rowIds) {
        try { sent.push(await sendFollowUp(pipeline, tab, rowId, body.templateId, body.subject, body.body)); }
        catch (e) { failed.push({ rowId, error: e.message }); }
        await new Promise(r => setTimeout(r, BULK_DELAY_MS));
      }
      return sendJson(res, 200, { ok: true, sent, failed, cap: BULK_CAP });
    }

    if (req.method === 'POST' && pathname === '/api/replies/scan') {
      const body = JSON.parse((await collectBody(req)) || '{}');
      const pipelines = Array.isArray(body.pipelines) && body.pipelines.length
        ? body.pipelines.filter(p => TABS[p]) : Object.keys(TABS);
      const result = await scanReplies(pipelines, Number.parseInt(body.sinceDays || '30', 10));
      return sendJson(res, 200, { ok: true, ...result });
    }

    if (req.method === 'GET' && (pathname === '/' || pathname === '/index.html' || pathname === '/Creed_Jax_Dashboard.html')) {
      return sendHtml(res);
    }

    return sendJson(res, 404, { error: 'Not found.' });
  } catch (err) {
    return sendJson(res, 500, { error: err.message || 'Server error.' });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`Creed CRM dashboard running at http://${HOST}:${PORT}`);
  console.log(`  Sheet: ${SHEET_ID ? 'configured' : 'MISSING ORG_SHEET_ID'} | Gmail: ${GMAIL_ADDRESS || 'not configured'}`);
});
