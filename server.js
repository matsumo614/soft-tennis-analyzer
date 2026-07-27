require('dotenv').config();

const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execSync } = require('child_process');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleAIFileManager } = require('@google/generative-ai/server');
const { createClient } = require('@supabase/supabase-js');

// ─── 起動チェック ────────────────────────────────────────────────────────────
if (!process.env.GEMINI_API_KEY) {
  console.error('\n❌ GEMINI_API_KEY が設定されていません。');
  console.error('   .env ファイルを作成して GEMINI_API_KEY を設定してください。\n');
  process.exit(1);
}

// ─── 初期化 ──────────────────────────────────────────────────────────────────
const app = express();
const PORT = process.env.PORT || 3001;
const MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

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
    [選手名]への<br><span class="text-ads-accent-light">フィードバック</span>
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

// ─── ユーティリティ ────────────────────────────────────────────────────────────
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

// ─── テキストから生成 ─────────────────────────────────────────────────────────
app.post('/api/generate-text', async (req, res) => {
  const { text, playerName, date, playerNotes } = req.body;

  if (!text || text.trim().length < 20) {
    return res.status(400).json({ error: 'テキストが短すぎます（20文字以上必要です）' });
  }

  try {
    const model = genAI.getGenerativeModel({ model: MODEL });

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

    const result = await model.generateContent(prompt);
    const htmlContent = cleanGeneratedHTML(result.response.text());

    const slug = generateSlug(playerName, date);
    const title = `${playerName || '選手'}へのフィードバック`;
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
          transcription_text: text,
          player_notes: playerNotes || null,
          html_content: finalHTML,
          surge_url: url,
        });
        if (dbError) console.error('[generate-text] DB保存エラー:', dbError.message);
        else console.log('[generate-text] DB保存完了');
      } catch (dbErr) {
        console.error('[generate-text] DB保存例外:', dbErr.message);
      }
    }

    res.json({ success: true, url, localFile: filePath, error: deployError });
  } catch (err) {
    console.error('[generate-text]', err);
    res.status(500).json({ error: `生成に失敗しました: ${err.message}` });
  }
});

// ─── 音声から生成（2ステップ：忠実な文字起こし → フィードバック生成） ────────
app.post('/api/generate-audio', upload.single('audio'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: '音声ファイルが見つかりません' });
  }

  const { playerName, date, playerNotes } = req.body;
  const audioPath = req.file.path;
  const mimeType = req.file.mimetype || 'audio/mp4';

  let uploadedFileName = null;

  try {
    // Step 1: Gemini File APIにアップロード
    const uploadResult = await fileManager.uploadFile(audioPath, {
      mimeType,
      displayName: req.file.originalname || 'coaching-audio',
    });
    uploadedFileName = uploadResult.file.name;

    // ファイルがACTIVEになるまで待つ（最大90秒）
    let file = await fileManager.getFile(uploadedFileName);
    let attempts = 0;
    while (file.state === 'PROCESSING' && attempts < 30) {
      await new Promise(r => setTimeout(r, 3000));
      file = await fileManager.getFile(uploadedFileName);
      attempts++;
    }

    if (file.state !== 'ACTIVE') {
      throw new Error('音声ファイルの処理がタイムアウトしました');
    }

    const model = genAI.getGenerativeModel({ model: MODEL });

    // Step 2: 忠実な文字起こし（編集なし）
    const transcriptionResult = await model.generateContent([
      { fileData: { mimeType: file.mimeType, fileUri: file.uri } },
      { text: TRANSCRIPTION_PROMPT },
    ]);
    const transcription = transcriptionResult.response.text().trim();

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

    const result = await model.generateContent(prompt);

    const htmlContent = cleanGeneratedHTML(result.response.text());

    const slug = generateSlug(playerName, date);
    const title = `${playerName || '選手'}へのフィードバック`;
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
        if (dbError) console.error('[generate-audio] DB保存エラー:', dbError.message);
        else console.log('[generate-audio] DB保存完了');
      } catch (dbErr) {
        console.error('[generate-audio] DB保存例外:', dbErr.message);
      }
    }

    res.json({ success: true, url, localFile: filePath, error: deployError });
  } catch (err) {
    console.error('[generate-audio]', err);
    res.status(500).json({ error: `処理に失敗しました: ${err.message}` });
  } finally {
    // Geminiにアップロードしたファイルを削除
    if (uploadedFileName) {
      fileManager.deleteFile(uploadedFileName).catch(() => {});
    }
    // ローカルの一時ファイルを削除
    fs.unlink(audioPath, () => {});
  }
});

// ─── 履歴取得 ─────────────────────────────────────────────────────────────────
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
app.get('/api/health', (_, res) => {
  res.json({ status: 'ok', model: MODEL, db: !!supabase });
});

// ─── 起動 ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n✅ ソフトテニス フィードバック生成ツール 起動');
  console.log(`   ブラウザで開く → http://localhost:${PORT}`);
  console.log(`   使用モデル: ${MODEL}\n`);
});
