require('dotenv').config();

const MODELS = [
  'gemini-3.6-flash',
  'gemini-3.7-flash',
  'gemini-3.5-flash',
  'gemini-flash-latest',
  'gemini-3.8-flash',
];

async function ping(modelName) {
  const started = Date.now();
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }],
    }),
  });
  const payload = await res.json().catch(() => ({}));
  const text = ((payload.candidates || [])
    .flatMap(c => (c.content && c.content.parts) || [])
    .map(p => p.text || '')
    .join('') || '').trim();
  const err = (payload.error && payload.error.message) || '';
  return {
    model: modelName,
    status: res.status,
    ms: Date.now() - started,
    ok: Boolean(text),
    text: text.slice(0, 40),
    err: err.slice(0, 120),
  };
}

async function main() {
  if (!process.env.GEMINI_API_KEY) {
    console.error('NO_KEY');
    process.exit(1);
  }
  for (const modelName of MODELS) {
    try {
      const result = await ping(modelName);
      console.log(JSON.stringify(result));
    } catch (err) {
      console.log(JSON.stringify({
        model: modelName,
        status: 0,
        ok: false,
        err: (err.message || String(err)).slice(0, 160),
      }));
    }
  }
}

main();
