const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { execFile } = require('child_process');

const PORT = Number.parseInt(process.env.PORT || '3000', 10);
const HOST = process.env.HOST || '0.0.0.0';
const ROOT_DIR = __dirname;
const HTML_PATH = path.join(ROOT_DIR, 'Creed_Jax_Dashboard.html');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : ROOT_DIR;
const AGENT_BATCHES_DIR = process.env.AGENT_BATCHES_DIR
  ? path.resolve(process.env.AGENT_BATCHES_DIR)
  : path.join(__dirname, '..', 'creed-agent', 'batches');
const AGENT_QUEUE_FILE = process.env.AGENT_QUEUE_FILE
  ? path.resolve(process.env.AGENT_QUEUE_FILE)
  : path.join(__dirname, '..', 'creed-agent', 'queue.md');
const AGENT_REPLIES_FILE = path.join(DATA_DIR, 'agent-replies.json');
const REPLY_CHECKER_SCRIPT = path.join(__dirname, '..', 'creed-agent', 'reply_checker.py');
const STATE_PATH = path.join(DATA_DIR, 'dashboard-state.json');
const EMPTY_STATE = {
  version: 2,
  updatedAt: '',
  tasks: [],
  youngAdults: [],
  family: [],
  faithLeaders: [],
  misc: [],
  pendingApprovals: [],
  scripts: [],
  weeklyGoal: { videos: 0, statics: 0, target: 60 },
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
const MESSAGE_DRAFT_SCHEMA = {
  type: 'object',
  properties: {
    subject: { type: 'string' },
    message: { type: 'string' },
    channel: { type: 'string' },
    toneNotes: { type: 'string' },
  },
  required: ['subject', 'message', 'channel', 'toneNotes'],
};

function sanitizeState(state = {}) {
  return {
    version: 2,
    updatedAt: typeof state.updatedAt === 'string' ? state.updatedAt : '',
    tasks: Array.isArray(state.tasks) ? state.tasks : [],
    youngAdults: Array.isArray(state.youngAdults) ? state.youngAdults : [],
    family: Array.isArray(state.family) ? state.family : [],
    faithLeaders: Array.isArray(state.faithLeaders) ? state.faithLeaders : [],
    misc: Array.isArray(state.misc) ? state.misc : [],
    pendingApprovals: Array.isArray(state.pendingApprovals) ? state.pendingApprovals : [],
    scripts: Array.isArray(state.scripts) ? state.scripts : [],
    weeklyGoal: (state.weeklyGoal && typeof state.weeklyGoal === 'object') ? state.weeklyGoal : { videos: 0, statics: 0, target: 60 },
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

// ── Agent helpers ──────────────────────────────────────────────────────────

function parseBatchFile(filename, content) {
  const nameMatch = filename.match(/^(?:batch|immediate)-(\d{4}-\d{2}-\d{2})(?:-(.+?))?\.md$/);
  const date = nameMatch ? nameMatch[1] : '?';
  const label = nameMatch ? (nameMatch[2] || 'immediate') : 'immediate';

  function extractTarget(section, targetLine) {
    const summaryMatch = section.match(/RESEARCH SUMMARY:\s*([\s\S]*?)(?=\nCREATOR TYPE:|\n---DRAFT|$)/);
    const typeMatch    = section.match(/CREATOR TYPE:\s*(.+)/);
    const emailMatch   = section.match(/FOUND EMAIL:\s*(.+)/);
    const subjectMatch = section.match(/SUBJECT LINE:\s*(.+)/);
    const draftMatch   = section.match(/---DRAFT START---\s*([\s\S]*?)\s*---DRAFT END---/);
    const emailVal     = emailMatch ? emailMatch[1].trim() : 'none';
    const foundEmail   = ['none', 'n/a', 'not found', 'none found'].includes(emailVal.toLowerCase()) ? null : emailVal;
    const subjectVal   = subjectMatch ? subjectMatch[1].trim() : null;
    return {
      target:      targetLine,
      summary:     summaryMatch ? summaryMatch[1].trim() : '',
      creatorType: typeMatch ? typeMatch[1].trim() : 'Unknown',
      foundEmail:  foundEmail || null,
      subject:     (!subjectVal || subjectVal.toLowerCase() === 'n/a') ? null : subjectVal,
      draft:       draftMatch ? draftMatch[1].trim() : '',
    };
  }

  const targets = [];
  const batchSections = content.split(/={10,}\nTARGET \d+:/);
  if (batchSections.length > 1) {
    for (let i = 1; i < batchSections.length; i++) {
      const section = batchSections[i];
      targets.push(extractTarget(section, section.split('\n')[0].trim()));
    }
  } else {
    const immediateSections = content.split(/\n\nTARGET: /);
    for (let i = 1; i < immediateSections.length; i++) {
      const section = immediateSections[i];
      targets.push(extractTarget(section, section.split('\n')[0].trim()));
    }
  }

  return {
    filename,
    date,
    label,
    totalTargets: targets.length,
    emailCount:   targets.filter(t => t.foundEmail).length,
    dmCount:      targets.filter(t => !t.foundEmail).length,
    targets,
  };
}

function readAgentRuns() {
  try {
    if (!fs.existsSync(AGENT_BATCHES_DIR)) return [];
    return fs.readdirSync(AGENT_BATCHES_DIR)
      .filter(f => f.endsWith('.md'))
      .sort()
      .reverse()
      .map(f => parseBatchFile(f, fs.readFileSync(path.join(AGENT_BATCHES_DIR, f), 'utf8')));
  } catch (_) {
    return [];
  }
}

function readAgentQueue() {
  try {
    if (!fs.existsSync(AGENT_QUEUE_FILE)) return [];
    const content = fs.readFileSync(AGENT_QUEUE_FILE, 'utf8');
    if (!content.includes('## Queue')) return [];
    return content
      .split('## Queue')[1]
      .replace(/<!--[\s\S]*?-->/g, '')
      .split('\n')
      .map(l => l.trim())
      .filter(l => l && !l.startsWith('#') && !l.startsWith('```'));
  } catch (_) {
    return [];
  }
}

function appendAgentQueue(entry) {
  if (!fs.existsSync(AGENT_QUEUE_FILE)) throw new Error('queue.md not found');
  const content = fs.readFileSync(AGENT_QUEUE_FILE, 'utf8');
  if (!content.includes('## Queue')) throw new Error('queue.md format not recognized');
  fs.writeFileSync(AGENT_QUEUE_FILE, content.trimEnd() + '\n' + entry + '\n');
}

function readAgentReplies() {
  try {
    if (!fs.existsSync(AGENT_REPLIES_FILE)) return [];
    return JSON.parse(fs.readFileSync(AGENT_REPLIES_FILE, 'utf8'));
  } catch (_) {
    return [];
  }
}

// ── End agent helpers ──────────────────────────────────────────────────────

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
  const focus = String(options.focus || '').trim().toLowerCase();
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
      focus === 'artists' ? 'Only return Artist leads in this run.' : '',
      focus === 'brands' ? 'Only return Brand leads in this run.' : '',
      'followers should reflect the most relevant social following you can reasonably verify from a public profile; otherwise leave it blank.',
      'sizeBucket should be "Small", "Medium", or "Large" when followers can be inferred from the public profile.',
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
      'followers should reflect the most relevant public social following you can verify for the organization if available; otherwise leave it blank.',
      'sizeBucket should be "Small", "Medium", or "Large" when followers can be inferred from the public profile.',
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
    focus === 'ugc' ? 'This run is specifically for UGC creators. Prioritize roughly 5k-50k followers, authenticity, relatability, and creators who feel natural for testimonial-style or creator-made app content.' : '',
    focus === 'paid_ads' ? 'This run is specifically for paid ad creators. Prioritize roughly 20k-200k followers, stronger hooks, sharper on-camera delivery, and creators who feel especially capable of producing performance-oriented paid creative.' : '',
    'Creed is specifically looking for creators who could make strong UGC-style or paid ad content for a Christian app, not just generic influencers.',
    'Prioritize creators with direct-to-camera, speaking-style, testimonial, devotional, motivational, evangelical, or Christian inspirational short-form content.',
    'Strong fits should look natural introducing an app early, hooking attention quickly, explaining something clearly, and speaking with warmth and conviction on camera.',
    'Favor creators who seem likely to produce paid creative consistently, follow a brief, and feel affordable enough for direct-response ads.',
    'For smaller creators, prioritize quality, trust, relatability, and ad-readiness over follower count alone.',
    'Avoid meme pages, repost pages, worship lyric pages, heavily edited faceless pages, or creators whose content is only loosely Christian.',
    'Avoid creators who feel risky for brand safety, polarizing in a way that would hurt Creed, or weak on camera.',
    'If a field cannot be verified, return an empty string instead of guessing.',
    'Keep follower counts human-readable like "18,500".',
    'sizeBucket should be "Small", "Medium", or "Large" based on the creator’s social following when it can be inferred.',
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

function buildMessageDraftPrompt(options = {}) {
  const channel = ['Instagram DM', 'TikTok DM', 'Email'].includes(options.channel) ? options.channel : 'Instagram DM';
  const recipient = String(options.recipient || '').trim() || 'this person';
  const group = String(options.group || '').trim() || 'Creator';
  const platform = String(options.platform || '').trim();
  const company = String(options.company || '').trim();
  const title = String(options.title || '').trim();
  const notes = String(options.notes || '').trim();
  const style = String(options.style || '').trim();
  const whyFit = String(options.whyFit || '').trim();
  const angle = String(options.angle || '').trim();
  const referenceTitle = String(options.referenceTitle || '').trim();
  const referenceBody = String(options.referenceBody || '').trim();

  return [
    'You are drafting a first outreach message for Jax from Creed, a Christian app.',
    `Recipient: ${recipient}.`,
    `Group: ${group}.`,
    platform ? `Platform: ${platform}.` : '',
    company ? `Company / organization: ${company}.` : '',
    title ? `Role / title: ${title}.` : '',
    notes ? `Notes about them: ${notes}.` : '',
    style ? `Known content or communication style: ${style}.` : '',
    whyFit ? `Why they seem like a fit: ${whyFit}.` : '',
    angle ? `Suggested outreach angle: ${angle}.` : '',
    referenceTitle ? `Reference script title: ${referenceTitle}.` : '',
    referenceBody ? `Reference script/example for inspiration only: ${referenceBody}.` : '',
    `Channel: ${channel}.`,
    'Important tone guidance:',
    'This must sound real, relatable, personable, and personal.',
    'It should sound like someone who may not know them yet but genuinely wants to connect, not like a sales pitch.',
    'Emphasize realness, warmth, and one specific detail that feels unique to them.',
    'Do not sound robotic, corporate, spammy, overly polished, or overly excited.',
    'Avoid generic flattery.',
    'Make it feel like a human reaching out one-to-one.',
    channel === 'Email'
      ? 'For email: write a short friendly-professional email with a concise subject line and a body that still feels warm and personal.'
      : 'For Instagram DM or TikTok DM: keep it short and sweet, very natural, easy to read on mobile, and not too long.',
    'Return JSON only.',
    'Use this exact shape:',
    '{"subject":"string","message":"string","channel":"string","toneNotes":"string"}',
  ].filter(Boolean).join('\n');
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

async function runMessageDraft(options = {}) {
  const useStructuredToolJson = supportsStructuredToolJson(GEMINI_MODEL);
  const body = {
    contents: [
      {
        parts: [
          { text: buildMessageDraftPrompt(options) },
        ],
      },
    ],
  };

  if (useStructuredToolJson) {
    body.generationConfig = {
      responseMimeType: 'application/json',
      responseJsonSchema: MESSAGE_DRAFT_SCHEMA,
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
    const message = payload?.error?.message || 'Gemini message draft request failed.';
    throw new Error(message);
  }

  const rawText = getResponseText(payload);
  if (!rawText) throw new Error('Gemini returned an empty message draft.');

  try {
    const parsed = JSON.parse(useStructuredToolJson ? rawText : extractJsonObject(rawText));
    return {
      subject: typeof parsed.subject === 'string' ? parsed.subject : '',
      message: typeof parsed.message === 'string' ? parsed.message : '',
      channel: typeof parsed.channel === 'string' ? parsed.channel : (options.channel || ''),
      toneNotes: typeof parsed.toneNotes === 'string' ? parsed.toneNotes : '',
      model: GEMINI_MODEL,
    };
  } catch (err) {
    throw new Error('Gemini returned a message draft, but it was not valid JSON.');
  }
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

  if (req.method === 'POST' && url.pathname === '/api/message-draft') {
    if (!GEMINI_API_KEY) {
      sendJson(res, 400, { error: 'Gemini is not configured yet. Add GEMINI_API_KEY on the server first.' });
      return;
    }

    try {
      const body = await collectBody(req);
      const options = JSON.parse(body || '{}');
      const result = await runMessageDraft(options);
      sendJson(res, 200, result);
    } catch (err) {
      sendJson(res, 502, { error: err.message || 'Unable to generate a Gemini message draft.' });
    }
    return;
  }

  if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html' || url.pathname === '/Creed_Jax_Dashboard.html')) {
    sendHtml(res);
    return;
  }

  // ── Agent log API ────────────────────────────────────────────────────────

  if (req.method === 'GET' && url.pathname === '/api/agent-runs') {
    sendJson(res, 200, readAgentRuns());
    return;
  }

  // Agent pushes its batch results here so they appear in the Approval panel
  if (req.method === 'POST' && url.pathname === '/api/agent-run') {
    try {
      const body = await collectBody(req);
      const payload = JSON.parse(body || '{}');
      const targets = Array.isArray(payload.targets) ? payload.targets : [];
      if (targets.length === 0) {
        sendJson(res, 400, { error: 'targets array is required and must not be empty' });
        return;
      }
      const batchLabel = (typeof payload.batchName === 'string' && payload.batchName.trim()) || new Date().toISOString().slice(0, 10);
      const now = new Date().toISOString();
      const state = readState();
      const newItems = targets.map((t, i) => ({
        id: `${batchLabel}::${i}::${Math.random().toString(36).slice(2, 7)}`,
        status: 'pending',
        addedAt: now,
        target: {
          name:        (t.name || t.target || '').trim(),
          platform:    t.platform || 'TikTok',
          followers:   t.followers || '',
          email:       t.found_email || t.email || '',
          creatorType: t.creator_type || t.creatorType || 'Unknown',
          summary:     t.summary || '',
          subject:     t.subject || '',
          draft:       t.draft || '',
        },
      }));
      state.pendingApprovals = [...(state.pendingApprovals || []), ...newItems];
      writeState(state);
      console.log(`[agent-run] Added ${newItems.length} pending creator(s) from batch "${batchLabel}"`);
      sendJson(res, 200, { ok: true, added: newItems.length, batchLabel });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Failed to push agent run.' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-queue') {
    sendJson(res, 200, { entries: readAgentQueue() });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-queue') {
    try {
      const body = await collectBody(req);
      const { entry } = JSON.parse(body || '{}');
      if (!entry || typeof entry !== 'string' || !entry.trim()) {
        sendJson(res, 400, { error: 'entry is required' });
        return;
      }
      appendAgentQueue(entry.trim());
      sendJson(res, 200, { ok: true, entries: readAgentQueue() });
    } catch (err) {
      sendJson(res, 400, { error: err.message || 'Failed to add to queue.' });
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/agent-replies') {
    sendJson(res, 200, readAgentReplies());
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/agent-replies/check') {
    if (!fs.existsSync(REPLY_CHECKER_SCRIPT)) {
      sendJson(res, 404, { error: 'reply_checker.py not found next to the dashboard.' });
      return;
    }
    execFile('python3', [REPLY_CHECKER_SCRIPT], { timeout: 90000 }, (err, _stdout, stderr) => {
      if (err) {
        sendJson(res, 502, { error: (stderr || err.message || 'Reply checker failed.').slice(0, 400) });
        return;
      }
      sendJson(res, 200, { ok: true, replies: readAgentReplies() });
    });
    return;
  }

  // ── End agent log API ────────────────────────────────────────────────────

  sendJson(res, 404, { error: 'Not found.' });
});

server.listen(PORT, HOST, () => {
  console.log(`Jax Dashboard running at http://${HOST}:${PORT}`);
});
