# 引き継ぎドキュメント：ソフトテニス フィードバック図解生成ツール

作成日：2026-07-27

---

## このドキュメントの目的

ここまでの開発内容を次のエージェントに引き継ぐための文書です。
**次にやること：Supabaseを使ったデータベース機能の実装**

---

## 1. 作ったもの

### アプリの概要

**ソフトテニス フィードバック図解生成ツール**

- コーチ（松本コーチ）が試合動画を解説した音声 or 文字起こしテキストを入力すると
- Gemini AIが構造化されたコーチングフィードバックHTMLを自動生成し
- Surgeに自動デプロイして、共有用URLを返す
- ブラウザで `http://localhost:3001` から使える

### 参考URL（生成済みサンプル）

- https://diagram-tennis-player-20260726-s55.surge.sh/（手動文字起こし→テキスト入力の例）
- https://diagram-tennis-player-20260726-5wi.surge.sh/（選手反省メモ込みの例）
- 既存の図解ツールの参考：https://diagram-tennis-ejima-0403.surge.sh/

---

## 2. プロジェクト構成

```
/Users/matsumototakashi/src/soft-tennis-analyzer/
├── server.js              ← Express サーバー（メインロジック）
├── public/
│   └── index.html         ← ブラウザUI
├── templates/
│   └── base.html          ← HTMLテンプレート（Tailwind CSS + Lucide Icons）
├── output/                ← 生成されたHTMLファイル（.gitignore対象）
├── uploads/               ← 音声一時保存（.gitignore対象）
├── render.yaml            ← Renderデプロイ設定
├── .env                   ← APIキー（.gitignore対象）
├── .env.example           ← APIキーのひな形
└── package.json
```

---

## 3. 現在の環境変数（.env）

```
GEMINI_API_KEY=REDACTED_GEMINI_API_KEY
GEMINI_MODEL=gemini-flash-latest
SURGE_TOKEN=REDACTED_SURGE_TOKEN
PORT=3001
```

---

## 4. 現在の機能

### UIの入力項目
- 選手名（テキスト）
- 日付（日付ピッカー）
- モード切り替え：「文字起こしテキスト」 or 「音声ファイル」
- 選手の反省メモ（任意）

### 処理フロー
```
[テキスト入力の場合]
テキスト → Gemini（フィードバックHTML生成）→ Surgeデプロイ → URL返却

[音声入力の場合（2ステップ）]
音声ファイル
  → Step1: Gemini File API（忠実な文字起こし、編集なし）
  → Step2: 文字起こしテキスト → Gemini（フィードバックHTML生成）
  → Surgeデプロイ → URL返却
```

### APIエンドポイント
- `GET  /api/health` → ヘルスチェック
- `POST /api/generate-text` → body: `{ text, playerName, date, playerNotes }`
- `POST /api/generate-audio` → multipart: `audio`, `playerName`, `date`, `playerNotes`

### Surgeデプロイの仕組み
- 一時ディレクトリにHTMLを `index.html` としてコピー
- `robots.txt` も追加
- `npx surge tempDir --domain diagram-tennis-{slug}.surge.sh` で公開
- `SURGE_TOKEN` 環境変数でログイン不要デプロイ対応済み

---

## 5. 既存ツールとの関係

`/Users/matsumototakashi/src/creating-visual-explainers/` に元になった図解ツールがある。
- `base.html` テンプレートをそのまま流用している
- デザインシステム（Tailwind + Lucide Icons + ADS配色）を共有

---

## 6. 次にやること：Supabaseデータベース実装

### 決まった要件

| 項目 | 内容 |
|---|---|
| DB | Supabase（PostgreSQL、無料プラン） |
| 保存データ | 文字起こしテキスト + 生成HTML + メタデータ |
| アクセス | クラウドから（スマホ・PC問わず） |
| 認証 | なし（URLを知っていれば見られる） |
| UI | アプリ内に「選手別の履歴」画面を追加 |

### 将来の活用イメージ
1. 過去データをAIに渡して「この選手の傾向を踏まえたフィードバック」生成
2. チーム全体の傾向分析・教材化
3. （将来）生徒自身が自分の履歴を見られるログイン機能

### 実装手順（次のエージェントへの指示）

#### Step 1：Supabaseプロジェクトのセットアップ

1. https://supabase.com にGitHubアカウントでログインしてプロジェクト作成
2. 以下のSQLをSupabase SQL Editorで実行してテーブル作成：

```sql
create table feedbacks (
  id uuid default gen_random_uuid() primary key,
  player_name text not null,
  match_date date,
  match_info text,
  transcription_text text,
  player_notes text,
  html_content text,
  surge_url text,
  created_at timestamp with time zone default now()
);

-- 選手名と日付でよく検索するためインデックスを追加
create index feedbacks_player_name_idx on feedbacks(player_name);
create index feedbacks_created_at_idx on feedbacks(created_at desc);
```

3. Supabaseダッシュボードから以下を取得：
   - Project URL（例: `https://xxxx.supabase.co`）
   - anon/public API Key

4. `.env` に追加：
```
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=eyJxxx...
```

#### Step 2：server.js の変更

1. `@supabase/supabase-js` をインストール：
```bash
npm install @supabase/supabase-js
```

2. `server.js` にSupabaseクライアントを追加：
```javascript
const { createClient } = require('@supabase/supabase-js');
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
```

3. 各エンドポイント（`/api/generate-text`, `/api/generate-audio`）の成功後にDB保存を追加：
```javascript
// Surgeデプロイ後、DBに保存
if (supabase) {
  await supabase.from('feedbacks').insert({
    player_name: playerName || '不明',
    match_date: date || null,
    match_info: null, // 将来的にAIで抽出
    transcription_text: text, // 文字起こしテキスト
    player_notes: playerNotes || null,
    html_content: finalHTML,
    surge_url: url,
  });
}
```

4. 履歴取得エンドポイントを追加：
```javascript
// GET /api/history - 全フィードバック一覧（新しい順）
app.get('/api/history', async (req, res) => {
  const { data, error } = await supabase
    .from('feedbacks')
    .select('id, player_name, match_date, surge_url, created_at')
    .order('created_at', { ascending: false });
  res.json({ feedbacks: data || [] });
});

// GET /api/history/:playerName - 選手別フィードバック一覧
app.get('/api/history/:playerName', async (req, res) => {
  const { data, error } = await supabase
    .from('feedbacks')
    .select('id, player_name, match_date, surge_url, created_at, transcription_text')
    .eq('player_name', req.params.playerName)
    .order('created_at', { ascending: false });
  res.json({ feedbacks: data || [] });
});
```

#### Step 3：履歴UIの追加

`public/index.html` に「履歴」タブを追加。
- 全選手の一覧（選手名でグループ化）
- 各フィードバックへのリンク（Surge URL）
- 日付・試合情報の表示

デザインは既存UIの延長（Tailwind CSS、白カード、青アクセント）で統一。

---

## 7. Renderへの公開デプロイ（完了済み）

本番URL：https://soft-tennis-analyzer.onrender.com/
GitHub：https://github.com/matsumo614/soft-tennis-analyzer （`main` へのpushで自動デプロイ）

環境変数（GEMINI_API_KEY, SURGE_TOKEN, GEMINI_MODEL, SUPABASE_URL, SUPABASE_ANON_KEY）はRender側で設定済み。

**注意**：Renderダッシュボードで環境変数を手動設定している場合、`render.yaml` の値より
ダッシュボードの値が優先される。モデルを変えるときはダッシュボード側も確認すること。

---

## 8. 2026-08-15 に修正した不具合

長い音声（10分以上）をアップロードすると必ず失敗していた問題を修正した。

| 症状 | 原因 | 対応 |
|---|---|---|
| `The input token count exceeds the maximum number of tokens allowed 1048576` | ブラウザやcurlが `.m4a` を `application/octet-stream` として送信し、その値をそのままGeminiへ渡していた。Geminiは音声ではなく生バイト列として解釈するため、数十MBのファイルが軽く100万トークンを超える | `resolveAudioMimeType()` で拡張子から必ず正しいMIMEに補正する |
| 文字起こしが暴走（15分の音声から12万文字） | `gemini-flash-lite-latest` が繰り返しループに陥る | モデルを `gemini-flash-latest` に変更。併せて `MAX_TRANSCRIPTION_CHARS` で上限を設定 |
| 5分以上かかる文字起こしが `fetch failed` になる | Node標準fetch（undici）のheadersTimeoutが既定300秒 | `undici` の `setGlobalDispatcher` でタイムアウトを20分に引き上げ |
| エラー時に画面が固まる（スピナーが回り続ける） | フロントの `generate()` がエラー時に `setLoading(false)` を通らず `return` していた | `try/finally` に整理 |
| 音声をドラッグ＆ドロップしても無反応 | `file.type.startsWith('audio/')` だけで判定していたため、`application/octet-stream` のファイルが黙って捨てられていた | 拡張子でも判定し、弾く場合は理由を表示 |
| 履歴タブが重い（レスポンス571KB） | `/api/history` が全件の文字起こし本文を返していた | 一覧からは本文を除外し、`/api/history/:id/transcription` で個別取得（4.9KBに縮小） |

検証結果（21分・53MBの音声）：入力40,927トークン、文字起こし8,214文字、約4分で完了。

---

## 9. 注意事項

- 利用可能なGeminiモデルは増えている（`gemini-3.7-flash`、`gemini-2.5-pro` なども利用可）。
  「2.5系は新規アカウントで制限あり」という以前の記述はもう当てはまらない
- Surgeドメインは英数字のみ対応。日本語の選手名はスラッグから自動除去される（URLの選手名は `player` になるが、HTML内容には正しく表示）
- 音声→文字起こしには`TRANSCRIPTION_PROMPT`という専用プロンプトで「編集なし・忠実な文字起こし」を実現している
- 選手の反省メモ（`playerNotes`）が入力されると、AIがその反省点に対してコーチ視点でフィードバックを追加する
- Supabaseのanonキーは参照と追加のみ許可されており、削除はできない。
  レコードを消すときはSupabaseダッシュボードのSQL Editorから実行する
