const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const KM_PER_MILE = 1.609344;
const num = (n) => Number(n).toLocaleString('ja-JP');
const fmtMileage = (it) => it.mileage == null ? null
  : it.mileage_unit === 'mile'
    ? `${num(it.mileage)}マイル（約${num(Math.round(it.mileage * KM_PER_MILE))}km）`
    : `${num(it.mileage)}km`;

const state = { q: '', sort: 'created_desc', items: [] };

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

async function load() {
  const p = new URLSearchParams({ sort: state.sort, limit: '1000' });
  if (state.q) p.set('q', state.q);
  try {
    const data = await api('/api/items?' + p);
    state.items = data.items;
    render(data);
  } catch (e) {
    $('#list').innerHTML = `<li class="empty">読み込みに失敗しました：${esc(e.message)}</li>`;
  }
}

function render({ items, total }) {
  $('#count').textContent = `${total} 台`;
  const colors = [...new Set(items.map((i) => i.color).filter(Boolean))].sort();
  $('#dl-color').innerHTML = colors.map((v) => `<option value="${esc(v)}">`).join('');
  if (!items.length) {
    $('#list').innerHTML = `<li class="empty">${state.q ? '該当する車両がありません' : 'まだ登録がありません。「＋ 買取登録」から追加してください'}</li>`;
    return;
  }
  $('#list').innerHTML = items.map((it) => {
    const color = [it.color, it.color_code && `(${it.color_code})`].filter(Boolean).join(' ');
    const meta = [it.chassis_no, color].filter(Boolean).map(esc).join(' ・ ');
    const tags = (it.has_warranty ? '<span class="tag">保証書</span>' : '') + (it.has_manual ? '<span class="tag">取説</span>' : '');
    return `<li class="item" data-id="${it.id}">
      <div>
        <div class="name">${esc(it.name)}</div>
        ${meta ? `<div class="meta">${meta}</div>` : ''}
        ${it.sales_points ? `<div class="points">${esc(it.sales_points)}</div>` : ''}
        ${tags ? `<div>${tags}</div>` : ''}
      </div>
      <div class="right">${it.mileage != null ? `<div class="price">${esc(fmtMileage(it))}</div>` : ''}</div>
    </li>`;
  }).join('');
}

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
  const li = e.target.closest('.item');
  if (li) openForm(state.items.find((i) => i.id == li.dataset.id));
});

let timer;
$('#q').addEventListener('input', (e) => {
  clearTimeout(timer);
  timer = setTimeout(() => { state.q = e.target.value.trim(); load(); }, 250);
});
$('#sort').addEventListener('change', (e) => { state.sort = e.target.value; load(); });

// ---- CSV出力（表示中の一覧） ----
$('#btn-csv').addEventListener('click', () => {
  const cols = [['id', 'ID'], ['name', '車名'], ['chassis_no', '車台番号'], ['color', '色'], ['color_code', 'カラーコード'],
    ['mileage', '走行距離'], ['mileage_unit', '距離単位'], ['sales_points', 'セールスポイント'],
    ['has_warranty', '保証書'], ['has_manual', '取説'], ['notes', 'メモ']];
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
