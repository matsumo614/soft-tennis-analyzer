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

const HTML_MODEL_DEFAULTS = ['gemini-flash-latest', 'gemini-3.8-flash', 'gemini-3.6-flash'];
const TRANSCRIBE_MODEL_DEFAULTS = ['gemini-3.5-transcribe', 'gemini-flash-latest', 'gemini-3.8-flash'];

const HTML_MODELS = sanitizeModels([
  ...parseModelList(process.env.GEMINI_MODEL, []),
  ...parseModelList(process.env.GEMINI_FALLBACK_MODELS, HTML_MODEL_DEFAULTS),
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

const SYSTEM_PROMPT = `あなたはソフトテニスのコーチングフィードバックを視覚的なHTMLページに変換する専門家です。

コーチング内容を分析し、HTMLページのbody部分（<!-- CONTENT_START --> と <!-- CONTENT_END --> の間に入るHTML）を生成してください。

## デザイン仕様（厳守）
- Tailwind CSSクラスのみ使用（インラインstyle禁止、<style>タグ禁止）
- カスタムカラー: ads-accent（青）, ads-accent-light, ads-surface（薄グレー）, ads-border, ads-muted, ads-dim
- 標準Tailwindカラー: emerald（緑）, red（赤）, amber（黄）, slate
  例: text-emerald-600, bg-emerald-500/5, border-emerald-500/20, text-red-600, bg-red-500/5
- Lucideアイコン: <i data-lucide="アイコン名" class="w-4 h-4"></i>
  使用可能: check, x, check-circle, x-circle, activity, star, target, trophy, arrow-right, zap, alert-circle, info, chevron-right
- <script>タグ禁止、アニメーション禁止、インタラクティブ要素禁止

## 必須セクション（この順番で）

### 1. ヒーロー
\`\`\`
<div class="text-center mb-8 md:mb-10">
  <div class="inline-flex items-center gap-2 bg-ads-accent/10 text-ads-accent-light px-4 py-1.5 rounded-full text-sm font-medium mb-6">
    <i data-lucide="activity" class="w-4 h-4"></i>
    ソフトテニス コーチング
  </div>
  <h1 class="text-3xl md:text-5xl font-black text-slate-900 tracking-tight mb-4">
    [選手名]選手への<br><span class="text-ads-accent-light">フィードバック</span>
  </h1>
  <p class="text-sm text-ads-dim mb-4">[日付] ／ [試合情報があれば]</p>
  <div class="bg-ads-surface border border-ads-border rounded-2xl p-5 max-w-xl mx-auto text-left">
    <p class="text-xs font-bold text-ads-muted mb-1">ひとことまとめ</p>
    <p class="text-lg font-black text-slate-900">[核心を1文で]</p>
  </div>
</div>
\`\`\`

### 2. 良かった点
\`\`\`
<div class="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-6 md:p-8 mb-6">
  <div class="flex items-center gap-3 mb-5">
    <div class="bg-emerald-500/10 text-emerald-600 p-2 rounded-lg">
      <i data-lucide="star" class="w-5 h-5"></i>
    </div>
    <h2 class="text-xl font-black text-slate-900">良かった点</h2>
  </div>
  <ul class="space-y-3">
    <li class="flex items-start gap-3">
      <i data-lucide="check" class="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0"></i>
      <div>
        <p class="font-bold text-slate-900 text-sm">[タイトル]</p>
        <p class="text-sm text-ads-muted mt-0.5">[具体的な説明]</p>
      </div>
    </li>
    [3〜5個繰り返す]
  </ul>
</div>
\`\`\`

### 3. 改善ポイント
各ポイントをカード形式で（2〜4個）：
\`\`\`
<div class="mb-6">
  <div class="flex items-center gap-3 mb-4">
    <div class="bg-ads-accent/10 text-ads-accent-light p-2 rounded-lg">
      <i data-lucide="target" class="w-5 h-5"></i>
    </div>
    <h2 class="text-xl font-black text-slate-900">改善ポイント</h2>
  </div>
  <div class="space-y-4">
    <div class="bg-ads-surface border border-ads-border rounded-2xl p-5 md:p-6">
      <h3 class="font-black text-slate-900 mb-4">[ポイントタイトル（技術用語を使う）]</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div class="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
          <div class="flex items-center gap-1.5 text-xs font-bold text-red-600 mb-2">
            <i data-lucide="x-circle" class="w-3.5 h-3.5"></i>今やっていること
          </div>
          <p class="text-sm text-slate-700">[具体的なNG内容]</p>
        </div>
        <div class="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
          <div class="flex items-center gap-1.5 text-xs font-bold text-emerald-600 mb-2">
            <i data-lucide="check-circle" class="w-3.5 h-3.5"></i>改善策
          </div>
          <p class="text-sm text-slate-700">[具体的な改善内容]</p>
        </div>
      </div>
      <p class="text-xs text-ads-muted mt-3">[コーチのアドバイスや補足があれば]</p>
    </div>
    [繰り返す]
  </div>
</div>
\`\`\`

### 4. 今すぐ取り組む練習ポイント
\`\`\`
<div class="bg-ads-surface border border-ads-border rounded-2xl p-6 md:p-8">
  <div class="flex items-center gap-3 mb-6">
    <div class="bg-ads-accent/10 text-ads-accent-light p-2 rounded-lg">
      <i data-lucide="zap" class="w-5 h-5"></i>
    </div>
    <h2 class="text-xl font-black text-slate-900">今すぐ取り組む練習ポイント</h2>
  </div>
  <div class="space-y-4">
    <div class="flex gap-4">
      <div class="bg-ads-accent text-white w-8 h-8 rounded-full flex items-center justify-center font-black text-sm flex-shrink-0 mt-0.5">1</div>
      <div>
        <p class="font-bold text-slate-900 text-sm mb-1">[練習タイトル]</p>
        <p class="text-sm text-ads-muted">[具体的な練習内容・意識すること]</p>
      </div>
    </div>
    [2, 3... 繰り返す]
  </div>
</div>
\`\`\`

## コンテンツ抽出のルール
- 入力されたコーチング内容から忠実に情報を抽出する（勝手に情報を作らない）
- 選手名・日付・対戦相手・結果があれば必ず反映する
- コーチが使った技術用語（軸足、重心、カットサーブ、前衛、後衛、テンポ、打点など）をそのまま使う
- 「〜がいい」「〜した方がいい」などコーチの具体的なアドバイスを忠実に反映する
- 話し言葉のまま引用するのではなく、要点を整理して書く
- 【選手の反省メモ】が提供されている場合は、それぞれの反省点に対してコーチの視点からのフィードバックを必ず含める
  - 選手の反省が「コーチの解説と一致している」場合 → その正しい気づきを肯定・強化する
  - 選手の反省が「コーチの解説に含まれていない新しい視点」の場合 → それに対しても具体的なフィードバックを追加する

## 出力形式
- HTMLのみ出力する（説明文・マークダウン記法・\`\`\`htmlは不要）
- 最初のHTML要素から直接始める
- <!-- CONTENT_START --> や <!-- CONTENT_END --> は含めない
`;

// ─── Gemini呼び出し ───────────────────────────────────────────────────────────

// モデルの混雑（503）やレート制限（429）は数十秒待てば復旧することが多い。
// 待っても直らない場合は代替モデルに切り替えて生成を完了させる。
const RETRYABLE_ERROR = /\b(429|500|502|503|504)\b|fetch failed|high demand|overloaded|rate limit|応答しませんでした/i;

const jobs = new Map();

function createJob() {
  const id = crypto.randomUUID();
  jobs.set(id, { status: 'running', createdAt: Date.now() });
  return id;
}

function completeJob(id, result) {
  jobs.set(id, { status: 'done', result, createdAt: Date.now() });
}

function failJob(id, err) {
  jobs.set(id, { status: 'error', error: err.message || String(err), createdAt: Date.now() });
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

function extractGenerateContentText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts || [];
  return parts.map(part => part.text || '').join('').trim();
}

async function generateContentWithRetry(parts, attemptsOrOpts = 3) {
  const attemptsPerModel = typeof attemptsOrOpts === 'number'
    ? attemptsOrOpts
    : (attemptsOrOpts.attemptsPerModel || 3);
  const modelNames = (typeof attemptsOrOpts === 'object' && attemptsOrOpts.models)
    ? attemptsOrOpts.models
    : [MODEL, ...FALLBACK_MODELS];
  const failures = [];

  for (const modelName of modelNames) {
    const model = genAI.getGenerativeModel({
      model: modelName,
      generationConfig: { thinkingConfig: { thinkingBudget: 0 } },
    });

    for (let attempt = 1; attempt <= attemptsPerModel; attempt++) {
      try {
        return await withTimeout(model.generateContent(parts), 75_000, modelName);
      } catch (err) {
        const message = err.message || String(err);

        if (/thinkingConfig|thinkingBudget/i.test(message)) {
          console.warn(`[gemini] ${modelName} は thinking 設定非対応のため、設定なしで再試行します`);
          try {
            return await withTimeout(
              genAI.getGenerativeModel({ model: modelName }).generateContent(parts),
              75_000,
              modelName
            );
          } catch (retryErr) {
            const retryMessage = retryErr.message || String(retryErr);
            if (!RETRYABLE_ERROR.test(retryMessage) && !UNAVAILABLE_MODEL_ERROR.test(retryMessage)) throw retryErr;
            failures.push(`${modelName}: ${retryMessage.slice(0, 120)}`);
            break;
          }
        }

        if (UNAVAILABLE_MODEL_ERROR.test(message)) {
          console.warn(`[gemini] ${modelName} は利用できないモデルです。代替モデルに切り替えます`);
          failures.push(`${modelName}: 利用不可`);
          break;
        }

        if (!RETRYABLE_ERROR.test(message)) throw err;

        if (attempt === attemptsPerModel) {
          console.warn(`[gemini] ${modelName} が復旧しないため代替モデルに切り替えます`);
          failures.push(`${modelName}: ${message.slice(0, 120)}`);
          break;
        }

        const waitMs = 5000 * attempt;
        console.warn(
          `[gemini] ${modelName} が一時エラー (${attempt}/${attemptsPerModel}): `
          + `${message.slice(0, 120)} — ${waitMs / 1000}秒後に再試行`
        );
        await new Promise(resolve => setTimeout(resolve, waitMs));
      }
    }
  }

  throw new Error(`すべてのモデルで生成に失敗しました（${failures.join(' / ')}）`);
}

const TENNIS_VOCAB = [
  'ソフトテニス', '前衛', '後衛', 'カットサーブ', 'スライス', 'ドライブ',
  'ロブ', 'ボレー', 'スマッシュ', 'レシーブ', 'サービスダッシュ',
  '軸足', '打点', '重心', 'テンポ', 'フォア', 'バックハンド', 'フォアハンド',
];

function isTranscribeModel(name) {
  return /transcribe/i.test(name || '');
}

async function postGenerateContent(modelName, body) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelName)}:generateContent?key=${encodeURIComponent(process.env.GEMINI_API_KEY)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    const message = payload?.error?.message || `HTTP ${res.status}`;
    throw new Error(`[${res.status}] ${message}`);
  }
  const text = extractGenerateContentText(payload);
  if (!text) throw new Error('文字起こし結果が空でした');
  return text;
}

async function transcribeWithAsrModel(modelName, audioPart) {
  const bodies = [
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
    {
      contents: [{ parts: [audioPart] }],
      generationConfig: {
        audioTranscriptionConfig: { languageCodes: ['ja-JP'] },
      },
    },
    { contents: [{ parts: [audioPart] }] },
  ];

  let lastError;
  for (const body of bodies) {
    try {
      return await postGenerateContent(modelName, body);
    } catch (err) {
      lastError = err;
      const message = err.message || '';
      if (RETRYABLE_ERROR.test(message) || UNAVAILABLE_MODEL_ERROR.test(message)) throw err;
      console.warn(`[audio] ${modelName} の設定を緩めて再試行: ${message.slice(0, 120)}`);
    }
  }
  throw lastError;
}

async function transcribeAudio(audioPart) {
  const models = TRANSCRIPTION_MODELS.length ? TRANSCRIPTION_MODELS : TRANSCRIBE_MODEL_DEFAULTS;
  const failures = [];

  for (const modelName of models) {
    try {
      console.log(`[audio] 文字起こし開始: ${modelName}`);
      const text = isTranscribeModel(modelName)
        ? await transcribeWithAsrModel(modelName, audioPart)
        : (await generateContentWithRetry(
            [audioPart, { text: TRANSCRIPTION_PROMPT }],
            { models: [modelName], attemptsPerModel: 3 }
          )).response.text().trim();

      if (looksLikeTranscriptionLoop(text)) {
        console.warn(`[audio] ${modelName} の文字起こしが繰り返しのため次のモデルへ`);
        failures.push(`${modelName}: 繰り返し出力`);
        continue;
      }
      if (text.length < 20) {
        failures.push(`${modelName}: 結果が短すぎる`);
        continue;
      }
      return text;
    } catch (err) {
      const message = err.message || String(err);
      console.warn(`[audio] ${modelName} 失敗: ${message.slice(0, 160)}`);
      failures.push(`${modelName}: ${message.slice(0, 120)}`);
    }
  }

  throw new Error(`音声の文字起こしに失敗しました（${failures.join(' / ')}）`);
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

function deployToSurge(htmlFilePath, slug) {
  const domain = `diagram-${slug}.surge.sh`;
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'surge-'));

  try {
    fs.copyFileSync(htmlFilePath, path.join(tempDir, 'index.html'));
    fs.writeFileSync(path.join(tempDir, 'robots.txt'), 'User-agent: *\nDisallow: /\n');

    const surgeEnv = process.env.SURGE_TOKEN
      ? { ...process.env, SURGE_TOKEN: process.env.SURGE_TOKEN }
      : process.env;

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

  let url = null;
  let deployError = null;
  try {
    url = deployToSurge(filePath, slug);
  } catch (err) {
    deployError = err.message;
  }

  if (supabase) {
    try {
      const { error: dbError } = await supabase.from('feedbacks').insert({
        player_name: playerName || '不明',
        match_date: date || null,
        match_info: null,
        transcription_text: transcription,
        player_notes: playerNotes || null,
        html_content: finalHTML,
        surge_url: url,
      });
      if (dbError) console.error(`[${logLabel}] DB保存エラー:`, dbError.message);
      else console.log(`[${logLabel}] DB保存完了`);
    } catch (dbErr) {
      console.error(`[${logLabel}] DB保存例外:`, dbErr.message);
    }
  }

  return { success: true, url, localFile: filePath, error: deployError };
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
      const playerNotesSection = playerNotes && playerNotes.trim()
        ? `\n\n【選手の反省メモ（これらの点に必ずフィードバックすること）】\n${playerNotes.trim()}`
        : '';

      const prompt = `${SYSTEM_PROMPT}

---
選手名: ${playerName || '（記載なし）'}
日付: ${date || '（記載なし）'}
${playerNotesSection}

コーチング内容（文字起こし）:
${text}`;

      const result = await generateContentWithRetry(prompt);
      const htmlContent = cleanGeneratedHTML(result.response.text());
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
    let transcription = await transcribeAudio(audioPart);

    if (transcription.length > MAX_TRANSCRIPTION_CHARS) {
      console.warn(`[audio] 文字起こしが異常に長いため切り詰めます: ${transcription.length}文字`);
      transcription = transcription.slice(0, MAX_TRANSCRIPTION_CHARS);
    }

    console.log(`[audio] 文字起こし完了: ${transcription.length}文字`);

    // Step 3: 文字起こしテキストからフィードバックHTML生成
    const playerNotesSection = playerNotes && playerNotes.trim()
      ? `\n\n【選手の反省メモ（これらの点に必ずフィードバックすること）】\n${playerNotes.trim()}`
      : '';

    const prompt = `${SYSTEM_PROMPT}

---
選手名: ${playerName || '（記載なし）'}
日付: ${date || '（記載なし）'}
${playerNotesSection}

コーチング内容（文字起こし）:
${transcription}`;

    const result = await generateContentWithRetry(prompt);
    const htmlContent = cleanGeneratedHTML(result.response.text());
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
