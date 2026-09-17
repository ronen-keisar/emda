// "עמדה" stores neither answers nor generated analysis. This Worker receives a
// manifesto only for the requested inference, and keeps a short-lived, hashed
// technical identifier solely to protect the free daily quota from abuse.

interface Env {
  AI: { run: (model: string, input: Record<string, unknown>) => Promise<unknown> };
  USAGE: DurableObjectNamespace;
  ALLOWED_ORIGIN: string;
  DAILY_ANALYSIS_LIMIT: string;
  PER_VISITOR_DAILY_LIMIT: string;
  RATE_LIMIT_SALT: string;
  RESEND_API_KEY?: string;
  ALERT_EMAIL?: string;
}

interface UsageReservation {
  allowed: boolean;
  reason?: 'daily_limit' | 'visitor_limit';
  total?: number;
  threshold?: 70 | 90;
}

interface InsightResponse {
  title: string;
  summary: string;
  themes: Array<{ title: string; text: string; evidence: string }>;
  tensions: Array<{ title: string; text: string }>;
  next_question?: string;
  caveat: string;
}

// This model is available in the account's Workers AI catalogue, supports
// multilingual instruction following, and is modest enough for the beta quota.
const MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
const MAX_MANIFESTO_CHARS = 12000;

const systemPrompt = `את/ה עוזר/ת ניתוח ניטרלי לכלי הישראלי "עמדה". קבל/י מצע אישי שנבנה מבחירות מדיניות.
החזר/י אך ורק JSON תקין בעברית, במבנה: {"title":"...","summary":"...","themes":[{"title":"...","text":"...","evidence":"..."}],"tensions":[{"title":"...","text":"..."}],"next_question":"...","caveat":"..."}.
כללים: עד 3 themes, עד 2 tensions, וכל טקסט קצר וברור. הסתמך/י רק על המצע שהוזן. אל תייחס/י למפלגה, מחנה, אידאולוגיה או אישיות פוליטית; אל תמליץ/י למי להצביע; אל תאבחן/י את המשתמש/ת; אל תציג/י מסקנה כעובדה. evidence חייב לציין בחירה או נושא ממשי מן המצע. אם אין בסיס, אמור/י זאת בקצרה. המטרה היא להראות דפוסים, פשרות ושאלות להמשך בירור.`;

export class UsageCounter {
  private readonly sql: DurableObjectStorage['sql'];

  constructor(private readonly state: DurableObjectState) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS daily_usage (
      day TEXT PRIMARY KEY,
      requests INTEGER NOT NULL,
      alerted_70 INTEGER NOT NULL DEFAULT 0,
      alerted_90 INTEGER NOT NULL DEFAULT 0
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS visitor_usage (
      day TEXT NOT NULL,
      visitor_hash TEXT NOT NULL,
      requests INTEGER NOT NULL,
      PRIMARY KEY (day, visitor_hash)
    )`);
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method !== 'POST') return Response.json({ error: 'method_not_allowed' }, { status: 405 });
    const { action = 'reserve', day, visitorHash, dailyLimit, visitorLimit } = await request.json() as {
      action?: 'reserve' | 'release'; day: string; visitorHash: string; dailyLimit: number; visitorLimit: number;
    };

    // Retain only today's anonymous quota counters. No manifesto or answer text is written here.
    this.sql.exec('DELETE FROM visitor_usage WHERE day <> ?', day);
    this.sql.exec('DELETE FROM daily_usage WHERE day <> ?', day);

    // An unavailable model or malformed response must not take a beta attempt
    // away from the visitor. The counter records no answer text.
    if (action === 'release') {
      this.sql.exec('UPDATE daily_usage SET requests = MAX(requests - 1, 0) WHERE day = ?', day);
      this.sql.exec('UPDATE visitor_usage SET requests = MAX(requests - 1, 0) WHERE day = ? AND visitor_hash = ?', day, visitorHash);
      return Response.json({ allowed: true } satisfies UsageReservation);
    }

    const daily = Array.from(this.sql.exec<{ requests: number; alerted_70: number; alerted_90: number }>(
      'SELECT requests, alerted_70, alerted_90 FROM daily_usage WHERE day = ?', day,
    ))[0] ?? { requests: 0, alerted_70: 0, alerted_90: 0 };
    if (daily.requests >= dailyLimit) return Response.json({ allowed: false, reason: 'daily_limit' } satisfies UsageReservation);

    const visitor = Array.from(this.sql.exec<{ requests: number }>(
      'SELECT requests FROM visitor_usage WHERE day = ? AND visitor_hash = ?', day, visitorHash,
    ))[0] ?? { requests: 0 };
    if (visitor.requests >= visitorLimit) return Response.json({ allowed: false, reason: 'visitor_limit' } satisfies UsageReservation);

    const nextTotal = daily.requests + 1;
    const reached70 = nextTotal >= Math.ceil(dailyLimit * 0.7) && !daily.alerted_70;
    const reached90 = nextTotal >= Math.ceil(dailyLimit * 0.9) && !daily.alerted_90;
    this.sql.exec(
      `INSERT INTO daily_usage (day, requests, alerted_70, alerted_90) VALUES (?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET requests = excluded.requests, alerted_70 = excluded.alerted_70, alerted_90 = excluded.alerted_90`,
      day, nextTotal, reached70 || daily.alerted_70 ? 1 : 0, reached90 || daily.alerted_90 ? 1 : 0,
    );
    this.sql.exec(
      `INSERT INTO visitor_usage (day, visitor_hash, requests) VALUES (?, ?, 1)
       ON CONFLICT(day, visitor_hash) DO UPDATE SET requests = requests + 1`,
      day, visitorHash,
    );
    const threshold = reached90 ? 90 : reached70 ? 70 : undefined;
    return Response.json({ allowed: true, total: nextTotal, threshold } satisfies UsageReservation);
  }
}

function cors(request: Request, env: Env): HeadersInit {
  const origin = request.headers.get('Origin');
  const headers: Record<string, string> = {
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
  if (origin === env.ALLOWED_ORIGIN || origin === 'http://localhost:8787') headers['Access-Control-Allow-Origin'] = origin;
  return headers;
}

function reply(request: Request, env: Env, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors(request, env), 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

async function visitorHash(request: Request, env: Env): Promise<string> {
  const ip = request.headers.get('CF-Connecting-IP') ?? 'unknown';
  const data = new TextEncoder().encode(`${env.RATE_LIMIT_SALT}:${utcDay()}:${ip}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest)).map(value => value.toString(16).padStart(2, '0')).join('');
}

function extractModelText(result: unknown): string {
  if (typeof result === 'string') return result;
  if (!result || typeof result !== 'object') throw new Error('empty_model_response');
  const record = result as Record<string, unknown>;
  if (typeof record.response === 'string') return record.response;
  const content = (record.choices as Array<{ message?: { content?: unknown } }> | undefined)?.[0]?.message?.content;
  if (typeof content === 'string') return content;
  throw new Error('unreadable_model_response');
}

function parseInsight(result: unknown): InsightResponse {
  // JSON Mode may return its response as an object; plain generation returns a string.
  // Support both documented shapes without preserving the model output.
  const record = result && typeof result === 'object' ? result as Record<string, unknown> : undefined;
  const parsed = record?.response && typeof record.response === 'object'
    ? record.response as Partial<InsightResponse>
    : JSON.parse(extractModelText(result).trim().replace(/^```json\s*|^```|```$/g, '').trim()) as Partial<InsightResponse>;
  if (!parsed.title || !parsed.summary || !Array.isArray(parsed.themes) || !Array.isArray(parsed.tensions) || !parsed.caveat) {
    throw new Error('invalid_model_schema');
  }
  return {
    title: String(parsed.title).slice(0, 90),
    summary: String(parsed.summary).slice(0, 420),
    themes: parsed.themes.slice(0, 3).map(item => ({
      title: String(item?.title ?? '').slice(0, 80),
      text: String(item?.text ?? '').slice(0, 380),
      evidence: String(item?.evidence ?? '').slice(0, 220),
    })).filter(item => item.title && item.text && item.evidence),
    tensions: parsed.tensions.slice(0, 2).map(item => ({
      title: String(item?.title ?? '').slice(0, 80),
      text: String(item?.text ?? '').slice(0, 300),
    })).filter(item => item.title && item.text),
    next_question: parsed.next_question ? String(parsed.next_question).slice(0, 260) : undefined,
    caveat: String(parsed.caveat).slice(0, 280),
  };
}

function diagnosticCode(error: unknown): string {
  const message = error instanceof Error ? error.message.toLowerCase() : '';
  if (message.includes('json mode')) return 'json_mode_unmet';
  if (message.includes('model')) return 'model_request_failed';
  return 'analysis_processing_failed';
}

async function sendUsageAlert(env: Env, reservation: UsageReservation): Promise<void> {
  if (!env.RESEND_API_KEY || !env.ALERT_EMAIL || !reservation.threshold || !reservation.total) return;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'עמדה <onboarding@resend.dev>',
      to: [env.ALERT_EMAIL],
      subject: `עמדה: ${reservation.threshold}% ממכסת ניתוחי ה־AI היומית`,
      text: `הכלי השלים ${reservation.total} ניתוחי AI היום והגיע לסף ${reservation.threshold}% של מגבלת הבטא. לא נשלחו ולא נשמרו תשובות משתמשים במייל הזה.`,
    }),
  });
  if (!response.ok) console.error('usage_alert_failed', response.status);
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors(request, env) });
    const url = new URL(request.url);
    if (url.pathname === '/health') return reply(request, env, { ok: true });
    if (url.pathname !== '/insights' || request.method !== 'POST') return reply(request, env, { error: 'not_found' }, 404);
    if (request.headers.get('Origin') !== env.ALLOWED_ORIGIN) return reply(request, env, { error: 'origin_not_allowed' }, 403);

    let payload: { manifesto?: unknown; consent?: unknown };
    try { payload = await request.json(); } catch { return reply(request, env, { error: 'invalid_request' }, 400); }
    const manifesto = typeof payload.manifesto === 'string' ? payload.manifesto.trim() : '';
    if (payload.consent !== true || !manifesto || manifesto.length > MAX_MANIFESTO_CHARS) {
      return reply(request, env, { error: 'invalid_manifesto' }, 400);
    }

    const counter = env.USAGE.get(env.USAGE.idFromName('emda-global-usage'));
    const quota = {
      day: utcDay(), visitorHash: await visitorHash(request, env),
      dailyLimit: Number(env.DAILY_ANALYSIS_LIMIT) || 60,
      visitorLimit: Number(env.PER_VISITOR_DAILY_LIMIT) || 3,
    };
    const reservationResponse = await counter.fetch('https://usage.internal/reserve', {
      method: 'POST',
      body: JSON.stringify({ action: 'reserve', ...quota }),
    });
    const reservation = await reservationResponse.json() as UsageReservation;
    if (!reservation.allowed) return reply(request, env, { error: reservation.reason }, 429);

    const releaseQuota = () => counter.fetch('https://usage.internal/release', {
      method: 'POST', body: JSON.stringify({ action: 'release', ...quota }),
    });

    let result: unknown;
    try {
      result = await env.AI.run(MODEL, {
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: `המצע האישי לניתוח:\n${manifesto}` },
        ],
        max_tokens: 650,
        temperature: 0.25,
      });
    } catch (error) {
      await releaseQuota();
      console.error('inference_failed', error instanceof Error ? error.message : 'unknown');
      return reply(request, env, { error: 'analysis_unavailable', reason: diagnosticCode(error) }, 502);
    }
    try {
      const analysis = parseInsight(result);
      if (reservation.threshold) ctx.waitUntil(sendUsageAlert(env, reservation));
      return reply(request, env, { analysis });
    } catch (error) {
      await releaseQuota();
      console.error('analysis_parse_failed', error instanceof Error ? error.message : 'unknown');
      return reply(request, env, { error: 'analysis_unavailable', reason: 'invalid_model_response' }, 502);
    }
  },
};
