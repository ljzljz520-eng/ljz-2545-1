import { api, store, toast, requireAuth } from '/js/api.js';
import { outbox, uuid } from '/js/offline.js';

const netEl = document.getElementById('net');
function updateNet() {
  const online = navigator.onLine;
  netEl.style.display = online ? 'none' : '';
  netEl.textContent = '当前处于离线状态：日记可先保存到本机待发队列，恢复网络后再同步。';
}
addEventListener('online', updateNet); addEventListener('offline', updateNet); updateNet();

async function loadPlots() {
  try {
    const plots = await api('GET', '/api/plots');
    const sel = document.getElementById('plot');
    sel.innerHTML = plots.map(p => `<option value="${p.id}">${p.code} ${p.name}</option>`).join('');
  } catch { document.getElementById('writeCard').style.display = 'none'; }
}
async function loadList() {
  const el = document.getElementById('list');
  try {
    const rows = await api('GET', '/api/diaries');
    if (!rows.length) { el.innerHTML = '<div class="muted">还没有日记</div>'; return; }
    el.innerHTML = rows.map(d => `
      <div style="border-left:3px solid var(--tea);padding:6px 12px;margin:10px 0;background:#fbfdf9;border-radius:0 8px 8px 0">
        <div><b>${d.entry_date}</b> ${d.weather ? `<span class="muted">· ${d.weather}</span>` : ''}
          <span class="muted">· ${d.plot_code || ''} ${d.farmer_name ? '· 农户 ' + d.farmer_name : ''}</span></div>
        <div>${d.body}</div>
      </div>`).join('');
  } catch (e) { el.innerHTML = '<div class="notice">离线且无缓存：登录后可查看完整日记。你仍可在右侧写日记，稍后同步。</div>'; }
}
async function refreshCount() {
  const items = await outbox.all();
  document.getElementById('qcount').textContent = items.length;
  document.getElementById('outbox').innerHTML = items.length
    ? items.map(i => `<div>· ${i.entry_date} ${i.body.slice(0, 20)}…</div>`).join('')
    : '待发队列为空';
}
document.getElementById('date').value = new Date().toISOString().slice(0, 10);
document.getElementById('save').onclick = async () => {
  const body = document.getElementById('body').value.trim();
  if (!body) return toast('请先写内容', true);
  const item = {
    client_uuid: uuid(), plot_id: Number(document.getElementById('plot').value),
    entry_date: document.getElementById('date').value, weather: document.getElementById('weather').value, body
  };
  await outbox.add(item);
  document.getElementById('body').value = '';
  toast(navigator.onLine ? '已存入待发队列，可点同步' : '离线已保存，恢复网络后同步');
  refreshCount();
};
document.getElementById('sync').onclick = async () => {
  if (!requireAuth()) return;
  const items = await outbox.all();
  if (!items.length) return toast('没有待同步内容');
  try {
    await api('POST', '/api/diaries/sync', { items });
    for (const i of items) await outbox.remove(i.client_uuid);
    toast(`同步成功 ${items.length} 条（服务端按 client_uuid 幂等去重）`);
    refreshCount(); loadList();
  } catch (e) { toast('同步失败：' + e.message, true); }
};
loadPlots().then(refreshCount);
loadList();
