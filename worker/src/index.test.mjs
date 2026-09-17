import test from 'node:test';
import assert from 'node:assert/strict';
import worker from './index.ts';

const analysis = {
  title: 'שילוב בין גישות',
  summary: 'בחירות בתחומים שונים משלבות כמה דרכי פעולה.',
  themes: [{ title: 'תמהיל', text: 'נבחרו פתרונות ממוקדים.', evidence: 'תחבורה וחינוך' }],
  tensions: [],
  caveat: 'זו קריאה אפשרית בלבד.',
};

function environment(modelResult) {
  const calls = [];
  const counterActions = [];
  return {
    calls,
    counterActions,
    env: {
      ALLOWED_ORIGIN: 'https://ronen-keisar.github.io',
      RATE_LIMIT_SALT: 'test-only',
      DAILY_ANALYSIS_LIMIT: '60',
      PER_VISITOR_DAILY_LIMIT: '8',
      AI: { async run(model, input) { calls.push({ model, input }); return modelResult; } },
      USAGE: {
        idFromName() { return 'test-counter'; },
        get() {
          return {
            async fetch(url) {
              counterActions.push(url.pathname ?? new URL(url).pathname);
              if (url.endsWith('/release')) return Response.json({ allowed: true });
              return Response.json({ allowed: true, total: 1 });
            },
          };
        },
      },
    },
  };
}

async function request(modelResult) {
  const { env, calls, counterActions } = environment(modelResult);
  const response = await worker.fetch(new Request('https://example.test/insights', {
    method: 'POST',
    headers: { Origin: 'https://ronen-keisar.github.io', 'Content-Type': 'application/json' },
    body: JSON.stringify({ consent: true, manifesto: 'מצע בדיקה ללא פרטים אישיים' }),
  }), env, { waitUntil() {} });
  return { response, calls, counterActions };
}

test('parses chat completion text and disables model thinking', async () => {
  const { response, calls } = await request({ choices: [{ message: { content: JSON.stringify(analysis) } }] });
  assert.equal(response.status, 200);
  assert.equal((await response.json()).analysis.title, analysis.title);
  assert.equal(calls[0].input.chat_template_kwargs.enable_thinking, false);
  assert.equal(calls[0].input.reasoning_effort, null);
  assert.equal(calls[0].input.max_completion_tokens, 900);
});

test('parses content block arrays', async () => {
  const { response } = await request({ choices: [{ message: { content: [{ type: 'text', text: JSON.stringify(analysis) }] } }] });
  assert.equal(response.status, 200);
});

test('returns a recoverable error for empty model output', async () => {
  const { response, counterActions } = await request({ choices: [{ message: { content: null, reasoning_content: 'internal' } }] });
  assert.equal(response.status, 502);
  assert.equal((await response.json()).reason, 'invalid_model_response');
  assert.deepEqual(counterActions, ['/reserve', '/release']);
});
