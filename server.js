const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT_DIR = __dirname;
const HTML_PATH = path.join(ROOT_DIR, 'Creed_Jax_Dashboard.html');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT_DIR;
const STATE_PATH = path.join(DATA_DIR, 'dashboard-state.json');
const EMPTY_STATE = {
  version: 1,
  updatedAt: '',
  tasks: [],
  creators: [],
  partners: [],
  orgPartners: [],
  scripts: [],
};
const PUBLIC_CONFIG = {
  supabaseUrl: process.env.SUPABASE_URL || '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  supabaseTable: process.env.SUPABASE_TABLE || 'dashboard_state',
  workspaceId: process.env.SUPABASE_WORKSPACE_ID || 'main',
};
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
const CREATOR_RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    creators: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          platform: { type: 'string' },
          followers: { type: 'string' },
          sizeBucket: { type: 'string' },
          contentStyle: { type: 'string' },
          whyFit: { type: 'string' },
          engagementQuality: { type: 'string' },
          bestUseCase: { type: 'string' },
          suggestedFirstOutreachAngle: { type: 'string' },
          profileUrl: { type: 'string' },
          email: { type: 'string' },
          phone: { type: 'string' },
          notes: { type: 'string' },
        },
        required: [
          'name',
          'platform',
          'followers',
          'sizeBucket',
          'contentStyle',
          'whyFit',
          'engagementQuality',
          'bestUseCase',
          'suggestedFirstOutreachAngle',
          'profileUrl',
          'email',
          'phone',
          'notes',
        ],
      },
    },
  },
  required: ['summary', 'creators'],
};

function sanitizeState(state = {}) {
  return {
    version: 1,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : '',
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    creators: Array.isArray(state.creators) ? state.creators : [],
    partners: Array.isArray(state.partners) ? state.partners : [],
    orgPartners: Array.isArray(state.orgPartners) ? state.orgPartners : [],
    scripts: Array.isArray(state.scripts) ? state.scripts : [],
  };
}

function ensureStateFile() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STATE_PATH)) {
    const serialized = JSON.stringify(EMPTY_STATE, null, 2);
    fs.writeFileSync(STATE_PATH, serialized);
  }
}

function readState() {
  ensureStateFile();
  try {
    return sanitizeState(JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')));
  } catch (err) {
    return { ...EMPTY_STATE };
  }
}

function writeState(state) {
  ensureStateFile();
  const safeState = sanitizeState(state);
  safeState.updatedAt = new Date().toISOString();
  const tempPath = `${STATE_PATH}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(safeState, null, 2));
  fs.renameSync(tempPath, STATE_PATH);
  return safeState;
}

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendHtml(res) {
  fs.readFile(HTML_PATH, (err, content) => {
    if (err) {
      sendJson(res, 500, { error: 'Unable to load dashboard HTML.' });
      return;
    }
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(content);
  });
}

function collectBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 5 * 1024 * 1024) {
        reject(new Error('Request body too large.'));
        req.destroy();
      }
    });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

function buildCreatorResearchPrompt(options = {}) {
  const platforms = Array.isArray(options.platforms) && options.platforms.length ? options.platforms : ['TikTok', 'Instagram'];
  const sizeBuckets = Array.isArray(options.sizeBuckets) && options.sizeBuckets.length ? options.sizeBuckets : ['Small Creator', 'Medium Creator'];
  const limit = Math.min(Math.max(Number.parseInt(options.limit || 8, 10) || 8, 1), 20);
  const brief = String(options.brief || '').trim();
  const notes = String(options.notes || '').trim();

  return [
    'You are researching Christian creators for Creed, a Christian app.',
    'Use Google Search grounding to find real creators and return only creators you can reasonably verify from public web results.',
    `Target platforms: ${platforms.join(', ')}.`,
    `Target size buckets: ${sizeBuckets.join(', ')}.`,
    `Return up to ${limit} creators.`,
    'Prioritize creators with strong speaking-style or direct-to-camera videos, clear Christian/devotional/inspirational fit, clean brand safety, and strong potential for paid ad creative or outreach partnerships.',
    'If a field cannot be verified, return an empty string instead of guessing.',
    'Keep follower counts human-readable like "18,500".',
    'Suggested first outreach angles should feel short and natural for a first message.',
    brief ? `Extra guidance: ${brief}` : '',
    notes ? `Research notes: ${notes}` : '',
  ].filter(Boolean).join('\n');
}

function getResponseText(payload) {
  return payload?.candidates?.[0]?.content?.parts
    ?.map(part => part?.text || '')
    .join('')
    .trim() || '';
}

function extractGroundingSources(payload) {
  const chunks = payload?.candidates?.[0]?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];

  const unique = new Map();
  chunks.forEach(chunk => {
    const uri = chunk?.web?.uri || '';
    const title = chunk?.web?.title || '';
    if (!uri || unique.has(uri)) return;
    unique.set(uri, { uri, title });
  });
  return [...unique.values()];
}

async function runCreatorResearch(options = {}) {
  const body = {
    contents: [
      {
        parts: [
          { text: buildCreatorResearchPrompt(options) },
        ],
      },
    ],
    tools: [
      { google_search: {} },
    ],
    generationConfig: {
      responseMimeType: 'application/json',
      responseJsonSchema: CREATOR_RESEARCH_SCHEMA,
    },
  };

  const response = await fetch(GEMINI_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': GEMINI_API_KEY,
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || 'Gemini research request failed.';
    throw new Error(message);
  }

  const rawText = getResponseText(payload);
  if (!rawText) throw new Error('Gemini returned an empty creator research response.');

  let parsed;
  try {
    parsed = JSON.parse(rawText);
  } catch (err) {
    throw new Error('Gemini returned research, but it was not valid JSON.');
  }

  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    creators: Array.isArray(parsed.creators) ? parsed.creators : [],
    sources: extractGroundingSources(payload),
    model: GEMINI_MODEL,
  };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/public-config') {
    sendJson(res, 200, PUBLIC_CONFIG);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/state') {
    sendJson(res, 200, readState());
    return;
  }

  if (req.method === 'PUT' && url.pathname === '/api/state') {
    try {
      const body = await collectBody(req);
      const nextState = writeState(JSON.parse(body || '{}'));
      sendJson(res, 200, nextState);
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Unable to save dashboard state.' });
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/creator-research') {
    if (!GEMINI_API_KEY) {
      sendJson(res, 400, { error: 'Gemini is not configured yet. Add GEMINI_API_KEY on the server first.' });
      return;
    }

    try {
      const body = await collectBody(req);
      const options = JSON.parse(body || '{}');
      const result = await runCreatorResearch(options);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 502, { error: err.message || 'Unable to run Gemini creator research.' });
    }
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/Creed_Jax_Dashboard.html')) {
    sendHtml(res);
    return;
  }

  sendJson(res, 404, { error: 'Not found.' });
});

server.listen(PORT, HOST, () => {
  console.log(`Jax Dashboard running at http://${HOST}:${PORT}`);
});
