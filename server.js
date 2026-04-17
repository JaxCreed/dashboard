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
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
const GEMINI_API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`;
const LEAD_RESEARCH_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string' },
    leads: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          kind: { type: 'string' },
          type: { type: 'string' },
          platform: { type: 'string' },
          followers: { type: 'string' },
          sizeBucket: { type: 'string' },
          contentStyle: { type: 'string' },
          company: { type: 'string' },
          title: { type: 'string' },
          location: { type: 'string' },
          members: { type: 'string' },
          incentive: { type: 'string' },
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
          'kind',
          'type',
          'platform',
          'followers',
          'sizeBucket',
          'contentStyle',
          'company',
          'title',
          'location',
          'members',
          'incentive',
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
  required: ['summary', 'leads'],
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

function buildLeadResearchPrompt(options = {}) {
  const kind = ['creators', 'partners', 'orgPartners'].includes(options.kind) ? options.kind : 'creators';
  const primary = Array.isArray(options.primary) && options.primary.length ? options.primary : (kind === 'creators' ? ['TikTok', 'Instagram'] : kind === 'partners' ? ['Artist', 'Brand'] : ['Church', 'Church Camp', 'Ministry']);
  const secondary = Array.isArray(options.secondary) && options.secondary.length ? options.secondary : (kind === 'creators' ? ['Small Creator', 'Medium Creator'] : kind === 'partners' ? ['Christian music', 'premium Bible brands'] : ['churches', 'camps', 'ministries']);
  const limit = Math.min(Math.max(Number.parseInt(options.limit || 8, 10) || 8, 1), 20);
  const brief = String(options.brief || '').trim();
  const notes = String(options.notes || '').trim();

  if (kind === 'partners') {
    return [
      'You are researching outreach leads for Creed, a Christian app focused on Bible-based, devotional, and faith-building experiences.',
      'Use Google Search grounding to find real Christian artists and premium Christian brands that could be strong partnership fits for Creed.',
      `Target partner types: ${primary.join(', ')}.`,
      `Focus areas: ${secondary.join(', ')}.`,
      `Return up to ${limit} leads.`,
      'Populate kind as either "Artist" or "Brand". Leave unrelated fields as empty strings.',
      'For Artist leads, prioritize Christian or worship artists, faith-adjacent musicians, or artist teams whose audience overlaps naturally with a Bible app.',
      'For Brand leads, prioritize premium Christian brands in categories like Bible studies, journals, devotionals, Christian apparel, rosaries, books, or giftable faith products.',
      'Prioritize leads that feel high-trust, premium, and brand-safe rather than mass-market generic Christian merch.',
      'Prefer outreach-ready leads with a clear public presence, brand site, label site, management page, or contact path.',
      'Why fit should explain the actual Creed alignment, such as shared Christian audience, devotional overlap, premium faith product fit, or partnership credibility.',
      'bestUseCase should be specific, such as "artist partnership", "brand partnership", "merch partnership", or "cross-promotion".',
      'Suggested first outreach angles should stay short, warm, and intentionally a little vague on details for the first reach-out.',
      'Do not suggest artists or brands that feel controversial, off-brand, low quality, or only loosely connected to Christian audiences.',
      'If a field cannot be verified, return an empty string instead of guessing.',
      brief ? `Extra guidance: ${brief}` : '',
      notes ? `Research notes: ${notes}` : '',
    ].filter(Boolean).join('\n');
  }

  if (kind === 'orgPartners') {
    return [
      'You are researching church, camp, and ministry partnership leads for Creed, a Christian app.',
      'Use Google Search grounding to find real organizations that could be strong church, camp, or community partnerships for Creed.',
      `Target organization types: ${primary.join(', ')}.`,
      `Focus areas: ${secondary.join(', ')}.`,
      `Return up to ${limit} leads.`,
      'Populate type as values like "Church", "Church Camp", "Ministry", or "Other". Leave unrelated fields as empty strings.',
      'Prioritize churches, camps, student ministries, and young adult ministries that feel active, growing, and likely to care about Bible engagement, discipleship, or digital faith tools.',
      'Strong fits include churches with visible young adult/student programs, camps with Christian formation emphasis, and ministries with clear discipleship or devotional focus.',
      'Members should be a rough public estimate only if it is reasonably inferable; otherwise return an empty string.',
      'Why fit should explain the actual activation angle, such as church-wide Bible app usage, ambassador potential, ministry distribution, camp integration, or community reach.',
      'bestUseCase should be specific, such as "church ambassador program", "camp partnership", "church rollout", or "ministry activation".',
      'incentive should suggest a plausible partnership package direction, like free Creed access, ambassador rollout, merch support, event activation, or church access.',
      'Suggested first outreach angles should feel suitable for a first outreach email or message and should emphasize alignment, usefulness to their people, and curiosity rather than hard selling.',
      'Avoid organizations that look inactive, outdated, or not clearly Christian.',
      'If a field cannot be verified, return an empty string instead of guessing.',
      brief ? `Extra guidance: ${brief}` : '',
      notes ? `Research notes: ${notes}` : '',
    ].filter(Boolean).join('\n');
  }

  return [
    'You are researching Christian creators for Creed, a Christian app.',
    'Use Google Search grounding to find real creators and return only creators you can reasonably verify from public web results.',
    `Target platforms: ${primary.join(', ')}.`,
    `Target size buckets: ${secondary.join(', ')}.`,
    `Return up to ${limit} creators.`,
    'Creed is specifically looking for creators who could make strong UGC-style or paid ad content for a Christian app, not just generic influencers.',
    'Prioritize creators with direct-to-camera, speaking-style, testimonial, devotional, motivational, evangelical, or Christian inspirational short-form content.',
    'Strong fits should look natural introducing an app early, hooking attention quickly, explaining something clearly, and speaking with warmth and conviction on camera.',
    'Favor creators who seem likely to produce paid creative consistently, follow a brief, and feel affordable enough for direct-response ads.',
    'For smaller creators, prioritize quality, trust, relatability, and ad-readiness over follower count alone.',
    'Avoid meme pages, repost pages, worship lyric pages, heavily edited faceless pages, or creators whose content is only loosely Christian.',
    'Avoid creators who feel risky for brand safety, polarizing in a way that would hurt Creed, or weak on camera.',
    'If a field cannot be verified, return an empty string instead of guessing.',
    'Keep follower counts human-readable like "18,500".',
    'whyFit should explain exactly why they feel like a Creed fit for UGC or paid ads, not just that they are Christian.',
    'engagementQuality should reflect whether the audience seems genuinely responsive, not just large.',
    'bestUseCase should be specific, such as "paid ad creator", "ugc creator", "creator recruiting", or "devotional/content partner".',
    'Suggested first outreach angles should sound like a real first message: warm, concise, creator-friendly, and focused on a new Christian app looking for paid content support.',
    'The angle can lightly imply that Creed wants creators to make paid content or ad creative, but it should not dump all compensation details in the first line.',
    brief ? `Extra guidance: ${brief}` : '',
    notes ? `Research notes: ${notes}` : '',
  ].filter(Boolean).join('\n');
}

function buildJsonFormatHint() {
  return [
    'Return valid JSON only.',
    'Do not use markdown fences.',
    'Use exactly this top-level shape:',
    '{"summary":"string","leads":[{"name":"","kind":"","type":"","platform":"","followers":"","sizeBucket":"","contentStyle":"","company":"","title":"","location":"","members":"","incentive":"","whyFit":"","engagementQuality":"","bestUseCase":"","suggestedFirstOutreachAngle":"","profileUrl":"","email":"","phone":"","notes":""}]}',
  ].join('\n');
}

function getResponseText(payload) {
  return payload?.candidates?.[0]?.content?.parts
    ?.map(part => part?.text || '')
    .join('')
    .trim() || '';
}

function extractJsonObject(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Gemini returned an empty lead research response.');

  const fenceMatch = raw.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch) return fenceMatch[1].trim();

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    return raw.slice(firstBrace, lastBrace + 1).trim();
  }

  return raw;
}

function supportsStructuredToolJson(modelName = '') {
  return /^gemini-3/i.test(String(modelName || '').trim());
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

async function runLeadResearch(options = {}) {
  const useStructuredToolJson = supportsStructuredToolJson(GEMINI_MODEL);
  const body = {
    contents: [
      {
        parts: [
          { text: [buildLeadResearchPrompt(options), !useStructuredToolJson ? buildJsonFormatHint() : ''].filter(Boolean).join('\n\n') },
        ],
      },
    ],
    tools: [
      { google_search: {} },
    ],
  };

  if (useStructuredToolJson) {
    body.generationConfig = {
      responseMimeType: 'application/json',
      responseJsonSchema: LEAD_RESEARCH_SCHEMA,
    };
  }

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
  if (!rawText) throw new Error('Gemini returned an empty lead research response.');

  let parsed;
  try {
    parsed = JSON.parse(useStructuredToolJson ? rawText : extractJsonObject(rawText));
  } catch (err) {
    throw new Error('Gemini returned research, but it was not valid JSON.');
  }

  return {
    summary: typeof parsed.summary === 'string' ? parsed.summary : '',
    leads: Array.isArray(parsed.leads) ? parsed.leads : [],
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

  if (req.method === 'POST' && (url.pathname === '/api/lead-research' || url.pathname === '/api/creator-research')) {
    if (!GEMINI_API_KEY) {
      sendJson(res, 400, { error: 'Gemini is not configured yet. Add GEMINI_API_KEY on the server first.' });
      return;
    }

    try {
      const body = await collectBody(req);
      const options = JSON.parse(body || '{}');
      const result = await runLeadResearch(options);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 502, { error: err.message || 'Unable to run Gemini lead research.' });
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
