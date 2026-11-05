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
    $('#list').innerHTML = `<tr><td class="empty" colspan="${COLS.length}">読み込みに失敗しました：${esc(e.message)}</td></tr>`;
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
  ['own_company', '自社名'],
  ['venue', '会場', 'center'],
  ['event_date', '開催日', 'date'],
  ['shipped_date', '出庫日', 'date'],
  ['sales_points', 'セールスポイント', 'wrap'],
  ['has_warranty', '保証書', 'center'],
  ['has_manual', '取説', 'center'],
  ['notes', 'メモ', 'wrap'],
  ['created_at', '登録日'],
];
const sortState = { key: 'id', dir: -1 };
// 並び替え用の値（マイルは km に換算して比較）
const sortVal = (it, k) => k === 'mileage'
  ? (it.mileage == null ? null : it.mileage_unit === 'mile' ? it.mileage * KM_PER_MILE : it.mileage)
  : it[k];
const cellHtml = (it, k) => {
  switch (k) {
    case 'mileage': return esc(fmtMileage(it) ?? '');
    case 'has_warranty': case 'has_manual': return it[k] ? '✓' : '';
    case 'created_at': return esc(jstDate(it.created_at));
    case 'event_date': case 'shipped_date': return esc(mdDate(it[k]));
    default: return esc(it[k] ?? '');
  }
};

function renderHead() {
  $('#tbl thead tr').innerHTML = COLS.map(([k, label, cls]) => {
    const arrow = sortState.key === k ? (sortState.dir > 0 ? '▲' : '▼') : '';
    return `<th data-key="${k}" class="${cls === 'sticky' || cls === 'center' ? cls : ''}">${label}<span class="arrow">${arrow}</span></th>`;
  }).join('');
}

function render({ total }) {
  $('#count').textContent = `${total} 台`;
  for (const [k, id] of [['color', '#dl-color'], ['own_company', '#dl-company']]) {
    const vals = [...new Set(state.items.map((i) => i[k]).filter(Boolean))].sort();
    $(id).innerHTML = vals.map((v) => `<option value="${esc(v)}">`).join('');
  }
  renderHead();
  if (!state.items.length) {
    $('#list').innerHTML = `<tr><td class="empty" colspan="${COLS.length}">${state.q || state.event_date || state.shipped_date ? '該当する車両がありません' : 'まだ登録がありません。「＋ 買取登録」から追加してください'}</td></tr>`;
    return;
  }
  const { key, dir } = sortState;
  const rows = [...state.items].sort((a, b) => {
    const x = sortVal(a, key), y = sortVal(b, key);
    if (x == null || x === '') return 1;
    if (y == null || y === '') return -1;
    return (typeof x === 'number' ? x - y : String(x).localeCompare(String(y), 'ja')) * dir;
  });
  $('#list').innerHTML = rows.map((it) => `<tr data-id="${it.id}">${
    COLS.map(([k, , cls]) => k === 'id'
      ? `<td class="rowno"><button class="edit-btn" data-open="${it.id}" title="フォームで編集" aria-label="フォームで編集">✎</button>${it.id}</td>`
      : `<td class="${cls || ''}${EDITABLE.has(k) ? ' editable' : ''}" data-key="${k}">${cellHtml(it, k)}</td>`).join('')
  }</tr>`).join('');
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
    ? `約 ${num(Math.round(Number(mv) * KM_PER_MILE))} km` : '';
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

// 日付欄はクリックでカレンダーを開く
function openPicker(input) {
  try { input.showPicker(); } catch { /* 未対応ブラウザは標準の動作 */ }
}
document.addEventListener('click', (e) => {
  if (e.target.matches?.('input[type=date]')) openPicker(e.target);
});

// ---- 一覧での直接編集（ダブルクリック／ダブルタップ） ----
const EDITABLE = new Set(['name', 'chassis_no', 'color', 'color_code', 'mileage', 'own_company', 'venue',
  'event_date', 'shipped_date', 'sales_points', 'has_warranty', 'has_manual', 'notes']);
const DATE_KEYS = new Set(['event_date', 'shipped_date']);
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
    html = `<span class="with-unit"><input type="number" inputmode="numeric" min="0" value="${esc(item.mileage ?? '')}">
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
    html = `<input type="${type}" value="${esc(item[key] ?? '')}"${key === 'color' ? ' list="dl-color"' : key === 'own_company' ? ' list="dl-company"' : ''}>`;
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
$('#list').addEventListener('click', (e) => {
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

// ---- CSV出力（表示中の一覧） ----
$('#btn-csv').addEventListener('click', () => {
  const cols = [['id', 'ID'], ['name', '車名'], ['chassis_no', '車台番号'], ['color', '色'], ['color_code', 'カラーコード'],
    ['mileage', '走行距離'], ['mileage_unit', '距離単位'], ['sales_points', 'セールスポイント'],
    ['own_company', '自社名'], ['venue', '会場'], ['event_date', '開催日'], ['shipped_date', '出庫日'],
    ['has_warranty', '保証書'], ['has_manual', '取説'], ['notes', 'メモ'], ['created_at', '登録日時']];
  const cell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const val = (it, k) => k === 'has_warranty' || k === 'has_manual' ? (it[k] ? 'あり' : 'なし')
    : k === 'mileage_unit' ? (it[k] === 'mile' ? 'マイル' : 'km') : it[k];
  const lines = [cols.map((c) => cell(c[1])).join(',')]
    .concat(state.items.map((it) => cols.map(([k]) => cell(val(it, k))).join(',')));
  const blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv' });
  const d = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: `zaiko_${d}.csv` });
  a.click();
  URL.revokeObjectURL(a.href);
});

load();
