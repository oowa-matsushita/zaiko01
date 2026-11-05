const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KM_PER_MILE = 1.609344;
const num = (n) => Number(n).toLocaleString('ja-JP');
const fmtMileage = (it) => it.mileage == null ? null
  : it.mileage_unit === 'mile'
    ? `${num(it.mileage)}マイル（約${num(Math.round(it.mileage * KM_PER_MILE))}km）`
    : `${num(it.mileage)}km`;

// D1 の datetime('now') は UTC なので日本時間の日付にする
const jstDate = (t) => t ? new Date(Date.parse(t.replace(' ', 'T') + 'Z') + 9 * 3600e3).toISOString().slice(0, 10) : '';
// 2026-11-05 → 11月5日（今年以外は年も付ける）
const mdDate = (d) => {
  if (!d) return '';
  const [y, m, day] = d.split('-').map(Number);
  const thisYear = new Date(Date.now() + 9 * 3600e3).getUTCFullYear();
  return `${y !== thisYear ? y + '年' : ''}${m}月${day}日`;
};
const state = { q: '', event_date: '', shipped_date: '', items: [] };

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) { location.href = '/login'; throw new Error('ログインしてください'); }
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

// ---- 開催日・出庫日のプルダウン ----
const WD = ['日', '月', '火', '水', '木', '金', '土'];
const jstToday = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
const addDays = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const dow = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();
const shortDate = (iso) => { const [, m, d] = iso.split('-').map(Number); return `${m}/${d}(${WD[dow(iso)]})`; };

// 開催日：今日から4週間の金曜・土曜
function eventDates() {
  const t = jstToday(), out = [];
  for (let i = 0; i < 28; i++) { const d = addDays(t, i); if (dow(d) === 5 || dow(d) === 6) out.push(d); }
  return out;
}
// 出庫日：今日から7日分
function shippedDates() {
  const t = jstToday();
  return Array.from({ length: 7 }, (_, i) => addDays(t, i));
}

function fillDateBoxes(box, field, dates, counts) {
  const current = state[field];
  const extra = current && !dates.includes(current) ? [current] : [];
  box.innerHTML = `<button type="button" class="date-box all" data-date="" aria-pressed="${!current}">
      <span class="n">すべて</span></button>` +
    [...dates, ...extra].map((d) => {
      const n = counts[d] || 0;
      const cls = [n ? '' : 'zero', dow(d) === 6 ? 'sat' : dow(d) === 0 ? 'sun' : ''].join(' ');
      return `<button type="button" class="date-box ${cls}" data-date="${d}" aria-pressed="${current === d}">
        <span class="d">${shortDate(d)}</span><span class="n">${n}<small>台</small></span></button>`;
    }).join('');
}

async function loadDateCounts() {
  try {
    const c = await api('/api/date-counts');
    fillDateBoxes($('#f-event'), 'event_date', eventDates(), c.event_date);
    fillDateBoxes($('#f-shipped'), 'shipped_date', shippedDates(), c.shipped_date);
  } catch { /* 台数が取れなくても一覧は表示する */ }
}

// 枠をクリックで絞り込み（選択中の枠をもう一度押すと解除）
for (const [id, field] of [['#f-event', 'event_date'], ['#f-shipped', 'shipped_date']]) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('.date-box');
    if (!b) return;
    state[field] = state[field] === b.dataset.date ? '' : b.dataset.date;
    load();
  });
}

async function load() {
  const p = new URLSearchParams({ sort: 'created_desc', limit: '1000' });
  if (state.q) p.set('q', state.q);
  if (state.event_date) p.set('event_date', state.event_date);
  if (state.shipped_date) p.set('shipped_date', state.shipped_date);
  loadDateCounts();
  try {
    const data = await api('/api/items?' + p);
    state.items = data.items;
    render(data);
  } catch (e) {
    setBody(`<tbody><tr><td class="empty" colspan="${colCount()}">読み込みに失敗しました：${esc(e.message)}</td></tr></tbody>`);
  }
}

// 表の列: [キー, 見出し, 種類]
const COLS = [
  ['id', 'No.', 'rowno'],
  ['name', '車名', 'sticky'],
  ['chassis_no', '車台番号'],
  ['color', '色'],
  ['color_code', 'カラーコード'],
  ['mileage', '走行距離', 'num'],
  ['own_date', '自社名', 'date'],
  ['venue', '会場', 'center'],
  ['event_date', '開催日', 'date'],
  ['shipped_date', '出庫日', 'date'],
  ['sales_points', 'セールスポイント', 'wrap'],
  ['has_warranty', '保証書', 'center'],
  ['has_manual', '取説', 'center'],
  ['notes', 'メモ', 'wrap'],
  ['created_at', '登録日'],
];
const COL = Object.fromEntries(COLS.map(([k, label, cls]) => [k, { label, cls }]));
// 表示レイアウト。2段は縦型モニター向けに1台を2行で表示（No. は2行分）
const LAYOUTS = {
  1: [COLS.map((c) => c[0])],
  2: [
    ['id', 'name', 'chassis_no', 'color', 'color_code', 'mileage', 'has_warranty', 'sales_points'],
    ['own_date', 'venue', 'event_date', 'shipped_date', 'created_at', 'has_manual', 'notes'],
  ],
};
let layoutKey = '2';
try { layoutKey = localStorage.getItem('zaiko-layout') || '2'; } catch { /* 保存できなくても既定で表示 */ }
const layout = () => LAYOUTS[layoutKey] || LAYOUTS[2];
const sortState = { key: 'id', dir: -1 };
// 並び替え用の値（マイルは km に換算して比較）
const sortVal = (it, k) => k === 'mileage'
  ? (it.mileage == null ? null : it.mileage_unit === 'mile' ? it.mileage * KM_PER_MILE : it.mileage)
  : it[k];
const cellHtml = (it, k) => {
  switch (k) {
    case 'mileage': return esc(fmtMileage(it) ?? '');
    case 'has_warranty': case 'has_manual': return it[k] ? '✓' : '';
    case 'created_at': return esc(mdDate(jstDate(it.created_at)));
    case 'own_date': case 'event_date': case 'shipped_date': return esc(mdDate(it[k]));
    default: return esc(it[k] ?? '');
  }
};

// 表に表示している順の車両一覧
function sortedItems() {
  const { key, dir } = sortState;
  return [...state.items].sort((a, b) => {
    const x = sortVal(a, key), y = sortVal(b, key);
    if (x == null || x === '') return 1;
    if (y == null || y === '') return -1;
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'ja')) * dir;
  });
}

function renderHead() {
  const rows = layout();
  $('#tbl thead').innerHTML = rows.map((keys, r) => `<tr>${keys.map((k) => {
    const { label, cls } = COL[k];
    const arrow = sortState.key === k ? (sortState.dir > 0 ? '▲' : '▼') : '';
    const span = k === 'id' && rows.length > 1 ? ` rowspan="${rows.length}"` : '';
    return `<th data-key="${k}"${span} class="${cls === 'sticky' || cls === 'center' ? cls : ''}${r > 0 ? ' sub' : ''}">${label}<span class="arrow">${arrow}</span></th>`;
  }).join('')}</tr>`).join('');
  // 2段目の見出しを1段目の下に固定する
  const first = $('#tbl thead tr');
  const h = first ? first.getBoundingClientRect().height : 0;
  document.querySelectorAll('#tbl thead th.sub').forEach((th) => { th.style.top = h + 'px'; });
  // 2段表示は横幅が収まるので列の固定はしない
  if (rows.length > 1) document.querySelectorAll('#tbl thead th.sticky').forEach((th) => th.classList.remove('sticky'));
}

function rowHtml(it) {
  const rows = layout();
  return rows.map((keys, r) => `<tr data-id="${it.id}"${r === rows.length - 1 ? ' class="last"' : ''}>${keys.map((k, i) => {
    if (k === 'id') {
      return `<td class="rowno"${rows.length > 1 ? ` rowspan="${rows.length}"` : ''}><button class="edit-btn" data-open="${it.id}" title="フォームで編集" aria-label="フォームで編集">✎</button>${it.id}</td>`;
    }
    const base = rows.length > 1 && COL[k].cls === 'sticky' ? '' : COL[k].cls;
    const cls = [base, EDITABLE.has(k) ? 'editable' : ''].filter(Boolean).join(' ');
    return `<td class="${cls}" data-key="${k}">${cellHtml(it, k)}</td>`;
  }).join('')}</tr>`).join('');
}

function setBody(html) {
  document.querySelectorAll('#tbl tbody').forEach((t) => t.remove());
  $('#tbl').insertAdjacentHTML('beforeend', html);
}
const colCount = () => Math.max(...layout().map((r) => r.length));

function render({ total }) {
  $('#count').textContent = `${total} 台`;
  for (const [k, id] of [['color', '#dl-color']]) {
    const vals = [...new Set(state.items.map((i) => i[k]).filter(Boolean))].sort();
    $(id).innerHTML = vals.map((v) => `<option value="${esc(v)}">`).join('');
  }
  renderHead();
  if (!state.items.length) {
    setBody(`<tbody><tr><td class="empty" colspan="${colCount()}">${state.q || state.event_date || state.shipped_date ? '該当する車両がありません' : 'まだ登録がありません。「＋ 買取登録」から追加してください'}</td></tr></tbody>`);
    return;
  }
  const rows = sortedItems();
  // 1台ごとに tbody を分けて、2段表示でも1台単位で色分け・ハイライトする
  setBody(rows.map((it) => `<tbody class="vehicle">${rowHtml(it)}</tbody>`).join(''));
}

$('#tbl thead').addEventListener('click', (e) => {
  const th = e.target.closest('th');
  if (!th) return;
  const k = th.dataset.key;
  sortState.dir = sortState.key === k ? -sortState.dir : 1;
  sortState.key = k;
  render({ total: state.items.length });
});

// ---- フォーム ----
const dlg = $('#dlg');
const form = $('#form');

function openForm(item) {
  form.reset();
  $('#form-error').textContent = '';
  $('#dlg-title').textContent = item ? '車両を編集' : '買取登録';
  $('#btn-delete').hidden = !item;
  const data = item || { mileage_unit: 'km' };
  for (const el of form.elements) {
    if (!el.name || !(el.name in data)) continue;
    if (el.type === 'checkbox') el.checked = !!data[el.name];
    else el.value = data[el.name] ?? '';
  }
  if (!item) form.elements.id.value = '';
  updateMileage();
  dlg.showModal();
  if (!item) form.elements.name.focus();
}

function updateMileage() {
  const mv = form.elements.mileage.value;
  $('.mileage-conv').textContent = mv !== '' && form.elements.mileage_unit.value === 'mile'
    ? `約 ${num(Math.round(Number(mv.replace(/[,，\s]/g, "")) * KM_PER_MILE))} km` : "";
}
form.addEventListener('input', updateMileage);
form.addEventListener('change', updateMileage);

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const body = {};
  for (const el of form.elements) {
    if (!el.name || el.name === 'id') continue;
    body[el.name] = el.type === 'checkbox' ? el.checked : el.value;
  }
  const id = form.elements.id.value;
  try {
    await api(id ? `/api/items/${id}` : '/api/items', { method: id ? 'PATCH' : 'POST', body: JSON.stringify(body) });
    dlg.close();
    load();
  } catch (err) {
    $('#form-error').textContent = err.message;
  }
});

$('#btn-cancel').addEventListener('click', () => dlg.close());
$('#btn-delete').addEventListener('click', async () => {
  const id = form.elements.id.value;
  if (!id || !confirm('この車両を削除しますか？')) return;
  try { await api(`/api/items/${id}`, { method: 'DELETE' }); dlg.close(); load(); }
  catch (err) { $('#form-error').textContent = err.message; }
});
$('#btn-add').addEventListener('click', () => openForm(null));

const layoutBtn = $('#btn-layout');
const updateLayoutBtn = () => {
  layoutBtn.textContent = '表示切替';
  layoutBtn.title = layoutKey === '1' ? '現在：1段（横長）→ 押すと2段に切替' : '現在：2段（縦型）→ 押すと1段に切替';
};
updateLayoutBtn();
layoutBtn.addEventListener('click', () => {
  layoutKey = layoutKey === '1' ? '2' : '1';
  try { localStorage.setItem('zaiko-layout', layoutKey); } catch { /* 無視 */ }
  updateLayoutBtn();
  render({ total: state.items.length });
});

// 日付欄はクリックでカレンダーを開く
function openPicker(input) {
  try { input.showPicker(); } catch { /* 未対応ブラウザは標準の動作 */ }
}
document.addEventListener('click', (e) => {
  if (e.target.matches?.('input[type=date]')) openPicker(e.target);
});

// ---- 一覧での直接編集（ダブルクリック／ダブルタップ） ----
const EDITABLE = new Set(['name', 'chassis_no', 'color', 'color_code', 'mileage', 'own_date', 'venue',
  'event_date', 'shipped_date', 'sales_points', 'has_warranty', 'has_manual', 'notes']);
const DATE_KEYS = new Set(['own_date', 'event_date', 'shipped_date']);
const VENUES = ['名古屋', '静岡', '廃車'];
let editing = null; // { td, item, key }

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = 'toast'; }, 2500);
}

async function saveField(item, patch) {
  try {
    const row = await api(`/api/items/${item.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    Object.assign(item, row);
    toast('保存しました');
    if ('event_date' in patch || 'shipped_date' in patch) loadDateCounts();
  } catch (err) {
    toast(err.message, true);
  }
}

function finishEdit(save) {
  if (!editing) return;
  const { td, item, key, read } = editing;
  editing = null;
  const patch = save ? read() : null;
  const changed = patch && Object.keys(patch).some((k) => String(patch[k] ?? '') !== String(item[k] ?? ''));
  const done = changed ? saveField(item, patch) : Promise.resolve();
  done.then(() => {
    td.classList.remove('editing');
    td.innerHTML = cellHtml(item, key);
  });
}

function startEdit(td) {
  if (editing) finishEdit(true);
  const key = td.dataset.key;
  const item = state.items.find((i) => i.id == td.parentElement.dataset.id);
  if (!item || !EDITABLE.has(key)) return;

  // 保証書・取説はダブルクリックで あり／なし を切り替え
  if (key === 'has_warranty' || key === 'has_manual') {
    saveField(item, { [key]: !item[key] }).then(() => { td.innerHTML = cellHtml(item, key); });
    return;
  }

  let html, read;
  if (key === 'mileage') {
    html = `<span class="with-unit"><input type="text" inputmode="numeric" autocomplete="off" value="${esc(item.mileage ?? '')}">
      <select><option value="km">km</option><option value="mile">マイル</option></select></span>`;
    read = () => ({ mileage: td.querySelector('input').value, mileage_unit: td.querySelector('select').value });
  } else if (key === 'venue') {
    html = `<select><option value="">未選択</option>${VENUES.map((v) => `<option>${v}</option>`).join('')}</select>`;
    read = () => ({ venue: td.querySelector('select').value });
  } else if (key === 'sales_points' || key === 'notes') {
    html = `<textarea rows="3">${esc(item[key] ?? '')}</textarea>`;
    read = () => ({ [key]: td.querySelector('textarea').value });
  } else {
    const type = DATE_KEYS.has(key) ? 'date' : 'text';
    html = `<input type="${type}" value="${esc(item[key] ?? '')}"${key === 'color' ? ' list="dl-color"' : ''}>`;
    read = () => ({ [key]: td.querySelector('input').value });
  }
  td.classList.add('editing');
  td.innerHTML = html;
  if (key === 'mileage') td.querySelector('select').value = item.mileage_unit || 'km';
  if (key === 'venue') td.querySelector('select').value = item.venue || '';
  editing = { td, item, key, read };
  const first = td.querySelector('input, select, textarea');
  first.focus();
  if (first.type === 'date') openPicker(first);
  if (first.select && first.type === 'text') first.select();

  td.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
    else if (e.key === 'Enter' && !e.isComposing && (e.target.tagName !== 'TEXTAREA' || e.ctrlKey || e.metaKey)) {
      e.preventDefault(); finishEdit(true);
    }
  });
  // セルの外に出たら保存（距離の数値→単位の移動では保存しない）
  td.addEventListener('focusout', (e) => {
    if (td.contains(e.relatedTarget)) return;
    setTimeout(() => { if (editing && editing.td === td) finishEdit(true); }, 0);
  });
  // 会場・日付は選んだ時点で保存
  if (key === 'venue') td.querySelector('select').addEventListener('change', () => finishEdit(true));
  if (DATE_KEYS.has(key)) td.querySelector('input').addEventListener('change', () => finishEdit(true));
}

// スマホでも確実に動くよう、2回のクリックの間隔で判定する
let lastTap = { td: null, t: 0 };
$('#tbl').addEventListener('click', (e) => {
  if (e.target.closest('thead')) return;
  const open = e.target.closest('[data-open]');
  if (open) { openForm(state.items.find((i) => i.id == open.dataset.open)); return; }
  const td = e.target.closest('td.editable');
  if (!td || td.classList.contains('editing')) return;
  const now = Date.now();
  if (lastTap.td === td && now - lastTap.t < 400) {
    lastTap = { td: null, t: 0 };
    startEdit(td);
  } else {
    lastTap = { td, t: now };
  }
});

let timer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(timer);
  timer = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 250);
});

load();

// ---- 依頼する（メール / PDF） ----
// 対象は表に表示中の車両（検索・日付の絞り込み・並び順をそのまま反映）
const REQ_FIELDS = [
  ['name', '車名'], ['chassis_no', '車台番号'], ['color', '色'], ['color_code', 'カラーコード'],
  ['mileage', '走行距離'], ['own_date', '自社名'], ['venue', '会場'], ['event_date', '開催日'], ['shipped_date', '出庫日'],
];
const DATE_FIELDS_REQ = new Set(['own_date', 'event_date', 'shipped_date']);
// 一覧印刷はすべての項目（No. は通し番号）
const LIST_FIELDS = COLS.filter(([k]) => k !== 'id').map(([k, l]) => [k, l]);
const WIDE_FIELDS = new Set(['sales_points', 'notes']);
const CENTER_FIELDS = new Set(['venue', 'has_warranty', 'has_manual']);
const reqVal = (it, k) => k === 'mileage' ? (fmtMileage(it) ?? '')
  : k === 'has_warranty' || k === 'has_manual' ? (it[k] ? '✓' : '')
  : k === 'created_at' ? mdDate(jstDate(it.created_at))
  : DATE_FIELDS_REQ.has(k) ? (it[k] ? `${mdDate(it[k])}(${WD[dow(it[k])]})` : '')
  : (it[k] ?? '');
const todayLabel = () => { const t = jstToday(); return `${mdDate(t)}(${WD[dow(t)]})`; };
function filterLabel() {
  const f = [];
  if (state.event_date) f.push(`開催日 ${shortDate(state.event_date)}`);
  if (state.shipped_date) f.push(`出庫日 ${shortDate(state.shipped_date)}`);
  if (state.q) f.push(`検索「${state.q}」`);
  return f.join('／');
}

function requestText(items) {
  const head = [`【依頼】${todayLabel()}`];
  const fl = filterLabel();
  if (fl) head.push(`対象：${fl}`);
  head.push(`全${items.length}台`);
  const body = items.map((it, i) => [`■${i + 1}台目`, ...REQ_FIELDS.map(([k, l]) => `${l}：${reqVal(it, k) || '－'}`)].join('\n'));
  return [head.join('\n'), ...body].join('\n\n') + '\n\nよろしくお願いいたします。';
}

const POPUP_STYLE = `body{font-family:system-ui,-apple-system,"Hiragino Sans","Noto Sans JP",sans-serif;margin:0;padding:16px;color:#1d2330;background:#fff}
button{font:inherit;padding:8px 16px;border-radius:8px;border:1px solid #c9ced6;background:#fff;cursor:pointer}
button.primary{background:#2563eb;border-color:#2563eb;color:#fff}`;

function openMailWindow(items) {
  const text = requestText(items);
  const w = window.open('', '_blank', 'width=560,height=760');
  if (!w) { toast('ポップアップがブロックされました。ブラウザの設定で許可してください', true); return; }
  w.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>依頼文（${items.length}台）</title><style>${POPUP_STYLE}
.bar{display:flex;gap:8px;align-items:center;margin-bottom:10px;flex-wrap:wrap}
textarea{width:100%;box-sizing:border-box;height:calc(100vh - 90px);font:inherit;font-size:15px;line-height:1.6;padding:10px;border:1px solid #c9ced6;border-radius:8px}
#msg{color:#15803d}</style></head><body>
<div class="bar"><button class="primary" id="copy">コピーする</button><a id="mail" href="#"><button type="button">メールアプリで開く</button></a><span id="msg"></span></div>
<textarea id="t"></textarea></body></html>`);
  w.document.close();
  const ta = w.document.getElementById('t');
  ta.value = text;
  const subject = `【依頼】${todayLabel()} ${items.length}台`;
  w.document.getElementById('mail').href = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(text)}`;
  w.document.getElementById('copy').addEventListener('click', async () => {
    const msg = w.document.getElementById('msg');
    try {
      await w.navigator.clipboard.writeText(ta.value);
    } catch {
      ta.select(); w.document.execCommand('copy');
    }
    msg.textContent = 'コピーしました。メールやLINEに貼り付けてください';
  });
  ta.focus();
}

function openPdfWindow(items, fields = REQ_FIELDS, title = '依頼一覧') {
  const w = window.open('', '_blank', 'width=1000,height=760');
  if (!w) { toast('ポップアップがブロックされました。ブラウザの設定で許可してください', true); return; }
  const fl = filterLabel();
  const cls = (k) => k === 'mileage' ? ' class="r"' : WIDE_FIELDS.has(k) ? ' class="w"' : CENTER_FIELDS.has(k) ? ' class="c"' : '';
  const rows = items.map((it, i) => `<tr><td class="n">${i + 1}</td>${fields.map(([k]) => `<td${cls(k)}>${esc(reqVal(it, k))}</td>`).join('')}</tr>`).join('');
  w.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8">
<title>${title}_${jstToday()}</title><style>${POPUP_STYLE}
@page{size:A4 landscape;margin:12mm}
h1{font-size:18px;margin:0 0 4px}.sub{font-size:12px;color:#444;margin:0 0 10px}
table{border-collapse:collapse;width:100%;font-size:11px}
th,td{border:1px solid #888;padding:4px 6px;text-align:left;vertical-align:top}
th{background:#eef0f3}td.n{text-align:right;width:2em}td.r{text-align:right;white-space:nowrap}th,td{white-space:nowrap}td.w{white-space:normal;min-width:10em}.c{text-align:center}
tr{break-inside:avoid}thead{display:table-header-group}
.bar{margin-bottom:12px;display:flex;gap:8px;align-items:center}
@media print{.bar{display:none}body{padding:0}}</style></head><body>
<div class="bar"><button class="primary" onclick="print()">印刷 / PDFで保存</button><span style="font-size:13px;color:#555">印刷画面で「送信先：PDFに保存」を選ぶとPDFになります</span></div>
<h1>${title}</h1>
<p class="sub">${esc(todayLabel())}　全${items.length}台${fl ? '　対象：' + esc(fl) : ''}</p>
<table><thead><tr><th>No.</th>${fields.map(([k, l]) => `<th${CENTER_FIELDS.has(k) ? ' class="c"' : ''}>${l}</th>`).join('')}</tr></thead><tbody>${rows}</tbody></table>
</body></html>`);
  w.document.close();
  w.focus();
  setTimeout(() => w.print(), 300);
}

const reqMenu = $('#req-menu');
$('#btn-request').addEventListener('click', (e) => {
  e.stopPropagation();
  reqMenu.hidden = !reqMenu.hidden;
});
document.addEventListener('click', () => { reqMenu.hidden = true; });
reqMenu.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-req]');
  if (!b) return;
  reqMenu.hidden = true;
  const items = sortedItems();
  if (!items.length) { toast('表に車両がありません', true); return; }
  if (b.dataset.req === 'mail') openMailWindow(items);
  else openPdfWindow(items);
});

// ---- 音声入力（セールスポイント） ----
// ブラウザ内蔵の音声認識（Chrome / Android、iPhone の Safari などで利用可）
const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
let rec = null;
let recBtn = null;

function stopVoice() {
  if (rec) { try { rec.stop(); } catch { /* 停止済み */ } }
}

function startVoice(btn) {
  const ta = document.getElementById(btn.dataset.target);
  const status = btn.closest('.field-voice').querySelector('.voice-status');
  rec = new SpeechRec();
  rec.lang = 'ja-JP';
  rec.interimResults = true;
  rec.continuous = true;
  recBtn = btn;
  let base = ta.value;

  rec.onstart = () => {
    btn.setAttribute('aria-pressed', 'true');
    btn.textContent = '■ 停止';
    status.textContent = '聞き取り中…話し終わったら「停止」を押してください';
  };
  rec.onresult = (e) => {
    let finalText = '', interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    if (finalText) {
      const sep = base && !/[、。\s]$/.test(base) ? '、' : '';
      base = base + sep + finalText.trim();
      ta.value = base;
      ta.dispatchEvent(new Event('input', { bubbles: true }));
    }
    status.innerHTML = interim ? `<span class="interim">${esc(interim)}</span>` : '聞き取り中…';
  };
  rec.onerror = (e) => {
    const msg = {
      'not-allowed': 'マイクの使用が許可されていません。ブラウザの設定でマイクを許可してください',
      'service-not-allowed': 'マイクの使用が許可されていません。ブラウザの設定でマイクを許可してください',
      'no-speech': '音声が聞き取れませんでした。もう一度お試しください',
      'audio-capture': 'マイクが見つかりません',
      'network': '通信エラーで音声認識できませんでした',
    }[e.error] || `音声入力エラー（${e.error}）`;
    status.textContent = msg;
  };
  rec.onend = () => {
    btn.setAttribute('aria-pressed', 'false');
    btn.textContent = '🎤 音声入力';
    if (status.textContent.startsWith('聞き取り中') || status.querySelector('.interim')) status.textContent = '';
    rec = null; recBtn = null;
  };
  try { rec.start(); } catch (err) { status.textContent = '音声入力を開始できませんでした'; }
}

document.querySelectorAll('.mic').forEach((btn) => {
  if (!SpeechRec) {
    btn.addEventListener('click', () => {
      btn.closest('.field-voice').querySelector('.voice-status').textContent =
        'このブラウザは音声入力に対応していません。キーボードのマイクボタンをお使いください';
    });
    return;
  }
  btn.addEventListener('click', () => {
    if (rec && recBtn === btn) stopVoice(); else { stopVoice(); startVoice(btn); }
  });
});
// フォームを閉じたら音声入力も止める
dlg.addEventListener('close', () => {
  stopVoice();
  document.querySelectorAll('.voice-status').forEach((s) => { s.textContent = ''; });
});

// ---- コーションプレート撮影 → 車台番号・カラーコードを自動入力 ----
// 写真は保存せず、読み取りにだけ使う
async function shrinkImage(file, max = 1600) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * scale);
  c.height = Math.round(bmp.height * scale);
  c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
  bmp.close?.();
  return c.toDataURL('image/jpeg', 0.85);
}

function resetPlateScan() {
  $('.scan-result').hidden = true;
  $('#plate-status').textContent = '';
  $('#plate-file').value = '';
  form.querySelectorAll('input.filled').forEach((el) => el.classList.remove('filled'));
}
dlg.addEventListener('close', resetPlateScan);

$('#plate-file').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (!file) return;
  const status = $('#plate-status');
  form.querySelectorAll('input.filled').forEach((el) => el.classList.remove('filled'));
  $('.scan-result').hidden = false;
  status.className = '';
  status.textContent = '読み取り中…（数秒かかります）';
  try {
    const image = await shrinkImage(file);
    $('#plate-preview').src = image;
    const r = await api('/api/ocr-plate', { method: 'POST', body: JSON.stringify({ image }) });
    const got = [];
    for (const [k, label] of [['chassis_no', '車台番号'], ['color_code', 'カラーコード']]) {
      if (r[k]) {
        form.elements[k].value = r[k];
        form.elements[k].classList.add('filled');
        got.push(`${label} ${r[k]}`);
      }
    }
    if (got.length) {
      status.className = 'ok';
      status.textContent = `読み取りました：${got.join('、')}。間違いがないか確認してください`;
    } else {
      status.className = 'ng';
      status.textContent = '読み取れませんでした。明るい場所で、プレートが画面いっぱいになるよう撮り直してください';
    }
  } catch (err) {
    status.className = 'ng';
    status.textContent = `読み取りに失敗しました：${err.message}`;
  } finally {
    e.target.value = '';
  }
});
form.addEventListener('input', (e) => e.target.classList?.remove('filled'));

$('#btn-print').addEventListener('click', () => {
  const items = sortedItems();
  if (!items.length) { toast('表に車両がありません', true); return; }
  openPdfWindow(items, LIST_FIELDS, '在庫一覧');
});
