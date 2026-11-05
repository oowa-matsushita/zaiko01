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
const state = { q: '', items: [] };

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

async function load() {
  const p = new URLSearchParams({ sort: 'created_desc', limit: '1000' });
  if (state.q) p.set('q', state.q);
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
  ['own_date', '自社', 'date'],
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
    case 'own_date': case 'event_date': case 'shipped_date': return esc(mdDate(it[k]));
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
  const colors = [...new Set(state.items.map((i) => i.color).filter(Boolean))].sort();
  $('#dl-color').innerHTML = colors.map((v) => `<option value="${esc(v)}">`).join('');
  renderHead();
  if (!state.items.length) {
    $('#list').innerHTML = `<tr><td class="empty" colspan="${COLS.length}">${state.q ? '該当する車両がありません' : 'まだ登録がありません。「＋ 買取登録」から追加してください'}</td></tr>`;
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
    COLS.map(([k, , cls]) => `<td class="${cls || ''}">${cellHtml(it, k)}</td>`).join('')
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

$('#list').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-id]');
  if (tr) openForm(state.items.find((i) => i.id == tr.dataset.id));
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
    ['own_date', '自社'], ['venue', '会場'], ['event_date', '開催日'], ['shipped_date', '出庫日'],
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
