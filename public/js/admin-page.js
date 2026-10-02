import { api, store, fmt, toast, requireAuth } from '/js/api.js';
import { HillMap } from '/js/hillmap.js';

if (!requireAuth()) throw new Error('redirect');
const isAdmin = store.user.role === 'admin';
document.getElementById('who').textContent = `${store.user.display_name}（${store.user.role}）`;
document.getElementById('logout').onclick = () => { store.token = ''; store.user = null; location.href = '/'; };
if (!isAdmin) {
  const p = document.getElementById('perm');
  p.style.display = '';
  p.innerHTML = '当前为 <b>运营（staff）</b> 账号：可查看地块/认养/对应/检测，但写操作（建地块、认养、拆分合并、纠偏、附件、送礼）仅限管理员。';
}
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach(x => x.classList.toggle('active', x === b));
  document.querySelectorAll('section[data-pane]').forEach(s => s.style.display = s.dataset.pane === b.dataset.tab ? '' : 'none');
  const fn = { plots: loadPlots, adopt: loadAdopt, corr: loadCorr, farm: loadFarm, gift: loadGift }[b.dataset.tab];
  if (fn) fn();
});
const guard = (fn) => (...a) => { if (!isAdmin) return toast('仅管理员可执行此操作', true); return fn(...a); };

// ---------------- 地块 ----------------
let plotsCache = [];
async function loadPlots() {
  const date = document.getElementById('plotDate').value;
  const plots = await api('GET', `/api/plots`);
  plotsCache = plots;
  const el = document.getElementById('plotList');
  el.innerHTML = plots.map(p => {
    const c = p.current;
    return `<div class="card" style="box-shadow:none;margin:8px 0">
      <div class="row" style="justify-content:space-between">
        <div><b>${p.code} ${p.name}</b>
          <span class="badge ${p.status === 'superseded' ? 'danger' : ''}">${p.status === 'superseded' ? '已被取代' : '存续'}</span>
          ${c ? `<span class="muted">当前 v${c.version_no} · ${c.valid_from} 起 · ${c.area_m2}㎡ · 共 ${p.version_count} 个版本</span>` : '<span class="muted">无当前边界</span>'}
        </div>
        <div class="row">
          <button class="ghost" onclick="window._edit(${p.id})" ${!isAdmin ? 'disabled' : ''}>编辑边界 / 拆分</button>
          <button class="ghost" onclick="window._mergePick(${p.id})" ${!isAdmin ? 'disabled' : ''}>并入合并</button>
        </div>
      </div></div>`;
  }).join('');
  window._edit = (id) => openEditor(id);
  window._mergePick = (id) => mergePick(id);
  fillSelect('aPlot', plots, p => [p.id, `${p.code} ${p.name}`], p => p.current);
  fillSelect('gPlot', plots, p => [p.id, `${p.code} ${p.name}`], p => p.current);
  fillSelect('pkPlot', plots, p => [p.id, p.code], p => p.current);
}
document.getElementById('refreshPlots').onclick = loadPlots;
document.getElementById('plotDate').onchange = loadPlots;
document.getElementById('newPlot').onclick = guard(async () => {
  const name = prompt('地块名称'); if (!name) return;
  // 默认生成一块 40x40 的新地（放在随机偏移，仅演示）
  const ox = Math.round(Math.random() * 200 - 50), oy = Math.round(Math.random() * 120);
  const geom = { type: 'Polygon', coordinates: [[[ox, oy], [ox + 40, oy], [ox + 40, oy + 40], [ox, oy + 40]]] };
  try { await api('POST', '/api/plots', { name, geometry: geom, valid_from: new Date().toISOString().slice(0, 10) });
    toast('已创建地块 v1'); loadPlots();
  } catch (e) { toast(e.message, true); }
});

// ---------------- 编辑器（拆分 / 纠偏） ----------------
let edMap = null, edCtx = null, mergeSet = new Set();
function fillSelect(id, arr, pair, filter) {
  const sel = document.getElementById(id); if (!sel) return;
  const cur = sel.value;
  sel.innerHTML = arr.filter(filter || (() => true)).map(x => { const [v, t] = pair(x); return `<option value="${v}">${t}</option>`; }).join('');
  if (cur) sel.value = cur;
}
async function openEditor(plotId) {
  const plot = plotsCache.find(p => p.id === plotId);
  if (!plot || !plot.current) return toast('该地块无当前边界');
  const dlg = document.getElementById('editor');
  document.getElementById('edTitle').textContent = `编辑：${plot.code} ${plot.name}`;
  dlg.showModal();
  await new Promise(r => setTimeout(r, 30));
  edMap = new HillMap(document.getElementById('edMap'), { onPick: () => {} });
  edMap.fit([{ geometry: plot.current.geometry }]); edMap.setFeatures([{ ...plot.current, plot_id: plot.id, code: plot.code, plot_name: plot.name, plot_status: plot.status, slope_zone: plot.slope_zone }]);
  edCtx = { plot, versionId: plot.current.id, mode: null, points: [] };
  try {
    const lock = await api('POST', `/api/versions/${plot.current.id}/lock`, { ttl_sec: 120 });
    document.getElementById('edLock').textContent = `🔒 已占用该版本至 ${new Date(lock.lease_until).toLocaleTimeString()}（120 秒租约）`;
  } catch (e) {
    document.getElementById('edLock').innerHTML = `<span style="color:var(--red)">⚠ ${e.message}</span>`;
  }
  document.getElementById('edMap').onclick = (e) => {
    if (!edCtx || edCtx.mode !== 'split' || edCtx.points.length >= 2) return;
    const rect = e.target.getBoundingClientRect();
    const p = edMap.unproject([e.clientX - rect.left, e.clientY - rect.top]);
    edCtx.points.push(p);
    drawEditorOverlay();
    if (edCtx.points.length === 2) document.getElementById('edLock').textContent = '切线已定（两点），点击“提交（带版本条件）”执行拆分';
  };
}
function drawEditorOverlay() {
  const svg = document.getElementById('edMap');
  let layer = svg.querySelector('#splitLayer');
  if (!layer) {
    layer = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    layer.id = 'splitLayer'; svg.appendChild(layer);
  }
  layer.innerHTML = '';
  const ns = 'http://www.w3.org/2000/svg';
  const g = document.createElementNS(ns, 'g');
  g.setAttribute('transform', `translate(${edMap.view.x},${edMap.view.y}) scale(${edMap.view.k})`);
  edCtx.points.forEach(p => {
    const c = document.createElementNS(ns, 'circle');
    c.setAttribute('cx', p[0]); c.setAttribute('cy', p[1]); c.setAttribute('r', 2.2);
    c.setAttribute('fill', '#b23b2e'); g.appendChild(c);
  });
  if (edCtx.points.length === 2) {
    const [a, b] = edCtx.points;
    const line = document.createElementNS(ns, 'line');
    line.setAttribute('x1', a[0] - (b[1] - a[1]) * 50); line.setAttribute('y1', a[1] + (b[0] - a[0]) * 50);
    line.setAttribute('x2', a[0] + (b[1] - a[1]) * 50); line.setAttribute('y2', a[1] - (b[0] - a[0]) * 50);
    line.setAttribute('stroke', '#b23b2e'); line.setAttribute('stroke-width', '1.2'); line.setAttribute('stroke-dasharray', '4 3');
    g.appendChild(line);
  }
  layer.appendChild(g);
}
document.getElementById('edSplit').onclick = () => { if (edCtx) { edCtx.mode = 'split'; edCtx.points = []; toast('在图上点两个点确定拆分线'); } };
document.getElementById('edCorrect').onclick = () => toast('演示版纠偏：请在“认养/地块”接口中用 GeoJSON 提交（已支持版本条件提交）');
document.getElementById('edCancel').onclick = async () => {
  if (edCtx) await api('DELETE', `/api/versions/${edCtx.versionId}/lock`).catch(() => {});
  document.getElementById('editor').close(); edCtx = null;
};
document.getElementById('edSave').onclick = guard(async () => {
  if (!edCtx || edCtx.mode !== 'split' || edCtx.points.length !== 2) return toast('请先选择拆分并在图上点两点', true);
  const date = prompt('拆分生效日期 YYYY-MM-DD', new Date().toISOString().slice(0, 10));
  if (!date) return;
  try {
    const r = await api('POST', `/api/plots/${edCtx.plot.id}/split`, {
      line: { p1: edCtx.points[0], p2: edCtx.points[1] }, names: ['东坡', '西坡'], event_date: date, note: '后台地图编辑器拆分' });
    toast(`拆分完成，生成 ${r.new_plots.map(p => p.code).join('、')}；旧认养已按策略建立面积对应`);
    document.getElementById('editor').close(); edCtx = null; loadPlots();
  } catch (e) {
    if (e.status === 423) toast('并发占用：' + e.message, true);
    else if (e.status === 409) toast('版本冲突：' + e.message, true);
    else toast(e.message, true);
  }
});
async function mergePick(id) {
  if (mergeSet.size === 0 || !mergeSet.has(id)) { mergeSet = new Set([id]); toast('再点一个与之共边的地块作为合并对象'); return; }
  mergeSet.add(id);
  const ids = [...mergeSet];
  if (ids.length < 2) return;
  const date = prompt('合并生效日期 YYYY-MM-DD', new Date().toISOString().slice(0, 10));
  if (!date) { mergeSet.clear(); return; }
  try {
    const r = await api('POST', '/api/plots/merge', { plot_ids: ids, event_date: date, note: '后台选择共边地块合并' });
    toast(`合并完成：${r.new_plot.code} ${r.new_plot.name}`); loadPlots();
  } catch (e) { toast(e.message, true); }
  mergeSet.clear();
}
// 纠偏入口（列表上未做按钮时也支持通过 URL 调试）；用 prompt 收集 GeoJSON 过于繁琐，改为简单外扩演示
window.correctPlot = guard(async (id, expectedVersionId) => {
  const geoText = prompt('粘贴新边界 GeoJSON Polygon coordinates（如 [[[..]]]）');
  if (!geoText) return;
  try {
    const coords = JSON.parse(geoText);
    await api('POST', `/api/plots/${id}/correct`, { expected_version_id: expectedVersionId, geometry: { type: 'Polygon', coordinates: coords }, event_date: new Date().toISOString().slice(0, 10) });
    toast('纠偏版本已提交'); loadPlots();
  } catch (e) { toast(e.message + (e.data.current_version_id ? `（当前版本 ${e.data.current_version_id}）` : ''), true); }
});

// ---------------- 认养 ----------------
async function loadAdopt() {
  const [rows, plots] = await Promise.all([api('GET', '/api/adoptions'), api('GET', '/api/plots')]);
  fillSelect('aPlot', plots.filter(p => p.current), p => [p.id, `${p.code} ${p.name}`]);
  document.querySelector('#adoptTable tbody').innerHTML = rows.map(a => `<tr>
    <td>${a.plot_code} ${a.plot_name}</td>
    <td>${a.adopter_name}<br><small class="muted">${a.contact || ''}</small></td>
    <td>${a.period_start}<br>${a.period_end}</td>
    <td>${a.area_m2} ㎡</td>
    <td><span class="badge ${a.share_policy}">${a.share_policy === 'fixed' ? '固定份额' : '随边界重分配'}</span></td>
    <td>${fmt.yuan(a.price_amount)}</td>
    <td><small class="code">v${a.anchor_version_no}<br>${a.anchor_valid_from} 起</small></td>
    <td><span class="badge ${a.status === 'active' ? 'resolved' : 'pending'}">${a.status === 'active' ? '生效中' : '已迁移归档'}</span></td></tr>`).join('')
    || '<tr><td colspan="8" class="muted">暂无认养</td></tr>';
  document.getElementById('aStart').value = '2026-10-02';
  document.getElementById('aEnd').value = '2027-10-01';
  const sel = document.getElementById('aPlot');
  const refreshAvail = async () => {
    try {
      const av = await api('GET', `/api/plots/${sel.value}/availability?date=${document.getElementById('aStart').value}`);
      document.getElementById('avail').innerHTML = `该日边界 v${av.version_no}：总面积 ${av.area_m2}㎡，已占用 ${av.used_m2}㎡，<b>可用 ${av.available_m2}㎡</b>`;
    } catch {}
  };
  sel.onchange = refreshAvail; document.getElementById('aStart').onchange = refreshAvail;
  refreshAvail();
}
document.getElementById('aSubmit').onclick = guard(async () => {
  const body = {
    plot_id: Number(document.getElementById('aPlot').value),
    adopter_name: document.getElementById('aName').value,
    contact: document.getElementById('aContact').value,
    period_start: document.getElementById('aStart').value,
    period_end: document.getElementById('aEnd').value,
    area_m2: Number(document.getElementById('aArea').value),
    share_policy: document.getElementById('aPolicy').value,
    price_amount: document.getElementById('aPrice').value ? Number(document.getElementById('aPrice').value) : null
  };
  try {
    await api('POST', '/api/adoptions', body);
    toast('认养已创建（已做同期重叠/超卖校验）'); loadAdopt();
  } catch (e) {
    let msg = e.message;
    if (e.status === 409 && e.data) msg += `（冲突日 ${e.data.date}，可用 ${e.data.available_m2}㎡）`;
    toast(msg, true);
  }
});

// ---------------- 未决差异 ----------------
async function loadCorr() {
  const rows = await api('GET', '/api/correspondences');
  document.querySelector('#corrTable tbody').innerHTML = rows.map(c => `<tr>
    <td>${c.id}</td><td>${c.event_date}</td>
    <td>${c.adopter_name}<br><small class="muted">${c.period_start} ~ ${c.period_end}</small></td>
    <td>${c.old_plot_code} → ${c.new_plot_code}</td>
    <td><span class="badge ${c.policy}">${c.policy === 'fixed' ? '固定' : '重分配'}</span></td>
    <td>${c.old_area_m2}</td><td>${c.mapped_area_m2}</td>
    <td><b style="color:${c.pending_area_m2 > 0 ? 'var(--red)' : 'inherit'}">${c.pending_area_m2} ㎡</b></td>
    <td><span class="badge ${c.status}">${c.status === 'pending' ? '待裁决' : '已解决'}</span></td>
    <td>${c.status === 'pending' ? `<button onclick="window._resolve(${c.id})" ${!isAdmin ? 'disabled' : ''}>标记已裁决</button>` : ''}</td></tr>`).join('')
    || '<tr><td colspan="10" class="muted">拆分/合并/纠偏后这里会出现面积对应</td></tr>';
  window._resolve = guard(async (id) => {
    const note = prompt('裁决备注（如：协商补偿新茶 / 终止认养退款）') || '';
    await api('POST', `/api/correspondences/${id}/resolve`, { status: 'resolved', resolution_note: note });
    toast('未决差异已标记解决'); loadCorr();
  });
}

// ---------------- 采摘 / 采样 / 附件 ----------------
async function loadFarm() {
  const plots = plotsCache.length ? plotsCache : await api('GET', '/api/plots');
  fillSelect('pkPlot', plots.filter(p => p.current), p => [p.id, p.code]);
  const pks = await api('GET', '/api/pickings');
  fillSelect('spPk', pks, p => [p.id, `${p.code}（${p.picked_on}）`]);
  document.getElementById('pkList').innerHTML = pks.map(p => `<div class="muted">${p.code} · ${p.picked_on} · ${p.grade || '未定级'} · ${p.leaf_qty_kg || '?'}kg</div>`).join('');
  const sps = await api('GET', '/api/samplings');
  document.getElementById('spList').innerHTML = sps.map(s => `
    <div style="border-bottom:1px solid var(--line);padding:6px 0">
      <b>${s.code}</b> <span class="muted">${s.plot_code} · ${s.sampled_on}</span>
      <div class="scope-box" style="margin:4px 0">声明范围：${s.scope_claim}<br><span class="muted">${s.applicability}</span></div>
      <div class="muted">${s.lab || ''} ${s.result_summary || '结果待出'}</div></div>`).join('');
  // 附件（从采样详情聚合）
  let atts = [];
  for (const s of sps) {
    const detail = await api('GET', `/api/samplings/${s.id}`);
    (detail.attachments || []).forEach(a => atts.push({ ...a, scope: s.scope_claim, spCode: s.code }));
  }
  document.getElementById('attList').innerHTML = atts.length ? atts.map(a => `<div class="row" style="justify-content:space-between;border-bottom:1px solid var(--line);padding:6px 0">
    <div>📎 <a href="/api/attachments/${a.id}/download" target="_blank">${a.filename}</a>
      <div class="muted">${a.spCode} · ${a.bytes} 字节</div></div>
    <button class="danger" onclick="window._withdraw(${a.id})" ${!isAdmin ? 'disabled' : ''}>撤回附件</button></div>`).join('')
    : '<div class="muted">暂无附件。采样批详情里可查看报告。</div>';
  window._withdraw = guard(async (id) => {
    const reason = prompt('撤回原因（会记录，文件将被物理删除）');
    if (reason === null) return;
    await api('POST', `/api/attachments/${id}/withdraw`, { reason });
    toast('附件已撤回，下载将返回 410'); loadFarm();
  });
}
document.getElementById('pkAdd').onclick = guard(async () => {
  await api('POST', '/api/pickings', { plot_id: Number(document.getElementById('pkPlot').value),
    picked_on: document.getElementById('pkDate').value, grade: document.getElementById('pkGrade').value });
  toast('采摘批已建'); loadFarm();
});
document.getElementById('spAdd').onclick = guard(async () => {
  const scope = document.getElementById('spScope').value.trim();
  if (!scope) return toast('采样批必须填写“声明范围”，检测不得泛化整园', true);
  try {
    await api('POST', '/api/samplings', {
      picking_batch_id: Number(document.getElementById('spPk').value),
      sampled_on: document.getElementById('spDate').value,
      scope_claim: scope, lab: document.getElementById('spLab').value, result_summary: document.getElementById('spResult').value });
    toast('采样批已建，范围已显式声明'); loadFarm();
  } catch (e) { toast(e.message, true); }
});

// ---------------- 送礼 ----------------
async function loadGift() {
  const plots = plotsCache.length ? plotsCache : await api('GET', '/api/plots');
  fillSelect('gPlot', plots.filter(p => p.current), p => [p.id, `${p.code} ${p.name}`]);
  const rows = await api('GET', '/api/share-links');
  document.querySelector('#gTable tbody').innerHTML = rows.map(l => {
    const url = `${location.origin}/gift.html?gift=${l.token}`;
    const state = l.revoked ? '<span class="badge danger">已吊销</span>'
      : l.expired ? '<span class="badge danger">已过期</span>' : '<span class="badge resolved">有效</span>';
    return `<tr>
      <td>${l.plot_code}</td><td>${l.gift_message || ''}</td>
      <td>${new Date(l.expires_at).toLocaleString()}</td>
      <td>${l.view_count}${l.max_views != null ? '/' + l.max_views : ''}</td>
      <td>${state}</td>
      <td><button class="ghost" onclick="navigator.clipboard.writeText('${url}');toast('送礼链接已复制（独立权限）')">复制链接</button>
          ${!l.revoked && !l.expired ? `<button class="danger" onclick="window._revoke(${l.id})">吊销</button>` : ''}</td></tr>`;
  }).join('') || '<tr><td colspan="6" class="muted">暂无链接</td></tr>';
  window._revoke = guard(async (id) => { await api('POST', `/api/share-links/${id}/revoke`, {}); toast('链接已吊销'); loadGift(); });
}
document.getElementById('gAdd').onclick = guard(async () => {
  await api('POST', '/api/share-links', {
    plot_id: Number(document.getElementById('gPlot').value),
    gift_message: document.getElementById('gMsg').value,
    expires_in_hours: Number(document.getElementById('gHours').value),
    max_views: document.getElementById('gMax').value ? Number(document.getElementById('gMax').value) : null });
  toast('送礼链接已生成'); loadGift();
});

loadPlots();
