import { decodeCsv, parseCsv, csvToSnapshot, ymFromFileName } from './import-parse.js';

// 画面のタブ切り替え（在庫一覧／仕入れ台帳／回転率）と、仕入れ台帳・回転率の表示
// 仕入日 = 買取日（purchase_date）、なければ登録日
// 回転率は月初在庫CSV（毎月取り込み）から出す
const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (n) => Number(n).toLocaleString('ja-JP');
const yen = (n) => (n < 0 ? '−¥' : '¥') + Math.abs(Math.round(n)).toLocaleString('ja-JP');
const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const jstDate = (t) => t ? new Date(Date.parse(t.replace(' ', 'T') + 'Z') + 9 * 3600e3).toISOString().slice(0, 10) : '';
const days = (a, b) => Math.round((Date.parse(b + 'T00:00:00Z') - Date.parse(a + 'T00:00:00Z')) / 864e5);
const ymLabel = (ym) => { const [y, m] = ym.split('-').map(Number); return `${y}年${m}月`; };
const mdLabel = (d) => { if (!d) return ''; const [y, m, day] = d.split('-').map(Number); return `${y}/${m}/${day}`; };
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(d || '');
const kmText = (it) => it.mileage == null ? ''
  : it.mileage_unit === 'mile' ? `${num(it.mileage)}マイル` : `${num(it.mileage)}km`;

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) { location.href = '/login'; throw new Error('ログインしてください'); }
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

// 全車両を取得（1回 1000 件ずつ）
async function fetchAll() {
  const out = [];
  for (let offset = 0; ; offset += 1000) {
    const d = await api(`/api/items?sort=created_asc&limit=1000&offset=${offset}`);
    out.push(...d.items);
    if (out.length >= d.total || !d.items.length) break;
  }
  return out.map((it) => ({ ...it, inDate: isDate(it.purchase_date) ? it.purchase_date : jstDate(it.created_at) }));
}

// ---- タブ ----
const VIEWS = ['stock', 'ledger', 'turnover'];
const tabs = document.querySelectorAll('.app-tabs [data-view]');
let current = 'stock';
function show(view, { save = true } = {}) {
  if (!VIEWS.includes(view)) view = 'stock';
  current = view;
  tabs.forEach((t) => {
    const on = t.dataset.view === view;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
  });
  for (const v of VIEWS) $('#view-' + v).hidden = v !== view;
  if (save) {
    try { localStorage.setItem('zaiko-view', view); } catch { /* 無視 */ }
    history.replaceState(null, '', view === 'stock' ? location.pathname : '#' + view);
  }
  if (view === 'stock') window.dispatchEvent(new Event('resize')); // 表の文字サイズを合わせ直す
  else refresh();
}
tabs.forEach((t) => t.addEventListener('click', () => show(t.dataset.view)));
// ← → キーでタブを移動
$('.app-tabs').addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  const i = VIEWS.indexOf(current) + (e.key === 'ArrowRight' ? 1 : -1);
  show(VIEWS[(i + VIEWS.length) % VIEWS.length]);
  document.querySelector(`.app-tabs [data-view="${current}"]`).focus();
});
// 登録・編集のあとは、開いている集計画面も読み直す
$('#dlg')?.addEventListener('close', () => { if (current !== 'stock') setTimeout(refresh, 400); });

async function refresh() {
  const view = current;
  const box = $('#view-' + view);
  if (!box.innerHTML) box.innerHTML = '<p class="empty">読み込み中…</p>';
  try {
    if (view === 'turnover') await loadTurnover();
    else if (view === 'ledger') renderLedger(await fetchAll());
  } catch (e) {
    box.innerHTML = `<p class="empty">読み込みに失敗しました：${esc(e.message)}</p>`;
  }
}

const stat = (label, value, note = '') =>
  `<div class="stat"><div class="label">${label}</div><div class="value">${value}</div>${note ? `<div class="note">${note}</div>` : ''}</div>`;

// ---- 仕入れ台帳 ----
let ledgerMonth = ''; // 最初は今月（今月の仕入れがなければデータのある最新の月）
function renderLedger(items) {
  const months = [...new Set(items.map((it) => it.inDate.slice(0, 7)).filter(Boolean))].sort().reverse();
  if (!ledgerMonth) ledgerMonth = months.includes(jstToday().slice(0, 7)) || !months.length ? jstToday().slice(0, 7) : months[0];
  if (!months.includes(ledgerMonth) && ledgerMonth !== 'all') months.unshift(ledgerMonth);
  const rows = items
    .filter((it) => ledgerMonth === 'all' || it.inDate.startsWith(ledgerMonth))
    .sort((a, b) => a.inDate.localeCompare(b.inDate) || a.id - b.id);
  const sum = (k) => rows.reduce((s, it) => s + (Number(it[k]) || 0), 0);
  const buy = sum('purchase_price');
  const withLanding = rows.filter((it) => it.landing_price);
  const gap = withLanding.reduce((s, it) => s + it.landing_price - (it.purchase_price || 0), 0);

  // 月別のまとめ（直近12か月）
  const byMonth = {};
  for (const it of items) {
    const m = it.inDate.slice(0, 7);
    if (!m) continue;
    (byMonth[m] ??= { n: 0, buy: 0 });
    byMonth[m].n++;
    byMonth[m].buy += Number(it.purchase_price) || 0;
  }
  const monthRows = Object.keys(byMonth).sort().reverse().slice(0, 12).map((m) =>
    `<tr data-month="${m}" class="${m === ledgerMonth ? 'sel' : ''}"><td>${ymLabel(m)}</td><td class="r">${num(byMonth[m].n)}台</td><td class="r">${yen(byMonth[m].buy)}</td></tr>`).join('');

  $('#view-ledger').innerHTML = `
    <div class="view-bar">
      <h2>仕入れ台帳</h2>
      <label>表示する月
        <select id="ledger-month">
          <option value="all"${ledgerMonth === 'all' ? ' selected' : ''}>すべて</option>
          ${months.map((m) => `<option value="${m}"${m === ledgerMonth ? ' selected' : ''}>${ymLabel(m)}</option>`).join('')}
        </select>
      </label>
      <span class="spacer"></span>
      <button type="button" id="ledger-csv">⬇ CSV</button>
      <button type="button" id="ledger-print">🖨 印刷</button>
    </div>
    <div class="stats">
      ${stat('仕入台数', num(rows.length) + '台')}
      ${stat('買取金額 合計', yen(buy))}
      ${stat('平均買取金額', rows.length ? yen(buy / rows.length) : '—')}
      ${stat('見込み差額（着地予想−買取）', withLanding.length ? `<span class="${gap >= 0 ? 'plus' : 'minus'}">${yen(gap)}</span>` : '—',
        withLanding.length < rows.length ? `着地予想が入っている${withLanding.length}台分` : '')}
    </div>
    <div class="report-grid">
      <div class="report-table">
        <table class="rtbl">
          <thead><tr><th>No.</th><th>仕入日</th><th>車名</th><th>車台番号</th><th>色</th><th class="r">走行距離</th>
            <th class="r">買取金額</th><th class="r">着地予想</th><th class="r">見込み差額</th><th>会場</th><th>開催日</th></tr></thead>
          <tbody>${rows.length ? rows.map((it, i) => {
            const g = it.landing_price ? it.landing_price - (it.purchase_price || 0) : null;
            return `<tr><td class="r">${i + 1}</td><td>${mdLabel(it.inDate)}${isDate(it.purchase_date) ? '' : '<small class="muted" title="買取日が未入力のため登録日"> 登</small>'}</td>
              <td class="b">${esc(it.name)}</td><td>${esc(it.chassis_no)}</td><td>${esc(it.color)}</td><td class="r">${esc(kmText(it))}</td>
              <td class="r">${it.purchase_price ? yen(it.purchase_price) : ''}</td><td class="r">${it.landing_price ? yen(it.landing_price) : ''}</td>
              <td class="r ${g == null ? '' : g >= 0 ? 'plus' : 'minus'}">${g == null ? '' : yen(g)}</td>
              <td>${esc(it.venue)}</td><td>${mdLabel(it.event_date)}</td></tr>`;
          }).join('') : '<tr><td class="empty" colspan="11">この月の仕入れはありません</td></tr>'}</tbody>
          ${rows.length ? `<tfoot><tr><td colspan="6">合計 ${num(rows.length)}台</td><td class="r">${yen(buy)}</td><td class="r">${yen(sum('landing_price'))}</td><td colspan="3"></td></tr></tfoot>` : ''}
        </table>
      </div>
      <div class="report-side">
        <h3>月別の仕入れ</h3>
        <table class="rtbl click"><thead><tr><th>月</th><th class="r">台数</th><th class="r">買取金額</th></tr></thead><tbody>${monthRows || '<tr><td colspan="3" class="empty">データなし</td></tr>'}</tbody></table>
      </div>
    </div>
    <p class="muted hint">仕入日は「買取日」、未入力なら「登録日」（<small>登</small> の印）。月別の行を押すとその月を表示します。</p>`;

  $('#ledger-month').addEventListener('change', (e) => { ledgerMonth = e.target.value; renderLedger(items); });
  $('#view-ledger .report-side tbody').addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-month]');
    if (tr) { ledgerMonth = tr.dataset.month; renderLedger(items); }
  });
  $('#ledger-print').addEventListener('click', () => window.print());
  $('#ledger-csv').addEventListener('click', () => {
    const head = ['仕入日', '車名', '車台番号', '色', '走行距離', '距離単位', '買取金額', '着地予想', '会場', '開催日', 'メモ'];
    const q = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
    const lines = [head, ...rows.map((it) => [it.inDate, it.name, it.chassis_no, it.color, it.mileage, it.mileage_unit,
      it.purchase_price, it.landing_price, it.venue, it.event_date, it.notes])].map((r) => r.map(q).join(','));
    const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' }); // Excel で文字化けしないよう BOM 付き
    const a = Object.assign(document.createElement('a'), {
      href: URL.createObjectURL(blob),
      download: `仕入れ台帳_${ledgerMonth === 'all' ? 'すべて' : ledgerMonth}.csv`,
    });
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
}

// ---- 回転率（月初在庫CSVから） ----
// 回転率 = その月の販売台数 ÷ 月初在庫台数
// 販売台数は「その月の月初在庫にあって翌月の月初在庫にない車」を自動で数える。手入力があればそちらを優先
let turnMonths = [];
let turnSel = '';
let pending = null; // 取り込み前の確認中のCSV { file_name, rows, ym }
const details = new Map(); // ym → 月の詳細（車両一覧など）
const soldOf = (m) => m.sold_manual ?? m.sold_auto;
const pct = (m) => { const s = soldOf(m); return s == null || !m.count ? null : s / m.count; };
const rateHtml = (m) => { const r = pct(m); return r == null ? '—' : `${(r * 100).toFixed(1)}%<small class="muted">（${r.toFixed(2)}回）</small>`; };
const prevMonth = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7) - 2, 1)).toISOString().slice(0, 7);
const nextMonth = (ym) => new Date(Date.UTC(+ym.slice(0, 4), +ym.slice(5, 7), 1)).toISOString().slice(0, 7);

function toast(msg, isError = false) {
  const t = $('#toast');
  if (!t) return;
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = 'toast'; }, 3000);
}

async function loadTurnover({ reload = false } = {}) {
  if (reload) details.clear();
  turnMonths = (await api('/api/snapshots')).months;
  if (!turnMonths.some((m) => m.ym === turnSel)) {
    turnSel = (turnMonths.find((m) => soldOf(m) != null) || turnMonths[0])?.ym || '';
  }
  renderTurnover();
  if (turnSel && !details.has(turnSel)) {
    const ym = turnSel;
    try { details.set(ym, await api('/api/snapshots/' + ym)); } catch (e) { details.set(ym, { error: e.message }); }
    if (current === 'turnover' && turnSel === ym) renderTurnover();
  }
}

function pendingHtml() {
  if (!pending) return '';
  const { rows, ym, file_name } = pending;
  const cost = rows.reduce((s, r) => s + (r.cost || 0), 0);
  const exists = turnMonths.some((m) => m.ym === ym);
  const later = rows.filter((r) => r.in && r.in >= nextMonth(ym) + '-01').length;
  return `<div class="panel pending">
    <h3>月初在庫の取り込み：${esc(file_name)}</h3>
    <p><b>${num(rows.length)}台</b>／仕入金額 合計 <b>${yen(cost)}</b></p>
    <label>何月の月初在庫ですか？ <input type="month" id="pend-ym" value="${ym}"></label>
    ${exists ? `<p class="warn">${ymLabel(ym)}の月初在庫はすでにあります。取り込むと置き換えます。</p>` : ''}
    ${later ? `<p class="warn">在庫Noの日付が${ymLabel(ym)}より後の車が ${num(later)}台 あります。月の選択が合っているか確認してください。</p>` : ''}
    <div class="actions"><span class="spacer"></span><button type="button" id="pend-cancel">キャンセル</button>
      <button type="button" class="primary" id="pend-save">取り込む</button></div>
  </div>`;
}

function agingHtml(d) {
  const start = d.ym + '-01';
  const BUCKETS = [[0, 30, '30日以内'], [31, 60, '31〜60日'], [61, 90, '61〜90日'], [91, 180, '91〜180日'], [181, Infinity, '181日以上']];
  const withAge = d.rows.map((r) => ({ ...r, age: r.in ? Math.max(0, days(r.in, start)) : null }));
  const b = BUCKETS.map(([lo, hi, label]) => {
    const list = withAge.filter((r) => r.age != null && r.age >= lo && r.age <= hi);
    return { label, n: list.length, cost: list.reduce((s, r) => s + (r.cost || 0), 0), warn: lo >= 91 };
  });
  const unknown = withAge.filter((r) => r.age == null).length;
  const maxN = Math.max(1, ...b.map((x) => x.n));
  return `<h3>月初時点の在庫日数（在庫Noの日付から）</h3>
    <div class="bars">${b.map((x) => `<div class="bar-row wide"><span>${x.label}</span>
      <span class="bar"><i class="${x.warn ? 'warn' : ''}" style="width:${(x.n / maxN) * 100}%"></i></span><b>${num(x.n)}台</b><small class="muted">${yen(x.cost)}</small></div>`).join('')}</div>
    ${unknown ? `<p class="muted hint">在庫Noから日付が読めない車：${num(unknown)}台</p>` : ''}`;
}

const carTable = (list, empty) => `<div class="scroll-box"><table class="rtbl">
  <thead><tr><th>在庫No</th><th>メーカー</th><th>車名</th><th>初度</th><th class="r">走行</th><th class="r">仕入金額</th></tr></thead>
  <tbody>${list.length ? list.map((r) => `<tr><td>${esc(r.no)}</td><td>${esc(r.maker)}</td><td class="b">${esc(r.name)}</td><td>${esc(r.reg)}</td>
    <td class="r">${r.km == null ? '' : num(r.km) + 'km'}</td><td class="r">${r.cost == null ? '' : yen(r.cost)}</td></tr>`).join('')
    : `<tr><td colspan="6" class="empty">${empty}</td></tr>`}</tbody></table></div>`;

function detailHtml(m) {
  const d = details.get(m.ym);
  if (!d) return '<p class="empty">読み込み中…</p>';
  if (d.error) return `<p class="empty">読み込みに失敗しました：${esc(d.error)}</p>`;
  const next = ymLabel(nextMonth(m.ym));
  return `<div class="report-grid">
    <div class="report-table">
      <h3>販売した車（${ymLabel(m.ym)}の月初在庫にあり、${next}の月初在庫にない車）${d.sold ? ` ${num(d.sold.length)}台` : ''}</h3>
      ${d.sold ? carTable(d.sold, 'ありません') : `<p class="muted">${next}の月初在庫を取り込むと表示されます。</p>`}
      <h3>仕入れた車（${next}の月初在庫で新しく増えた車）${d.bought ? ` ${num(d.bought.length)}台` : ''}</h3>
      ${d.bought ? carTable(d.bought, 'ありません') : `<p class="muted">${next}の月初在庫を取り込むと表示されます。</p>`}
    </div>
    <div class="report-side">
      <div class="panel">
        <h3>${ymLabel(m.ym)}の販売台数</h3>
        <p class="muted">自動：${m.sold_auto == null ? `${next}の月初在庫を取り込むと数えます` : num(m.sold_auto) + '台'}</p>
        <label class="inline">手入力 <input type="number" id="sold-input" min="0" inputmode="numeric" value="${m.sold_manual ?? ''}" placeholder="台数"> 台</label>
        <div class="actions"><button type="button" id="sold-clear"${m.sold_manual == null ? ' disabled' : ''}>自動に戻す</button>
          <span class="spacer"></span><button type="button" class="primary" id="sold-save">保存</button></div>
        <p class="muted hint">手入力があると、回転率は手入力の台数で計算します。</p>
      </div>
      ${agingHtml(d)}
      <p class="muted hint">取り込んだファイル：${esc(m.file_name)}（${esc(m.uploaded_at)} UTC）<br>
        <button type="button" id="snap-delete" class="danger small">この月の月初在庫を削除</button></p>
    </div>
  </div>`;
}

function renderTurnover() {
  const sel = turnMonths.find((m) => m.ym === turnSel);
  const box = $('#view-turnover');
  box.innerHTML = `
    <div class="view-bar"><h2>回転率</h2><span class="spacer"></span>
      <label class="file-btn">📥 月初在庫CSVを取り込む<input type="file" id="snap-file" accept=".csv,text/csv" hidden></label>
      <button type="button" id="turn-print">🖨 印刷</button></div>
    ${pendingHtml()}
    ${!turnMonths.length ? `<div class="panel"><p>まだ月初在庫がありません。</p>
      <p class="muted">「📥 月初在庫CSVを取り込む」から、毎月の月初在庫のCSV（在庫No・車名・愛称名・車台番号・仕入金額 などの列）を取り込んでください。
      2か月分そろうと、その月の販売台数と回転率が自動で出ます。</p></div>` : `
    <div class="stats">
      ${stat(`${ymLabel(sel.ym)}の回転率`, rateHtml(sel), '販売台数 ÷ 月初在庫台数')}
      ${stat('月初在庫', num(sel.count) + '台', yen(sel.cost_total))}
      ${stat('販売台数', soldOf(sel) == null ? '—' : num(soldOf(sel)) + '台', sel.sold_manual != null ? '手入力' : sel.sold_auto != null ? '自動（翌月の月初在庫と比較）' : '翌月の月初在庫が未取り込み')}
      ${stat('仕入台数', sel.bought_auto == null ? '—' : num(sel.bought_auto) + '台', '翌月の月初在庫で増えた車')}
    </div>
    <h3>月別の回転率</h3>
    <div class="report-table"><table class="rtbl click">
      <thead><tr><th>月</th><th class="r">月初在庫</th><th class="r">月初在庫金額</th><th class="r">販売台数</th><th class="r">回転率</th><th class="r">仕入台数</th></tr></thead>
      <tbody>${turnMonths.map((m) => `<tr data-month="${m.ym}" class="${m.ym === turnSel ? 'sel' : ''}">
        <td>${ymLabel(m.ym)}</td><td class="r">${num(m.count)}台</td><td class="r">${yen(m.cost_total)}</td>
        <td class="r">${soldOf(m) == null ? '<span class="muted">—</span>' : num(soldOf(m)) + '台'}${m.sold_manual != null ? ' <small class="muted">手</small>' : ''}</td>
        <td class="r b">${rateHtml(m)}</td><td class="r">${m.bought_auto == null ? '—' : num(m.bought_auto) + '台'}</td></tr>`).join('')}</tbody>
    </table></div>
    <h3 class="detail-title">${ymLabel(sel.ym)}の詳細</h3>
    ${detailHtml(sel)}`}
    <p class="muted hint">回転率 ＝ その月の販売台数 ÷ 月初在庫台数。販売台数は、その月の月初在庫にあって翌月の月初在庫にない車の台数（車台番号で照合）。
      手入力した月は手入力の台数を使います。月別の行を押すとその月の詳細を表示します。</p>`;

  $('#turn-print').addEventListener('click', () => window.print());
  $('#snap-file').addEventListener('change', onSnapFile);
  box.querySelector('.rtbl.click tbody')?.addEventListener('click', (e) => {
    const tr = e.target.closest('tr[data-month]');
    if (tr) { turnSel = tr.dataset.month; loadTurnover(); }
  });
  if (pending) {
    $('#pend-ym').addEventListener('change', (e) => { if (/^\d{4}-\d{2}$/.test(e.target.value)) { pending.ym = e.target.value; renderTurnover(); } });
    $('#pend-cancel').addEventListener('click', () => { pending = null; renderTurnover(); });
    $('#pend-save').addEventListener('click', savePending);
  }
  $('#sold-save')?.addEventListener('click', () => saveSold($('#sold-input').value));
  $('#sold-clear')?.addEventListener('click', () => saveSold(null));
  $('#snap-delete')?.addEventListener('click', async () => {
    if (!confirm(`${ymLabel(turnSel)}の月初在庫を削除しますか？`)) return;
    try { await api('/api/snapshots/' + turnSel, { method: 'DELETE' }); toast('削除しました'); turnSel = ''; await loadTurnover({ reload: true }); }
    catch (e) { toast(e.message, true); }
  });
}

async function onSnapFile(e) {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const rows = csvToSnapshot(parseCsv(decodeCsv(await file.arrayBuffer())));
    if (!rows.length) throw new Error('車両が見つかりません');
    const last = turnMonths[0]?.ym;
    pending = { file_name: file.name, rows, ym: ymFromFileName(file.name) || (last ? nextMonth(last) : jstToday().slice(0, 7)) };
    renderTurnover();
  } catch (err) {
    toast('CSVを読み込めませんでした：' + err.message, true);
  }
}

async function savePending() {
  const btn = $('#pend-save');
  btn.disabled = true;
  btn.textContent = '取り込み中…';
  try {
    const r = await api('/api/snapshots', { method: 'POST', body: JSON.stringify({ ym: pending.ym, file_name: pending.file_name, rows: pending.rows }) });
    toast(`${ymLabel(r.ym)}の月初在庫を取り込みました（${num(r.count)}台）`);
    turnSel = prevMonth(r.ym);
    if (!r.months.some((m) => m.ym === turnSel && m.sold_auto != null)) turnSel = r.ym;
    pending = null;
    await loadTurnover({ reload: true });
  } catch (err) {
    toast('取り込めませんでした：' + err.message, true);
    btn.disabled = false;
    btn.textContent = '取り込む';
  }
}

async function saveSold(v) {
  if (v !== null && (v === '' || !(Number(v) >= 0))) { toast('販売台数を0以上の数字で入力してください', true); return; }
  try {
    await api('/api/snapshots/' + turnSel, { method: 'PATCH', body: JSON.stringify({ sold_manual: v === null ? null : Number(v) }) });
    toast(v === null ? '自動の販売台数に戻しました' : '販売台数を保存しました');
    await loadTurnover();
  } catch (e) { toast(e.message, true); }
}

// 最初に開く画面：URL の #ledger などを優先、なければ前回の画面
let first = location.hash.slice(1);
if (!VIEWS.includes(first)) { try { first = localStorage.getItem('zaiko-view') || 'stock'; } catch { first = 'stock'; } }
show(first, { save: false });
