const JSON_PROMPT = `ソフトテニスのコーチング内容を読み、選手向けフィードバックをJSONだけで出力する。
勝手に事実を作らない。コーチが使った技術用語はそのまま使う。話し言葉は要点に整える。
選手の反省メモがあれば、それぞれにコーチ視点のコメントを必ず含める。

出力は次のJSONのみ（前後の説明やコードフェンスは不要）:
{
  "matchInfo": "試合情報があれば。なければ空文字",
  "summary": "核心を1文で",
  "goods": [{"title": "短い見出し", "detail": "具体的な説明"}],
  "improvements": [{"title": "技術用語の見出し", "now": "今やっていること", "fix": "改善策", "note": "補足があれば"}],
  "drills": [{"title": "練習タイトル", "detail": "具体的な内容"}]
}
goodsは3〜5、improvementsは2〜4、drillsは2〜4。`;

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function parseFeedbackJson(raw) {
  const cleaned = String(raw || '')
    .trim()
    .replace(/^```json\s*/i, '')
    .replace(/^```\s*/i, '')
    .replace(/\s*```$/, '');
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('JSONの抽出に失敗しました');
  const data = JSON.parse(cleaned.slice(start, end + 1));
  if (!data.summary || !Array.isArray(data.goods) || !Array.isArray(data.improvements) || !Array.isArray(data.drills)) {
    throw new Error('JSONの必須項目が欠けています');
  }
  return data;
}

function renderFeedbackHTML({ playerName, date, matchInfo, summary, goods, improvements, drills }) {
  const displayName = playerName ? `${escapeHtml(playerName)}選手` : '選手';
  const dateLine = [date, matchInfo].filter(Boolean).map(escapeHtml).join(' ／ ');
  const goodItems = (goods || []).map(item => `
    <li class="flex items-start gap-3">
      <i data-lucide="check" class="w-4 h-4 text-emerald-600 mt-0.5 flex-shrink-0"></i>
      <div>
        <p class="font-bold text-slate-900 text-sm">${escapeHtml(item.title)}</p>
        <p class="text-sm text-ads-muted mt-0.5">${escapeHtml(item.detail)}</p>
      </div>
    </li>`).join('');
  const improveItems = (improvements || []).map(item => `
    <div class="bg-ads-surface border border-ads-border rounded-2xl p-5 md:p-6">
      <h3 class="font-black text-slate-900 mb-4">${escapeHtml(item.title)}</h3>
      <div class="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div class="bg-red-500/5 border border-red-500/20 rounded-xl p-4">
          <div class="flex items-center gap-1.5 text-xs font-bold text-red-600 mb-2">
            <i data-lucide="x-circle" class="w-3.5 h-3.5"></i>今やっていること
          </div>
          <p class="text-sm text-slate-700">${escapeHtml(item.now)}</p>
        </div>
        <div class="bg-emerald-500/5 border border-emerald-500/20 rounded-xl p-4">
          <div class="flex items-center gap-1.5 text-xs font-bold text-emerald-600 mb-2">
            <i data-lucide="check-circle" class="w-3.5 h-3.5"></i>改善策
          </div>
          <p class="text-sm text-slate-700">${escapeHtml(item.fix)}</p>
        </div>
      </div>
      ${item.note ? `<p class="text-xs text-ads-muted mt-3">${escapeHtml(item.note)}</p>` : ''}
    </div>`).join('');
  const drillItems = (drills || []).map((item, index) => `
    <div class="flex gap-4">
      <div class="bg-ads-accent text-white w-8 h-8 rounded-full flex items-center justify-center font-black text-sm flex-shrink-0 mt-0.5">${index + 1}</div>
      <div>
        <p class="font-bold text-slate-900 text-sm mb-1">${escapeHtml(item.title)}</p>
        <p class="text-sm text-ads-muted">${escapeHtml(item.detail)}</p>
      </div>
    </div>`).join('');

  return `
<div class="text-center mb-8 md:mb-10">
  <div class="inline-flex items-center gap-2 bg-ads-accent/10 text-ads-accent-light px-4 py-1.5 rounded-full text-sm font-medium mb-6">
    <i data-lucide="activity" class="w-4 h-4"></i>
    ソフトテニス コーチング
  </div>
  <h1 class="text-3xl md:text-5xl font-black text-slate-900 tracking-tight mb-4">
    ${displayName}への<br><span class="text-ads-accent-light">フィードバック</span>
  </h1>
  ${dateLine ? `<p class="text-sm text-ads-dim mb-4">${dateLine}</p>` : ''}
  <div class="bg-ads-surface border border-ads-border rounded-2xl p-5 max-w-xl mx-auto text-left">
    <p class="text-xs font-bold text-ads-muted mb-1">ひとことまとめ</p>
    <p class="text-lg font-black text-slate-900">${escapeHtml(summary)}</p>
  </div>
</div>
<div class="bg-emerald-500/5 border border-emerald-500/20 rounded-2xl p-6 md:p-8 mb-6">
  <div class="flex items-center gap-3 mb-5">
    <div class="bg-emerald-500/10 text-emerald-600 p-2 rounded-lg">
      <i data-lucide="star" class="w-5 h-5"></i>
    </div>
    <h2 class="text-xl font-black text-slate-900">良かった点</h2>
  </div>
  <ul class="space-y-3">${goodItems}</ul>
</div>
<div class="mb-6">
  <div class="flex items-center gap-3 mb-4">
    <div class="bg-ads-accent/10 text-ads-accent-light p-2 rounded-lg">
      <i data-lucide="target" class="w-5 h-5"></i>
    </div>
    <h2 class="text-xl font-black text-slate-900">改善ポイント</h2>
  </div>
  <div class="space-y-4">${improveItems}</div>
</div>
<div class="bg-ads-surface border border-ads-border rounded-2xl p-6 md:p-8">
  <div class="flex items-center gap-3 mb-6">
    <div class="bg-ads-accent/10 text-ads-accent-light p-2 rounded-lg">
      <i data-lucide="zap" class="w-5 h-5"></i>
    </div>
    <h2 class="text-xl font-black text-slate-900">今すぐ取り組む練習ポイント</h2>
  </div>
  <div class="space-y-4">${drillItems}</div>
</div>`;
}

function buildFeedbackPrompt({ playerName, date, playerNotes, transcription }) {
  const notes = playerNotes && playerNotes.trim()
    ? `\n\n【選手の反省メモ】\n${playerNotes.trim()}`
    : '';
  return `${JSON_PROMPT}

選手名: ${playerName || '（記載なし）'}
日付: ${date || '（記載なし）'}
${notes}

コーチング内容:
${transcription}`;
}

module.exports = {
  JSON_PROMPT,
  parseFeedbackJson,
  renderFeedbackHTML,
  buildFeedbackPrompt,
};
