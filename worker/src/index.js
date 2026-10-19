// Caption Café AI proxy — one endpoint, POST /captions.
// Holds the Anthropic API key as a Worker secret so it never reaches the browser.
// The route is self-contained, so it can also be merged into a shared Worker that serves other paths.
import Anthropic from '@anthropic-ai/sdk';

const TONES = ['playful', 'cosy', 'bold', 'luxe', 'funny'];
const PLATFORMS = ['instagram', 'tiktok', 'x'];
// Platform limit counts caption text + hashtags. The site enforces the same numbers.
const LIMITS = { instagram: 300, tiktok: 300, x: 280 };
const MAX_TAGS = { instagram: 8, tiktok: 8, x: 3 };

const MAX_BODY_BYTES = 4_000;
const RATE_LIMIT = 20; // brews per IP per window
const RATE_WINDOW_MS = 60 * 60 * 1000;

const SYSTEM = `You are the copywriter at Caption Café. A small business tells you what it is selling and to whom; you write four ready-to-post social captions.
Each caption is a different angle (for example: a hook, a little story, a question to the audience, a playful call to action). Write like a real person, not an ad.
Rules:
- Use only facts the order gives you. Never invent prices, discounts, awards, health claims, dates or locations.
- Nothing offensive, mean, or about people's bodies. Light emoji are welcome; at most two per caption.
- Hashtags are single words or camelCase, without spaces, each starting with #. Put them in the hashtags list, never inside the text.
- Give each caption one tone from the allowed list, and spread the allowed tones across the four captions.`;

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    captions: {
      type: 'array',
      description: 'Exactly four captions',
      items: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The caption, without hashtags' },
          hashtags: { type: 'array', items: { type: 'string' } },
          tone: { type: 'string', enum: TONES },
        },
        required: ['text', 'hashtags', 'tone'],
        additionalProperties: false,
      },
    },
  },
  required: ['captions'],
  additionalProperties: false,
};

// Per-isolate fallback counter, used when no KV namespace is bound as RATE_KV.
const memoryHits = new Map();

async function overLimit(env, ip) {
  const bucket = Math.floor(Date.now() / RATE_WINDOW_MS);
  const key = `rl:${ip}:${bucket}`;
  if (env.RATE_KV) {
    const count = Number(await env.RATE_KV.get(key)) || 0;
    if (count >= RATE_LIMIT) return true;
    await env.RATE_KV.put(key, String(count + 1), { expirationTtl: 2 * 60 * 60 });
    return false;
  }
  for (const k of memoryHits.keys()) if (!k.endsWith(`:${bucket}`)) memoryHits.delete(k);
  const count = memoryHits.get(key) || 0;
  if (count >= RATE_LIMIT) return true;
  memoryHits.set(key, count + 1);
  return false;
}

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin');
  const allowed = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return origin && allowed.includes(origin) ? origin : null;
}

function json(body, status, origin) {
  const headers = { 'Content-Type': 'application/json', Vary: 'Origin' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(body), { status, headers });
}

// Order fields come from the browser, so keep only what a short label needs (no newlines, braces or quotes).
const clean = (value, max) => String(value ?? '').replace(/[^\p{L}\p{N}\p{Emoji_Presentation} &',.!?+%-]/gu, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const graphemes = (s) => [...s].length;

function parseRequest(body) {
  const platform = String(body?.platform).toLowerCase();
  if (!PLATFORMS.includes(platform)) return null;
  const tones = Array.isArray(body.tones) ? [...new Set(body.tones.map((t) => String(t).toLowerCase()))] : [];
  if (!tones.length || tones.length > TONES.length || tones.some((t) => !TONES.includes(t))) return null;
  const product = clean(body.product, 80);
  const audience = clean(body.audience, 80);
  if (!product || !audience) return null;
  const business = clean(body.business, 40);
  const avoid = Array.isArray(body.avoid) ? body.avoid.slice(0, 4).map((t) => clean(t, 120)).filter(Boolean) : [];
  return { business, product, audience, tones, platform, avoid };
}

function buildPrompt({ business, product, audience, tones, platform, avoid }) {
  const room = platform === 'x' ? 200 : 220;
  return [
    `Business: ${business || '(no name given, do not invent one)'}`,
    `Selling: ${product}`,
    `Audience: ${audience}`,
    `Allowed tones: ${tones.join(', ')}`,
    `Platform: ${platform === 'x' ? 'X (Twitter)' : platform === 'tiktok' ? 'TikTok' : 'Instagram'}`,
    `Length: each caption text under ${room} characters, with ${platform === 'x' ? '1 to 3' : '3 to 8'} hashtags.`,
    avoid.length ? `They just saw these openings, so write different ones:\n${avoid.map((a) => `- ${a}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
}

const normTag = (t) => {
  const word = String(t ?? '').replace(/^#+/, '').replace(/[^\p{L}\p{N}_]/gu, '');
  return word ? `#${word.slice(0, 30)}` : '';
};

// Returns four clean captions, or null so the site can serve its house blend instead.
function tidy(result, order) {
  if (!result || !Array.isArray(result.captions) || result.captions.length < 4) return null;
  const out = [];
  for (const c of result.captions.slice(0, 4)) {
    const text = String(c?.text ?? '').replace(/\s+#[\p{L}\p{N}_]+/gu, '').replace(/\s+/g, ' ').trim();
    if (!text || graphemes(text) > LIMITS[order.platform]) return null;
    const tone = order.tones.includes(c.tone) ? c.tone : order.tones[out.length % order.tones.length];
    const hashtags = [...new Set((Array.isArray(c.hashtags) ? c.hashtags : []).map(normTag).filter(Boolean))].slice(0, MAX_TAGS[order.platform]);
    // Drop trailing hashtags until text + tags fit the platform.
    while (hashtags.length && graphemes(`${text} ${hashtags.join(' ')}`) > LIMITS[order.platform]) hashtags.pop();
    out.push({ text, hashtags, tone });
  }
  return out;
}

async function brew(request, env, origin) {
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  if (await overLimit(env, ip)) return json({ error: 'rate_limited' }, 429, origin);

  const raw = await request.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'too_large' }, 413, origin);
  let order;
  try {
    order = parseRequest(JSON.parse(raw));
  } catch {
    order = null;
  }
  if (!order) return json({ error: 'bad_request' }, 400, origin);
  if (!env.ANTHROPIC_API_KEY) return json({ error: 'not_configured' }, 500, origin);

  const model = env.MODEL || 'claude-opus-5-5';
  // The site falls back to its house blend after 8s, so fail fast rather than retry.
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY, maxRetries: 0, timeout: 7500 });
  try {
    const response = await client.beta.messages.create({
      model,
      max_tokens: 2048,
      system: SYSTEM,
      messages: [{ role: 'user', content: buildPrompt(order) }],
      output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      // If a safety classifier declines, the API retries on a fallback model inside the same call.
      // Haiku has no server-side fallback, so only send it for the larger models.
      ...(/haiku/.test(model) ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
    });
    if (response.stop_reason !== 'end_turn') return json({ error: 'no_captions', reason: response.stop_reason }, 502, origin);

    const block = response.content.find((b) => b.type === 'text');
    const captions = tidy(JSON.parse(block?.text ?? 'null'), order);
    if (!captions) return json({ error: 'invalid_captions' }, 502, origin);
    return json({ captions }, 200, origin);
  } catch (error) {
    if (error instanceof Anthropic.RateLimitError) return json({ error: 'upstream_busy' }, 503, origin);
    if (error instanceof Anthropic.APIConnectionTimeoutError) return json({ error: 'upstream_timeout' }, 504, origin);
    if (error instanceof Anthropic.APIError) {
      console.error('anthropic error', error.status, error.message);
      return json({ error: 'upstream_error' }, 502, origin);
    }
    console.error('captions error', error);
    return json({ error: 'upstream_error' }, 502, origin);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = allowedOrigin(request, env);

    if (url.pathname !== '/captions') return json({ error: 'not_found' }, 404, origin);
    if (request.method === 'OPTIONS') {
      if (!origin) return new Response(null, { status: 403 });
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        },
      });
    }
    if (request.method !== 'POST') return json({ error: 'method_not_allowed' }, 405, origin);
    if (!origin) return json({ error: 'origin_not_allowed' }, 403, null);
    return brew(request, env, origin);
  },
};
