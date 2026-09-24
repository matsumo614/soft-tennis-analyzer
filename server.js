require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const crypto = require('crypto');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const { createClient } = require('@supabase/supabase-js');
const { Agent, setGlobalDispatcher } = require('undici');

// 長い音声の文字起こしは応答が返るまで5分以上かかることがある。
// Node標準fetchの既定値（headersTimeout 300秒）のままだと途中で fetch failed になるため引き上げる。
setGlobalDispatcher(new Agent({
  connectTimeout: 30_000,
  headersTimeout: 20 * 60_000,
  bodyTimeout: 20 * 60_000,
}));

// ─── 起動チェック ────────────────────────────────────────────────────────────
if (!process.env.GEMINI_API_KEY) {
  console.error('\n❌ GEMINI_API_KEY が設定されていません。');
  console.error('   .env ファイルを作成して GEMINI_API_KEY を設定してください。\n');
  process.exit(1);
}

// ─── 初期化 ──────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3001;

// Renderダッシュボードの古い環境変数が render.yaml より優先される。
// lite は文字起こしが繰り返しループするため、名前に lite が付くモデルは使わない。
function parseModelList(raw, defaults) {
  const list = String(raw || '')
    .split(',')
    .map(name => name.trim())
    .filter(Boolean);
  return list.length ? list : defaults;
}

function isLiteModel(name) {
  return /lite/i.test(name || '');
}

function isUnavailableModelName(name) {
  return /^gemini-2\.5-/.test(name || '') || /^gemini-2\.0-/.test(name || '');
}

function sanitizeModels(names) {
  const unique = [];
  for (const name of names) {
    if (!name || isLiteModel(name) || isUnavailableModelName(name)) continue;
    if (!unique.includes(name)) unique.push(name);
  }
  return unique;
}

const HTML_MODEL_DEFAULTS = ['gemini-3.5-flash', 'gemini-3.6-flash', 'gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.7-flash'];
const JSON_MODELS = [
  'gemini-3.5-flash-lite',
  'gemini-3.5-flash',
  'gemini-flash-lite-latest',
  'gemini-3.6-flash',
  'gemini-flash-latest',
  'gemini-3.8-flash',
];
const TRANSCRIBE_MODEL_DEFAULTS = ['gemini-3.5-transcribe', 'gemini-3.7-flash', 'gemini-3.6-flash', 'gemini-flash-latest'];

const HTML_MODELS = sanitizeModels([
  ...HTML_MODEL_DEFAULTS,
  ...parseModelList(process.env.GEMINI_MODEL, []),
  ...parseModelList(process.env.GEMINI_FALLBACK_MODELS, []),
]);
const MODEL = HTML_MODELS[0] || 'gemini-flash-latest';
const FALLBACK_MODELS = (HTML_MODELS.length > 1 ? HTML_MODELS.slice(1) : HTML_MODEL_DEFAULTS)
  .filter(name => name !== MODEL);

const TRANSCRIPTION_MODELS = (() => {
  const models = sanitizeModels(
    parseModelList(process.env.GEMINI_TRANSCRIPTION_MODELS, TRANSCRIBE_MODEL_DEFAULTS)
  );
  return models.length ? models : TRANSCRIBE_MODEL_DEFAULTS;
})();
if (process.env.GEMINI_MODEL && isLiteModel(process.env.GEMINI_MODEL)) {
  console.warn(
    `[gemini] GEMINI_MODEL=${process.env.GEMINI_MODEL} は文字起こしがループするため無視し、`
    + `${MODEL} を使います`
  );
}

// Geminiの入力上限は1,048,576トークン。安全マージンを取った値で事前に弾く
const MAX_INPUT_TOKENS = 900000;
// 文字起こしが繰り返しループに陥ったとき、後続プロンプトが膨張するのを防ぐ上限
const MAX_TRANSCRIPTION_CHARS = 60000;

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const upload = multer({
  dest: path.join(__dirname, 'uploads'),
  limits: { fileSize: 500 * 1024 * 1024 },
});

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const fileManager = new GoogleAIFileManager(process.env.GEMINI_API_KEY);

const supabase = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

if (supabase) {
  console.log('✅ Supabase接続: 有効');
} else {
  console.warn('⚠️  Supabase未設定: DB保存はスキップされます');
}

const BASE_TEMPLATE = fs.readFileSync(
  path.join(__dirname, 'templates', 'base.html'),
  'utf-8'
);

// ─── プロンプト ───────────────────────────────────────────────────────────────

// 音声の忠実な文字起こし用プロンプト
const TRANSCRIPTION_PROMPT = `この音声ファイルはソフトテニスのコーチが試合動画を見ながら行った解説・コーチングの録音です。

以下のルールに従って文字起こしをしてください：
- 話された言葉を**編集や要約を一切加えず**、すべて忠実に書き起こす
- 「えー」「あの」「うん」などの言い淀みもそのまま含める
- 話し言葉（「〜っすね」「〜かな」など）もそのまま書く
- 時間的な言及（「今のシーン」「ここ」など）もそのまま残す
- 段落分けは話題が変わるタイミングで行う
- 文字起こしのテキストのみ出力する（説明文や「以下が文字起こしです」のような前書きは不要）`;

const {
  parseFeedbackJson,
  renderFeedbackHTML,
  buildFeedbackPrompt,
} = require('./feedback-page');

// ─── Gemini呼び出し ───────────────────────────────────────────────────────────

// モデルの混雑（503）やレート制限（429）は数十秒待てば復旧することが多い。
// 待っても直らない場合は代替モデルに切り替えて生成を完了させる。
const RETRYABLE_ERROR = /\b(429|500|502|503|504)\b|fetch failed|Error fetching|aborted|ECONNRESET|ETIMEDOUT|overloaded|rate limit|応答しませんでした|high demand/i;

const jobs = new Map();

function createJob() {
  const id = crypto.randomUUID();
  jobs.set(id, { status: 'running', createdAt: Date.now(), message: '処理を開始しました' });
  return id;
}

function updateJob(id, patch) {
  const current = jobs.get(id) || { status: 'running', createdAt: Date.now() };
  jobs.set(id, { ...current, ...patch });
}

function completeJob(id, result) {
  updateJob(id, { status: 'done', result, error: null });
}

function failJob(id, err) {
  updateJob(id, { status: 'error', error: err.message || String(err) });
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} が ${Math.round(ms / 1000)}秒以内に応答しませんでした`)),
      ms
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// 廃止されたモデルは待っても復旧しない。再試行せず次のモデルへ進み、
// この404が本来の失敗原因（混雑など）を覆い隠さないようにする。
const UNAVAILABLE_MODEL_ERROR = /\b404\b|not found|no longer available/i;

function looksLikeTranscriptionLoop(text) {
  if (!text || text.length < 1500) return false;
  const sampleSize = 160;
  const start = Math.min(Math.floor(text.length * 0.15), text.length - sampleSize);
  const sample = text.slice(start, start + sampleSize);
  if (sample.trim().length < 40) return false;
  let occurrences = 0;
  for (let index = 0; (index = text.indexOf(sample, index)) !== -1; index += sampleSize) {
    occurrences += 1;
    if (occurrences >= 6) return true;
  }
  return false;
}

function transcriptionPartToText(transcription) {
  if (!transcription) return '';
  if (typeof transcription === 'string') return transcription.trim();
  if (typeof transcription.text === 'string' && transcription.text.trim()) return transcription.text.trim();
  if (typeof transcription.transcript === 'string' && transcription.transcript.trim()) {
    return transcription.transcript.trim();
  }
  const words = transcription.words || [];
  return words
    .map(word => (typeof word === 'string' ? word : word.word || word.text || ''))
    .join('')
    .trim();
}

function extractGenerateContentText(payload) {
  const chunks = [];
  for (const candidate of payload?.candidates || []) {
    for (const part of candidate?.content?.parts || []) {
      if (part.text) chunks.push(part.text);
      const fromAudio = transcriptionPartToText(part.audioTranscription || part.audio_transcription);
      if (fromAudio) chunks.push(fromAudio);
    }
    const fromCandidate = transcriptionPartToText(
      candidate.audioTranscription || candidate.audio_transcription
    );
    if (fromCandidate) chunks.push(fromCandidate);
  }
  return chunks.join('\n').trim();
}

function toGenerateBody(parts, generationConfig) {
  const contentParts = typeof parts === 'string' ? [{ text: parts }] : parts;
  const body = { contents: [{ role: 'user', parts: contentParts }] };
  if (generationConfig) body.generationConfig = generationConfig;
  return body;
}

async function postGenerateContent(modelName, body, timeoutMs = 180_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const payload = await res.json().catch(() => ({}));
    if (!res.ok) {
      const message = payload?.error?.message || `HTTP ${res.status}`;
      throw new Error(`[${res.status}] ${message}`);
    }
    const text = extractGenerateContentText(payload);
    if (!text) {
      const finish = payload?.candidates?.[0]?.finishReason || payload?.candidates?.[0]?.finish_reason || '-';
      const block = payload?.promptFeedback?.blockReason || payload?.promptFeedback?.block_reason || '-';
      const partKeys = (payload?.candidates?.[0]?.content?.parts || [])
        .map(part => Object.keys(part || {}).join(','))
        .join('|') || 'none';
      throw new Error(`生成結果が空でした (finish=${finish} block=${block} parts=${partKeys})`);
    }
    return text;
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`${modelName} が ${Math.round(timeoutMs / 1000)}秒以内に応答しませんでした`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function generateUntilDeadline(parts, {
  models = JSON_MODELS,
  deadlineMs = 10 * 60 * 1000,
  timeoutMs = 90_000,
  generationConfig = null,
  onProgress,
} = {}) {
  const started = Date.now();
  const skipped = new Set();
  let round = 0;
  let lastError = new Error('生成に失敗しました');

  while (Date.now() - started < deadlineMs) {
    const available = models.filter(name => name && !skipped.has(name));
    if (available.length === 0) break;
    const modelName = available[round % available.length];
    round += 1;
    const elapsedMin = Math.floor((Date.now() - started) / 60000);
    const elapsedSec = String(Math.floor(((Date.now() - started) % 60000) / 1000)).padStart(2, '0');
    if (onProgress) {
      onProgress(`混雑時は自動で待ちます（${elapsedMin}分${elapsedSec}秒 / ${modelName}）`);
    }
    try {
      const text = await postGenerateContent(
        modelName,
        toGenerateBody(parts, generationConfig),
        timeoutMs
      );
      console.log(`[gemini] ${modelName} で生成成功 round=${round}`);
      return text;
    } catch (err) {
      const message = err.message || String(err);
      lastError = err;
      console.warn(`[gemini] ${modelName} 失敗: ${message.slice(0, 180)}`);
      if (UNAVAILABLE_MODEL_ERROR.test(message)) {
        skipped.add(modelName);
        continue;
      }
      if (!RETRYABLE_ERROR.test(message) && !/応答しませんでした|timeout|JSON/i.test(message)) {
        throw err;
      }
      const waitMs = Math.min(45_000, 8000 + 7000 * Math.floor((round - 1) / Math.max(available.length, 1)));
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
  }

  throw new Error(`混雑が解消せず生成できませんでした（${(lastError.message || String(lastError)).slice(0, 180)}）`);
}

async function generateFeedbackHtml({ playerName, date, playerNotes, transcription, onProgress }) {
  const prompt = buildFeedbackPrompt({ playerName, date, playerNotes, transcription });
  let raw;
  try {
    raw = await generateUntilDeadline(prompt, {
      models: JSON_MODELS,
      deadlineMs: 10 * 60 * 1000,
      generationConfig: { responseMimeType: 'application/json' },
      onProgress,
    });
  } catch (err) {
    console.warn('[feedback] JSON指定での生成に失敗したため、指定なしで再試行:', (err.message || '').slice(0, 160));
    raw = await generateUntilDeadline(prompt, {
      models: JSON_MODELS,
      deadlineMs: 8 * 60 * 1000,
      generationConfig: null,
      onProgress,
    });
  }
  const data = parseFeedbackJson(raw);
  return renderFeedbackHTML({
    playerName,
    date,
    matchInfo: data.matchInfo,
    summary: data.summary,
    goods: data.goods,
    improvements: data.improvements,
    drills: data.drills,
  });
}

const TENNIS_VOCAB = [
  'ソフトテニス', '前衛', '後衛', 'カットサーブ', 'スライス', 'ドライブ',
  'ロブ', 'ボレー', 'スマッシュ', 'レシーブ', 'サービスダッシュ',
  '軸足', '打点', '重心', 'テンポ', 'フォア', 'バックハンド', 'フォアハンド',
];

function isTranscribeModel(name) {
  return /transcribe/i.test(name || '');
}

async function transcribeWithAsrModel(modelName, audioPart) {
  const bodies = [
    { contents: [{ parts: [audioPart] }] },
    {
      contents: [{ parts: [audioPart] }],
      generationConfig: {
        audioTranscriptionConfig: { languageCodes: ['ja-JP'] },
      },
    },
    {
      contents: [{ parts: [audioPart] }],
      generationConfig: {
        audioTranscriptionConfig: {
          languageCodes: ['ja-JP'],
          mode: 'SMART',
        },
      },
    },
    {
      contents: [{ parts: [audioPart] }],
      generationConfig: {
        audioTranscriptionConfig: {
          languageCodes: ['ja-JP'],
          mode: 'VERBATIM',
          customVocabulary: TENNIS_VOCAB,
        },
      },
    },
  ];

  let lastError;
  for (const body of bodies) {
    try {
      return await postGenerateContent(modelName, body, 180_000);
    } catch (err) {
      lastError = err;
      const message = err.message || '';
      if (UNAVAILABLE_MODEL_ERROR.test(message)) throw err;
      console.warn(`[audio] ${modelName} の設定を緩めて再試行: ${message.slice(0, 160)}`);
    }
  }
  throw lastError;
}

async function transcribeAudio(audioPart, onProgress) {
  const models = TRANSCRIPTION_MODELS.length ? TRANSCRIPTION_MODELS : TRANSCRIBE_MODEL_DEFAULTS;
  const started = Date.now();
  const deadlineMs = 8 * 60 * 1000;
  let round = 0;
  let lastError = new Error('音声の文字起こしに失敗しました');

  while (Date.now() - started < deadlineMs) {
    const modelName = models[round % models.length];
    round += 1;
    if (onProgress) {
      onProgress(`音声を文字起こし中です（${modelName}・${round}回目）`);
    }
    try {
      const text = isTranscribeModel(modelName)
        ? await transcribeWithAsrModel(modelName, audioPart)
        : await postGenerateContent(
            modelName,
            toGenerateBody([audioPart, { text: TRANSCRIPTION_PROMPT }], null),
            180_000
          );
      if (looksLikeTranscriptionLoop(text)) {
        lastError = new Error(`${modelName}: 繰り返し出力`);
        continue;
      }
      if (text.length < 20) {
        lastError = new Error(`${modelName}: 結果が短すぎる`);
        continue;
      }
      return text;
    } catch (err) {
      lastError = err;
      console.warn(`[audio] ${modelName} 失敗: ${(err.message || String(err)).slice(0, 200)}`);
      await new Promise(resolve => setTimeout(resolve, Math.min(40000, 8000 * Math.min(round, 4))));
    }
  }

  throw new Error(`音声の文字起こしに失敗しました（${(lastError.message || String(lastError)).slice(0, 180)}）`);
}

// ─── ユーティリティ ────────────────────────────────────────────────────────────

// ブラウザやcurlは .m4a などを application/octet-stream として送ってくることがある。
// その値をそのままGeminiに渡すと音声ではなく生バイト列として解釈され、
// 40MBの音声で1,048,576トークンを超えて 400 エラーになる。拡張子から必ず補正する。
const AUDIO_MIME_BY_EXT = {
  '.m4a': 'audio/mp4',
  '.mp4': 'audio/mp4',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.aac': 'audio/aac',
  '.flac': 'audio/flac',
  '.ogg': 'audio/ogg',
  '.oga': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.aif': 'audio/aiff',
  '.aiff': 'audio/aiff',
  '.webm': 'audio/webm',
};

function resolveAudioMimeType(originalName, reportedMimeType) {
  const byExt = AUDIO_MIME_BY_EXT[path.extname(originalName || '').toLowerCase()];
  if (byExt) return byExt;
  if (reportedMimeType && reportedMimeType.startsWith('audio/')) return reportedMimeType;
  return null;
}

function generateSlug(playerName, date) {
  // 日本語を含む名前はローマ字風の短縮形に変換（Surgeドメインは英数字のみ）
  const cleanName = (playerName || 'player')
    .replace(/\s+/g, '-')
    .replace(/[^\x00-\x7F]/g, '') // 非ASCII文字を除去
    .replace(/[^a-zA-Z0-9-]/g, '')
    .toLowerCase()
    .substring(0, 15) || 'player';
  const dateStr = (date || new Date().toISOString().slice(0, 10)).replace(/[\/\-]/g, '');
  const rand = Math.random().toString(36).slice(2, 5);
  return `tennis-${cleanName}-${dateStr}-${rand}`;
}

function buildHTML(contentHTML, title, description) {
  return BASE_TEMPLATE
    .replace(/<!-- TITLE -->/g, title)
    .replace(/<!-- DESCRIPTION -->/g, description)
    .replace('<!-- CONTENT_START -->', `<!-- CONTENT_START -->\n${contentHTML}`)
    .replace('<!-- CONTENT_END -->', '<!-- CONTENT_END -->');
}

function appBaseUrl() {
  return (process.env.RENDER_EXTERNAL_URL || 'https://soft-tennis-analyzer.onrender.com').replace(/\/$/, '');
}

function deployToSurge(htmlFilePath, slug) {
  const domain = `diagram-${slug}.surge.sh`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surge-'));

  try {
    fs.copyFileSync(htmlFilePath, path.join(tempDir, 'index.html'));
    fs.writeFileSync(path.join(tempDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

    const surgeEnv = { ...process.env };
    if (process.env.SURGE_TOKEN) surgeEnv.SURGE_TOKEN = process.env.SURGE_TOKEN;
    if (process.env.SURGE_LOGIN) surgeEnv.SURGE_LOGIN = process.env.SURGE_LOGIN;

    execSync(`npx --yes surge "${tempDir}" --domain "${domain}"`, {
      timeout: 90000,
      stdio: 'pipe',
      env: surgeEnv,
    });

    const url = `https://${domain}`;
    const logEntry = `${new Date().toISOString()} | ${slug} | ${url}\n`;
    fs.appendFileSync(path.join(__dirname, 'deploy-history.log'), logEntry);

    return url;
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function cleanGeneratedHTML(raw) {
  return raw
    .trim()
    .replace(/^```html\n?/, '')
    .replace(/^```\n?/, '')
    .replace(/\n?```$/, '');
}

async function persistFeedback({ playerName, date, playerNotes, transcription, htmlContent, logLabel }) {
  const slug = generateSlug(playerName, date);
  const displayName = playerName ? `${playerName}選手` : '選手';
  const title = `${displayName}へのフィードバック`;
  const description = `ソフトテニス試合フィードバック（${date || ''}）`;
  const finalHTML = buildHTML(htmlContent, title, description);

  const outputDir = path.join(__dirname, 'output');
  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
  const filePath = path.join(outputDir, `${slug}.html`);
  fs.writeFileSync(filePath, finalHTML, 'utf-8');

  let surgeUrl = null;
  let deployError = null;
  try {
    surgeUrl = deployToSurge(filePath, slug);
  } catch (err) {
    deployError = err.message;
    console.warn(`[${logLabel}] Surgeデプロイ失敗: ${(deployError || '').slice(0, 200)}`);
  }

  let pageId = slug;
  if (supabase) {
    try {
      const { data: row, error: dbError } = await supabase.from('feedbacks').insert({
        player_name: playerName || '不明',
        match_date: date || null,
        match_info: null,
        transcription_text: transcription,
        player_notes: playerNotes || null,
        html_content: finalHTML,
        surge_url: surgeUrl,
      }).select('id').maybeSingle();
      if (dbError) console.error(`[${logLabel}] DB保存エラー:`, dbError.message);
      else {
        console.log(`[${logLabel}] DB保存完了`);
        if (row && row.id) pageId = row.id;
      }
    } catch (dbErr) {
      console.error(`[${logLabel}] DB保存例外:`, dbErr.message);
    }
  }

  const hostedUrl = `${appBaseUrl()}/f/${pageId}`;
  return {
    success: true,
    url: surgeUrl || hostedUrl,
    hostedUrl,
    localFile: filePath,
    error: surgeUrl ? null : deployError,
  };
}

// ─── テキストから生成 ─────────────────────────────────────────────────────────
app.post('/api/generate-text', async (req, res) => {
  const { text, playerName, date, playerNotes } = req.body;

  if (!text || text.trim().length < 20) {
    return res.status(400).json({ error: 'テキストが短すぎます（20文字以上必要です）' });
  }

  const jobId = createJob();
  res.json({ jobId, status: 'running' });

  (async () => {
    try {
      const htmlContent = await generateFeedbackHtml({
        playerName,
        date,
        playerNotes,
        transcription: text,
        onProgress: message => updateJob(jobId, { message }),
      });
      const payload = await persistFeedback({
        playerName,
        date,
        playerNotes,
        transcription: text,
        htmlContent,
        logLabel: 'generate-text',
      });
      completeJob(jobId, payload);
    } catch (err) {
      console.error('[generate-text]', err);
      failJob(jobId, new Error(`生成に失敗しました: ${err.message}`));
    }
  })();
});

// ─── 音声から生成（2ステップ：忠実な文字起こし → フィードバック生成） ────────
// multer のエラー（サイズ超過など）をハンドラー内で捕捉して JSON で返す
function withMulter(handler) {
  return (req, res, next) => {
    upload.single('audio')(req, res, (err) => {
      if (err) {
        console.error('[multer error]', err.message);
        if (err.code === 'LIMIT_FILE_SIZE') {
          return res.status(413).json({ error: 'ファイルサイズが大きすぎます（最大500MB）' });
        }
        return res.status(400).json({ error: `ファイルのアップロードに失敗しました: ${err.message}` });
      }
      handler(req, res, next);
    });
  };
}

app.post('/api/generate-audio', withMulter(async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '音声ファイルが見つかりません' });
  }

  const { playerName, date, playerNotes } = req.body;
  const audioPath = req.file.path;
  const originalName = req.file.originalname;
  const fileSize = req.file.size;
  const reportedMime = req.file.mimetype;
  const mimeType = resolveAudioMimeType(originalName, reportedMime);

  if (!mimeType) {
    fs.unlink(audioPath, () => {});
    return res.status(400).json({
      error: `対応していない音声形式です（${originalName || 'ファイル名不明'}）。`
        + 'm4a・mp3・wav・aac・flac のいずれかをアップロードしてください。',
    });
  }

  const jobId = createJob();
  res.json({ jobId, status: 'running' });

  (async () => {
  console.log(
    `[audio] ${originalName} / ${(fileSize / 1024 / 1024).toFixed(1)}MB`
    + ` / 受信mime=${reportedMime} → 使用mime=${mimeType}`
  );

  let uploadedFileName = null;

  try {
    // Step 1: Gemini File APIにアップロード
    const uploadResult = await fileManager.uploadFile(audioPath, {
      mimeType,
      displayName: req.file.originalname || 'coaching-audio',
    });
    uploadedFileName = uploadResult.file.name;

    // ファイルがACTIVEになるまで待つ（最大5分）
    let file = await fileManager.getFile(uploadedFileName);
    let attempts = 0;
    while (file.state === 'PROCESSING' && attempts < 60) {
      await new Promise(r => setTimeout(r, 5000));
      file = await fileManager.getFile(uploadedFileName);
      attempts++;
    }

    if (file.state === 'FAILED') {
      throw new Error('Geminiが音声ファイルの読み込みに失敗しました。別形式（m4a / mp3）で再アップロードしてください。');
    }
    if (file.state !== 'ACTIVE') {
      throw new Error('音声ファイルの処理がタイムアウトしました。少し待ってから再実行してください。');
    }

    const audioPart = { fileData: { mimeType: mimeType || file.mimeType, fileUri: file.uri } };

    try {
      const countingModel = genAI.getGenerativeModel({ model: MODEL });
      const { totalTokens } = await countingModel.countTokens([audioPart, { text: TRANSCRIPTION_PROMPT }]);
      console.log(`[audio] 入力トークン数: ${totalTokens}`);
      if (totalTokens > MAX_INPUT_TOKENS) {
        const limitMinutes = Math.floor(MAX_INPUT_TOKENS / 32 / 60);
        throw new Error(
          `音声が長すぎてAIが一度に処理できません（上限の約${limitMinutes}分を超えています）。`
          + '音声を分割してアップロードしてください。'
        );
      }
    } catch (err) {
      if (/長すぎて/.test(err.message || '')) throw err;
      console.warn(`[audio] トークン数の事前確認をスキップ: ${(err.message || String(err)).slice(0, 160)}`);
    }

    // Step 2: 専用ASR → 失敗時のみ汎用Flashで文字起こし
    let transcription = await transcribeAudio(audioPart, message => updateJob(jobId, { message }));

    if (transcription.length > MAX_TRANSCRIPTION_CHARS) {
      console.warn(`[audio] 文字起こしが異常に長いため切り詰めます: ${transcription.length}文字`);
      transcription = transcription.slice(0, MAX_TRANSCRIPTION_CHARS);
    }

    console.log(`[audio] 文字起こし完了: ${transcription.length}文字`);
    updateJob(jobId, { message: '文字起こし完了。図解を生成しています...' });

    const htmlContent = await generateFeedbackHtml({
      playerName,
      date,
      playerNotes,
      transcription,
      onProgress: message => updateJob(jobId, { message }),
    });
    const payload = await persistFeedback({
      playerName,
      date,
      playerNotes,
      transcription,
      htmlContent,
      logLabel: 'generate-audio',
    });
    completeJob(jobId, payload);
  } catch (err) {
    console.error('[generate-audio]', err);
    failJob(jobId, new Error(`処理に失敗しました: ${err.message}`));
  } finally {
    if (uploadedFileName) {
      fileManager.deleteFile(uploadedFileName).catch(() => {});
    }
    fs.unlink(audioPath, () => {});
  }
  })();
}));

app.get('/f/:id', async (req, res) => {
  const id = req.params.id;
  const bySlug = path.join(__dirname, 'output', `${id}.html`);
  if (fs.existsSync(bySlug)) {
    return res.sendFile(bySlug);
  }

  if (supabase) {
    try {
      const { data, error } = await supabase
        .from('feedbacks')
        .select('html_content')
        .eq('id', id)
        .maybeSingle();
      if (!error && data && data.html_content) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return res.send(data.html_content);
      }
    } catch (err) {
      console.error('[f/:id]', err.message);
    }
  }

  res.status(404).send('フィードバックが見つかりません');
});

app.get('/api/jobs/:id', (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) {
    return res.status(404).json({ error: '処理が見つかりません。ページを再読み込みしてやり直してください。' });
  }
  res.json(job);
});

// ─── 履歴取得 ─────────────────────────────────────────────────────────────────
// 一覧では文字起こし本文を返さない（全件分を含めるとレスポンスが数百KBに膨らむため、
// 本文は「文字起こしを見る」を押したときに個別取得する）
app.get('/api/history', async (req, res) => {
  if (!supabase) return res.json({ feedbacks: [] });
  try {
    const { data, error } = await supabase
      .from('feedbacks')
      .select('id, player_name, match_date, surge_url, created_at')
      .order('created_at', { ascending: false });
    if (error) console.error('[history] supabase error:', error.message);
    res.json({ feedbacks: data || [] });
  } catch (err) {
    console.error('[history] fetch error:', err.message);
    res.json({ feedbacks: [] });
  }
});

app.get('/api/history/:id/transcription', async (req, res) => {
  if (!supabase) return res.status(503).json({ error: 'データベースが設定されていません' });
  try {
    const { data, error } = await supabase
      .from('feedbacks')
      .select('transcription_text')
      .eq('id', req.params.id)
      .maybeSingle();
    if (error) {
      console.error('[transcription] supabase error:', error.message);
      return res.status(500).json({ error: '文字起こしの取得に失敗しました' });
    }
    res.json({ transcription: (data && data.transcription_text) || '' });
  } catch (err) {
    console.error('[transcription] fetch error:', err.message);
    res.status(500).json({ error: '文字起こしの取得に失敗しました' });
  }
});

app.get('/api/history/:playerName', async (req, res) => {
  if (!supabase) return res.json({ feedbacks: [] });
  try {
    const { data, error } = await supabase
      .from('feedbacks')
      .select('id, player_name, match_date, surge_url, created_at, transcription_text')
      .eq('player_name', req.params.playerName)
      .order('created_at', { ascending: false });
    if (error) console.error('[history/:playerName] supabase error:', error.message);
    res.json({ feedbacks: data || [] });
  } catch (err) {
    console.error('[history/:playerName] fetch error:', err.message);
    res.json({ feedbacks: [] });
  }
});

// ─── ヘルスチェック ────────────────────────────────────────────────────────────
app.get('/api/health', async (_, res) => {
  let dbStatus = 'not_configured';
  let rawFetchStatus = 'not_tested';

  if (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY) {
    // supabase-jsクライアント経由のテスト
    if (supabase) {
      try {
        const { data, error } = await supabase.from('feedbacks').select('id').limit(1);
        dbStatus = error ? `supabase_error: ${error.message}` : 'ok';
      } catch (e) {
        dbStatus = `exception: ${e.message}`;
      }
    }

    // 生のfetchでSupabase REST APIに直接アクセス
    try {
      const url = `${process.env.SUPABASE_URL}/rest/v1/feedbacks?select=id&limit=1`;
      const r = await fetch(url, {
        headers: {
          apikey: process.env.SUPABASE_ANON_KEY,
          Authorization: `Bearer ${process.env.SUPABASE_ANON_KEY}`,
        },
      });
      rawFetchStatus = `${r.status} ${r.statusText}`;
    } catch (e) {
      rawFetchStatus = `fetch_error: ${e.message}`;
    }
  }

  res.json({
    status: 'ok',
    model: MODEL,
    fallbackModels: FALLBACK_MODELS,
    transcriptionModels: TRANSCRIPTION_MODELS,
    envModel: process.env.GEMINI_MODEL || null,
    node: process.version,
    db: !!supabase,
    dbStatus,
    rawFetchStatus,
  });
});

app.get('/api/self-test', async (_, res) => {
  const results = [];
  for (const modelName of [MODEL, ...FALLBACK_MODELS].slice(0, 5)) {
    try {
      const text = await postGenerateContent(
        modelName,
        toGenerateBody('Reply with the single word OK.', null),
        45_000
      );
      results.push({ model: modelName, ok: true, text: text.slice(0, 40) });
      return res.json({ ok: true, used: modelName, results });
    } catch (err) {
      results.push({ model: modelName, ok: false, error: (err.message || String(err)).slice(0, 160) });
    }
  }
  res.status(503).json({ ok: false, results });
});

// ─── グローバルエラーハンドラー ───────────────────────────────────────────────
// multer・express.json などミドルウェアが next(err) を呼んだ場合も
// HTML ではなく JSON で返す（フロントエンドの JSON.parse エラーを防ぐ）
app.use((err, req, res, next) => {
  console.error('[unhandled error]', err.message || err);

  // multer のファイルサイズ超過エラー
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'ファイルサイズが大きすぎます（最大500MB）' });
  }
  // express.json のリクエストボディ超過エラー
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'リクエストデータが大きすぎます' });
  }
  // express.json の JSON 解析エラー
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'リクエストの形式が正しくありません' });
  }

  const status = err.status || err.statusCode || 500;
  res.status(status).json({ error: err.message || '予期しないエラーが発生しました' });
});

// ─── 起動 ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n✅ ソフトテニス フィードバック生成ツール 起動');
  console.log(`   ブラウザで開く → http://localhost:${PORT}`);
  console.log(`   使用モデル: ${MODEL}\n`);
});
