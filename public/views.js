// 画面のタブ切り替え（在庫一覧／仕入れ台帳／回転率）と、仕入れ台帳・回転率の表示
// 仕入日 = 買取日（purchase_date）、なければ登録日
// 出口日 = 販売日（sold_date）、なければ開催日（今日以前のもの）。出口日のない車両は在庫として数える
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

async function api(path) {
  const res = await fetch(path);
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
  const today = jstToday();
  return out.map((it) => {
    const inDate = isDate(it.purchase_date) ? it.purchase_date : jstDate(it.created_at);
    const exit = isDate(it.sold_date) ? it.sold_date
      : isDate(it.event_date) && it.event_date <= today ? it.event_date : '';
    return { ...it, inDate, exit };
  });
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
    const items = await fetchAll();
    if (view === 'ledger') renderLedger(items);
    else if (view === 'turnover') renderTurnover(items);
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

// ---- 回転率 ----
// 月ごとに：仕入台数、出口台数、月末在庫、回転率（出口台数 ÷ 平均在庫（月初と月末の平均））、出た車の平均在庫日数
function renderTurnover(items) {
  const today = jstToday();
  const valid = items.filter((it) => it.inDate);
  const stockOn = (d) => valid.filter((it) => it.inDate <= d && (!it.exit || it.exit > d)).length;
  const monthEnd = (ym) => { const [y, m] = ym.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1 - i, 1));
    months.push(d.toISOString().slice(0, 7));
  }
  const table = months.map((ym) => {
    const start = ym + '-01';
    const end = ym === today.slice(0, 7) ? today : monthEnd(ym);
    const prevEnd = new Date(Date.parse(start + 'T00:00:00Z') - 864e5).toISOString().slice(0, 10);
    const bought = valid.filter((it) => it.inDate.startsWith(ym)).length;
    const out = valid.filter((it) => it.exit && it.exit.startsWith(ym));
    const open = stockOn(prevEnd), close = stockOn(end);
    const avgStock = (open + close) / 2;
    const avgDays = out.length ? out.reduce((s, it) => s + Math.max(0, days(it.inDate, it.exit)), 0) / out.length : null;
    return { ym, bought, out: out.length, open, close, rate: avgStock ? out.length / avgStock : null, avgDays };
  }).reverse();

  // 直近90日に出た車
  const since = new Date(Date.parse(today + 'T00:00:00Z') - 90 * 864e5).toISOString().slice(0, 10);
  const recent = valid.filter((it) => it.exit && it.exit > since && it.exit <= today);
  const recentDays = recent.length ? recent.reduce((s, it) => s + Math.max(0, days(it.inDate, it.exit)), 0) / recent.length : null;
  // 今ある在庫と経過日数
  const stock = valid.filter((it) => !it.exit).map((it) => ({ ...it, age: Math.max(0, days(it.inDate, today)) }))
    .sort((a, b) => b.age - a.age);
  const stockDays = stock.length ? stock.reduce((s, it) => s + it.age, 0) / stock.length : null;
  const stockBuy = stock.reduce((s, it) => s + (Number(it.purchase_price) || 0), 0);
  // 年換算の回転率（直近12か月の出口台数 ÷ 12か月の平均在庫）
  const out12 = table.reduce((s, r) => s + r.out, 0);
  const avg12 = table.reduce((s, r) => s + (r.open + r.close) / 2, 0) / table.length;
  const yearRate = avg12 ? out12 / avg12 : null;

  const BUCKETS = [[0, 14, '0〜14日'], [15, 30, '15〜30日'], [31, 60, '31〜60日'], [61, 90, '61〜90日'], [91, Infinity, '91日以上']];
  const bucketCounts = BUCKETS.map(([a, b, label]) => ({ label, n: stock.filter((it) => it.age >= a && it.age <= b).length, warn: a >= 61 }));
  const maxN = Math.max(1, ...bucketCounts.map((b) => b.n));
  const f1 = (v) => v == null ? '—' : v.toFixed(1);
  const fd = (v) => v == null ? '—' : Math.round(v) + '日';

  $('#view-turnover').innerHTML = `
    <div class="view-bar"><h2>回転率</h2><span class="spacer"></span><button type="button" id="turn-print">🖨 印刷</button></div>
    <div class="stats">
      ${stat('在庫回転率（年換算）', yearRate == null ? '—' : f1(yearRate) + '回', '直近12か月の出口台数 ÷ 平均在庫台数')}
      ${stat('平均在庫日数（直近90日）', fd(recentDays), `直近90日に出た ${num(recent.length)}台`)}
      ${stat('現在の在庫', num(stock.length) + '台', `買取額 ${yen(stockBuy)}`)}
      ${stat('在庫の平均経過日数', fd(stockDays))}
    </div>
    <div class="report-grid">
      <div class="report-table">
        <h3>月別の回転率</h3>
        <table class="rtbl">
          <thead><tr><th>月</th><th class="r">仕入台数</th><th class="r">出口台数</th><th class="r">月末在庫</th><th class="r">回転率</th><th class="r">平均在庫日数</th></tr></thead>
          <tbody>${table.map((r) => `<tr><td>${ymLabel(r.ym)}${r.ym === today.slice(0, 7) ? '<small class="muted">（今日まで）</small>' : ''}</td>
            <td class="r">${num(r.bought)}</td><td class="r">${num(r.out)}</td><td class="r">${num(r.close)}</td>
            <td class="r b">${r.rate == null ? '—' : r.rate.toFixed(2) + '回'}</td><td class="r">${fd(r.avgDays)}</td></tr>`).join('')}</tbody>
        </table>
      </div>
      <div class="report-side">
        <h3>在庫の経過日数</h3>
        <div class="bars">${bucketCounts.map((b) => `<div class="bar-row"><span>${b.label}</span>
          <span class="bar"><i class="${b.warn ? 'warn' : ''}" style="width:${(b.n / maxN) * 100}%"></i></span><b>${num(b.n)}台</b></div>`).join('')}</div>
        <h3>長く残っている車（61日以上）</h3>
        <table class="rtbl"><thead><tr><th>車名</th><th>仕入日</th><th class="r">経過</th></tr></thead>
          <tbody>${stock.filter((it) => it.age >= 61).slice(0, 30).map((it) =>
            `<tr><td class="b">${esc(it.name)}</td><td>${mdLabel(it.inDate)}</td><td class="r minus">${it.age}日</td></tr>`).join('')
            || '<tr><td colspan="3" class="empty">ありません</td></tr>'}</tbody></table>
      </div>
    </div>
    <p class="muted hint">仕入日＝買取日（未入力なら登録日）。出口日＝販売日（未入力なら開催日。今日より先の開催日はまだ在庫として数えます）。
      回転率＝その月の出口台数 ÷ 平均在庫（月初と月末の在庫台数の平均）。</p>`;
  $('#turn-print').addEventListener('click', () => window.print());
}

// 最初に開く画面：URL の #ledger などを優先、なければ前回の画面
let first = location.hash.slice(1);
if (!VIEWS.includes(first)) { try { first = localStorage.getItem('zaiko-view') || 'stock'; } catch { first = 'stock'; } }
show(first, { save: false });
