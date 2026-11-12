import { decodeCsv, parseCsv, csvToItems, isAuctionCsv, auctionToRows } from '/import-parse.js';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const STATUS = {
  new: ['新規', 'st-new'],
  fill: ['更新', 'st-fill'],
  exists: ['既存のためスキップ', 'st-skip'],
  duplicate: ['ファイル内で重複', 'st-skip'],
  error: ['エラー', 'st-err'],
};
let items = [];
let fileName = '';
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
  fileName = file.name;
  try {
    const rows = parseCsv(decodeCsv(await file.arrayBuffer()));
    // オークション結果（相場）のCSVなら別の取り込みへ
    if (isAuctionCsv(rows)) { await readAuction(rows); return; }
    $('#auction-box').hidden = true;
    items = csvToItems(rows);
    if (!items.length) throw new Error('車両データがありません');
    // まず判定だけ（保存はしない）
    const r = await api('/api/import', { items, dry_run: true, fill_empty: $('#fill-empty').checked, update_list_price: $('#update-list').checked, update_grade: $('#update-grade').checked });
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
    ${r.fill ? `<span class="pill st-fill">更新 ${r.fill} 台</span>` : ''}
    <span class="pill st-skip">既存（スキップ） ${r.exists} 台</span>
    ${r.duplicate ? `<span class="pill st-skip">ファイル内重複 ${r.duplicate} 台</span>` : ''}
    ${r.error ? `<span class="pill st-err">エラー ${r.error} 台</span>` : ''}
    <span class="muted">（全 ${items.length} 行）</span>`;
  $('#btn-import').textContent = r.fill ? `新規 ${r.new} 台を追加・${r.fill} 台を更新` : `新規 ${r.new} 台を追加する`;
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
      <td>${esc(it.first_reg)}</td><td>${esc(it.name)}</td><td>${esc(it.grade)}</td><td>${esc(it.chassis_no)}</td><td>${esc(it.color)}</td><td>${esc(it.color_code)}</td>
      <td class="num">${it.mileage != null ? Number(it.mileage).toLocaleString('ja-JP') + 'km' : ''}</td>
      <td class="num">${it.purchase_price ? '¥' + Number(it.purchase_price).toLocaleString('ja-JP') : ''}</td>
      <td class="num">${it.list_price ? '¥' + Math.round(it.list_price * 1.1).toLocaleString('ja-JP') : ''}</td>
</tr>`;
  }).join('') || `<tr><td colspan="11" class="empty">新規の車両はありません</td></tr>`;
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
    const r = await api('/api/import', { items, file_name: fileName, dry_run: false, fill_empty: $('#fill-empty').checked, update_list_price: $('#update-list').checked, update_grade: $('#update-grade').checked });
    results = r.results;
    toast(`${r.added} 台を追加${r.filled ? `・${r.filled} 台を更新しました` : 'しました'}（スキップ ${r.exists + r.duplicate} 台）`);
    $('#preview').hidden = true;
    $('#summary').textContent = '';
    $('#drop').insertAdjacentHTML('afterend',
      `<p class="up-done">✅ ${r.added} 台を在庫に追加しました。${r.filled ? `${r.filled} 台を更新しました。` : ''}スキップ ${r.exists + r.duplicate} 台${r.error ? `、エラー ${r.error} 台` : ''}。<a href="/">在庫一覧を見る</a></p>`);
  } catch (e) {
    toast(`追加できませんでした：${e.message}`, true);
    render(summaryFrom(results));
  }
});

// チェックを切り替えたら判定し直す
async function recheck() {
  if (!items.length) return;
  try {
    const r = await api('/api/import', { items, dry_run: true, fill_empty: $('#fill-empty').checked, update_list_price: $('#update-list').checked, update_grade: $('#update-grade').checked });
    results = r.results;
    render(r);
  } catch (e) { toast(e.message, true); }
}
$('#fill-empty').addEventListener('change', recheck);
$('#update-list').addEventListener('change', recheck);
$('#update-grade').addEventListener('change', recheck);

// 最後に取り込んだ日時
fetch('/api/import').then((r) => r.json()).then(({ last_import: li }) => {
  if (!li) return;
  const d = new Date(li.at);
  const t = d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo', month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' });
  $('#last-import').textContent = `前回の取り込み：${t}（追加 ${li.added} 台・更新 ${li.updated} 台${li.file ? '・' + li.file : ''}）`;
}).catch(() => {});

// ---- オークション結果（相場）の取り込み ----
let auctionRows = [];
async function readAuction(rows) {
  auctionRows = auctionToRows(rows);
  if (!auctionRows.length) throw new Error('オークション結果のデータがありません');
  $('#preview').hidden = true;
  const r = await api('/api/market-import', { rows: auctionRows, dry_run: true });
  const dates = [...new Set(auctionRows.map((x) => x.auction_date))].sort();
  $('#auction-box').hidden = false;
  $('#auction-summary').innerHTML = `オークション結果のCSVです（${esc(fileName)}）<br>
    全 <b>${r.total}</b> 件・開催日 ${esc(dates[0])} 〜 ${esc(dates[dates.length - 1])}<br>
    <span class="pill st-new">新規 ${r.new} 件</span> <span class="pill st-skip">取り込み済み ${r.duplicate} 件</span>`;
  $('#btn-auction').disabled = !r.new;
  $('#btn-auction').textContent = r.new ? `相場データ ${r.new} 件を取り込む` : '新しい結果はありません';
}
$('#btn-auction').addEventListener('click', async () => {
  const btn = $('#btn-auction');
  btn.disabled = true;
  btn.textContent = '取り込んでいます…';
  try {
    const r = await api('/api/market-import', { rows: auctionRows, file_name: fileName, dry_run: false });
    $('#auction-summary').innerHTML = `✅ 相場データを <b>${r.new}</b> 件取り込みました（取り込み済み ${r.duplicate} 件はスキップ）。<a href="/">在庫一覧を見る</a>`;
    btn.textContent = '取り込み完了';
  } catch (e) {
    toast(`取り込めませんでした：${e.message}`, true);
    btn.disabled = false;
  }
});

// ---- バックアップから復元（移設先の空のサイトで使う） ----
$('#restore-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  const msg = $('#restore-msg');
  msg.textContent = '復元しています…';
  try {
    const text = await f.text();
    const r = await fetch('/api/restore', { method: 'POST', headers: { 'content-type': 'application/json' }, body: text });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(d.error || `エラー (${r.status})`);
    msg.innerHTML = `✅ 復元しました：在庫 ${d.restored.items} 台・AA結果 ${d.restored.auction_results} 件。<a href="/">在庫一覧を見る</a>`;
  } catch (err) {
    msg.textContent = `復元できませんでした：${err.message}`;
  }
});
