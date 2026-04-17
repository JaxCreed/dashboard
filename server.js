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

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/Creed_Jax_Dashboard.html')) {
    sendHtml(res);
    return;
  }

  sendJson(res, 404, { error: 'Not found.' });
});

server.listen(PORT, HOST, () => {
  console.log(`Jax Dashboard running at http://${HOST}:${PORT}`);
});
