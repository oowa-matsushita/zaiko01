import { decodeCsv, parseCsv, csvToItems } from '/import-parse.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = {
  new: ['新規', 'st-new'],
  fill: ['空欄を補う', 'st-fill'],
  exists: ['既存のためスキップ', 'st-skip'],
  duplicate: ['ファイル内で重複', 'st-skip'],
  error: ['エラー', 'st-err'],
};
let items = [];
let results = [];

function toast(msg, isError = false) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = 'toast'; }, 3500);
}

async function api(path, body) {
  const res = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && data.login) { location.href = '/login'; throw new Error('ログインしてください'); }
  if (!res.ok) throw new Error(data.error || `エラー (${res.status})`);
  return data;
}

async function readFile(file) {
  try {
    const rows = parseCsv(decodeCsv(await file.arrayBuffer()));
    items = csvToItems(rows);
    if (!items.length) throw new Error('車両データがありません');
    // まず判定だけ（保存はしない）
    const r = await api('/api/import', { items, dry_run: true, fill_empty: $('#fill-empty').checked });
    results = r.results;
    render(r);
  } catch (e) {
    toast(`読み込めませんでした：${e.message}`, true);
  }
}

function render(r) {
  $('#preview').hidden = false;
  $('#summary').innerHTML = `
    <span class="pill st-new">新規 ${r.new} 台</span>
    ${r.fill ? `<span class="pill st-fill">空欄を補う ${r.fill} 台</span>` : ''}
    <span class="pill st-skip">既存（スキップ） ${r.exists} 台</span>
    ${r.duplicate ? `<span class="pill st-skip">ファイル内重複 ${r.duplicate} 台</span>` : ''}
    ${r.error ? `<span class="pill st-err">エラー ${r.error} 台</span>` : ''}
    <span class="muted">（全 ${items.length} 行）</span>`;
  $('#btn-import').textContent = r.fill ? `新規 ${r.new} 台を追加・${r.fill} 台の空欄を補う` : `新規 ${r.new} 台を追加する`;
  $('#btn-import').disabled = !r.new && !r.fill;
  const onlyNew = $('#only-new').checked;
  const byLine = new Map(results.map((x) => [x.line, x]));
  $('#up-tbl tbody').innerHTML = items.map((it) => {
    const res = byLine.get(it.line) || { status: 'error' };
    if (onlyNew && res.status !== 'new' && res.status !== 'fill') return '';
    const [label, cls] = STATUS[res.status];
    return `<tr class="${cls}">
      <td class="num">${it.line}</td>
      <td><span class="pill ${cls}">${label}</span>${res.message ? `<div class="muted small">${esc(res.message)}</div>` : ''}</td>
      <td>${esc(it.first_reg)}</td><td>${esc(it.name)}</td><td>${esc(it.chassis_no)}</td><td>${esc(it.color)}</td><td>${esc(it.color_code)}</td>
      <td class="num">${it.mileage != null ? Number(it.mileage).toLocaleString('ja-JP') + 'km' : ''}</td>
      <td class="num">${it.purchase_price ? '¥' + Number(it.purchase_price).toLocaleString('ja-JP') : ''}</td>
</tr>`;
  }).join('') || `<tr><td colspan="9" class="empty">新規の車両はありません</td></tr>`;
}

$('#file').addEventListener('change', (e) => { const f = e.target.files[0]; if (f) readFile(f); e.target.value = ''; });
const drop = $('#drop');
drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
drop.addEventListener('dragleave', () => drop.classList.remove('over'));
drop.addEventListener('drop', (e) => {
  e.preventDefault(); drop.classList.remove('over');
  const f = e.dataTransfer.files[0];
  if (f) readFile(f);
});
$('#only-new').addEventListener('change', () => render(summaryFrom(results)));
$('#btn-cancel-up').addEventListener('click', () => { $('#preview').hidden = true; items = []; results = []; });

function summaryFrom(res) {
  const c = (s) => res.filter((x) => x.status === s).length;
  return { new: c('new'), fill: c('fill'), exists: c('exists'), duplicate: c('duplicate'), error: c('error') };
}

$('#btn-import').addEventListener('click', async () => {
  const btn = $('#btn-import');
  btn.disabled = true;
  btn.textContent = '追加しています…';
  try {
    const r = await api('/api/import', { items, dry_run: false, fill_empty: $('#fill-empty').checked });
    results = r.results;
    toast(`${r.added} 台を追加${r.filled ? `・${r.filled} 台の空欄を補いました` : 'しました'}（スキップ ${r.exists + r.duplicate} 台）`);
    $('#preview').hidden = true;
    $('#summary').textContent = '';
    $('#drop').insertAdjacentHTML('afterend',
      `<p class="up-done">✅ ${r.added} 台を在庫に追加しました。${r.filled ? `${r.filled} 台の空欄を補いました。` : ''}スキップ ${r.exists + r.duplicate} 台${r.error ? `、エラー ${r.error} 台` : ''}。<a href="/">在庫一覧を見る</a></p>`);
  } catch (e) {
    toast(`追加できませんでした：${e.message}`, true);
    render(summaryFrom(results));
  }
});

// 「空欄を補う」を切り替えたら判定し直す
$('#fill-empty').addEventListener('change', async () => {
  if (!items.length) return;
  try {
    const r = await api('/api/import', { items, dry_run: true, fill_empty: $('#fill-empty').checked });
    results = r.results;
    render(r);
  } catch (e) { toast(e.message, true); }
});
