'use strict';
const S = { parcels: [], selected: null, currentDate: new Date().toISOString().slice(0, 10) };

async function boot() {
  if (!Api.getToken()) return showLogin();
  try {
    const res = await fetch('/api/admin/adoptions', { headers: { Authorization: 'Bearer ' + Api.getToken() } });
    if (res.status === 401) return showLogin();
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = '';
    const me = JSON.parse(atob(Api.getToken().split('.')[0] || 'e30=')); // token 非 JWT，忽略
    document.getElementById('who').textContent = '已登录（管理员会话）';
    await refresh();
  } catch (e) { showLogin(); }
}
function showLogin() {
  document.getElementById('login').style.display = '';
  document.getElementById('app').style.display = 'none';
}
document.getElementById('lBtn').onclick = async () => {
  try {
    const r = await Api.post('/api/auth/login', { username: lu.value, password: lp.value });
    Api.setToken(r.token); location.reload();
  } catch (e) { toast(e.message, true); }
};
document.getElementById('logoutBtn').onclick = async () => {
  try { await Api.post('/api/auth/logout', {}); } catch {}
  Api.setToken(null); location.reload();
};

async function refresh() {
  const data = await Api.get('/api/map?date=' + S.currentDate);
  S.parcels = data.parcels;
  TeaMap.render(document.getElementById('map'), { date: S.currentDate, parcels: S.parcels,
    selectedId: S.selected, onSelect: id => { S.selected = id; refreshSelection(); renderMap(); } });
  refreshSelection();
  loadAdoptions(); loadPending(); loadBatchesAdmin(); loadAttachments(); loadShares(); loadAudit();
}
function renderMap() {
  TeaMap.render(document.getElementById('map'), { date: S.currentDate, parcels: S.parcels,
    selectedId: S.selected, onSelect: id => { S.selected = id; refreshSelection(); renderMap(); } });
}
function sel() { return S.parcels.find(p => p.parcelId === S.selected); }
function refreshSelection() {
  const p = sel();
  const el = document.getElementById('selInfo');
  if (!p) { el.className = 'muted'; el.textContent = '请在地图中选择一个地块。'; return; }
  el.className = '';
  el.innerHTML = `<dl class="kv">
    <dt>地块</dt><dd><strong>${esc(p.code)}</strong> ${esc(p.name)}（id ${p.parcelId}）</dd>
    <dt>当前版本</dt><dd><span class="pill">v${p.version}</span> 版本id ${p.versionId}，${p.validFrom} ~ 至今，面积 ${p.area.toLocaleString()}㎡</dd>
    <dt>占用</dt><dd>${p.used.toLocaleString()}/${p.area.toLocaleString()}㎡，余 ${p.free.toLocaleString()}㎡</dd>
  </dl>`;
  document.getElementById('cVer').textContent = 'v' + p.version;
  document.getElementById('aPid').value = p.parcelId; document.getElementById('aVer').value = p.version;
  document.getElementById('mId1').value = p.parcelId; document.getElementById('mV1').value = p.version;
  document.getElementById('bPid').value = p.parcelId;
  document.getElementById('cDate').value = S.currentDate;
  document.getElementById('sDate').value = S.currentDate;
  document.getElementById('mDate').value = S.currentDate;
  document.getElementById('cGeom').value = JSON.stringify(p.geometry, null, 0);
  const ring = p.geometry.coordinates[0];
  const xs = ring.map(q => q[0]), ys = ring.map(q => q[1]);
  document.getElementById('sX1').value = (Math.min(...xs) + Math.max(...xs)) / 2;
  document.getElementById('sY1').value = Math.min(...ys);
  document.getElementById('sX2').value = (Math.min(...xs) + Math.max(...xs)) / 2;
  document.getElementById('sY2').value = Math.max(...ys);
  document.getElementById('sC0').value = p.code + '-西';
  document.getElementById('sC1').value = p.code + '-东';
}

// tabs
document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => {
  document.querySelectorAll('#tabs button').forEach(x => x.classList.remove('active'));
  b.classList.add('active');
  document.querySelectorAll('.tabpane').forEach(p => p.style.display = 'none');
  document.querySelector(`[data-pane="${b.dataset.tab}"]`).style.display = '';
});

// 纠偏
cBtn.onclick = async () => {
  const p = sel(); if (!p) return toast('请先选中地块', true);
  try {
    await Api.post('/api/admin/parcels/correct', {
      parcelId: p.parcelId, expectedVersion: p.version,
      geometry: JSON.parse(cGeom.value), validFrom: cDate.value, note: cNote.value,
    });
    toast('纠偏已提交：新版本生效，旧认养已重映射'); await refresh();
  } catch (e) { toast(formatErr(e), true, 6000); }
};
// 拆分
sBtn.onclick = async () => {
  const p = sel(); if (!p) return toast('请先选中地块', true);
  const [c0, n0] = sC0.value.split('/').map(s => s.trim());
  const [c1, n1] = sC1.value.split('/').map(s => s.trim());
  try {
    await Api.post('/api/admin/parcels/split', {
      parcelId: p.parcelId, expectedVersion: p.version,
      cut: { p1: { x: +sX1.value, y: +sY1.value }, p2: { x: +sX2.value, y: +sY2.value } },
      children: [{ code: c0, name: n0 || c0 }, { code: c1, name: n1 || c1 }],
      validFrom: sDate.value,
    });
    toast('拆分成功：认养面积已按交集对应，固定差异进入未决'); await refresh();
  } catch (e) { toast(formatErr(e), true, 6000); }
};
// 合并
mBtn.onclick = async () => {
  const [code, name] = mCode.value.split('/').map(s => s.trim());
  try {
    await Api.post('/api/admin/parcels/merge', {
      items: [{ parcelId: +mId1.value, expectedVersion: +mV1.value },
              { parcelId: +mId2.value, expectedVersion: +mV2.value }],
      code, name: name || code, validFrom: mDate.value,
    });
    toast('合并成功'); await refresh();
  } catch (e) { toast(formatErr(e), true, 6000); }
};
// 新建
nBtn.onclick = async () => {
  try {
    await Api.post('/api/admin/parcels', { code: nCode.value, name: nName.value,
      geometry: JSON.parse(nGeom.value), validFrom: nDate.value });
    toast('地块已创建'); await refresh();
  } catch (e) { toast(formatErr(e), true, 6000); }
};
// 认养
async function loadAdoptions() {
  const rows = await Api.get('/api/admin/adoptions');
  adTable.innerHTML = `<thead><tr><th>id</th><th>署名</th><th>创建时地块</th><th>模式</th><th>面积</th><th>区间</th><th>送礼</th><th>私有价格/联系</th><th>待决</th><th>状态</th><th></th></tr></thead><tbody>
  ${rows.map(a => `<tr><td>${a.id}</td><td>${esc(a.label)}</td><td>${esc(a.parcelCode)}</td>
    <td><span class="badge ${a.mode}">${a.mode}</span></td><td>${a.area.toLocaleString()}㎡</td>
    <td>${a.period}</td><td>${a.gift ? '🎁' : ''}</td>
    <td>${fmtYuan(a.priceCents)}<br><span class="muted">${esc(a.contact||'')}</span></td>
    <td>${a.pendingCount ? `<span class="badge pending">${a.pendingArea}㎡</span>` : ''}</td>
    <td>${a.status}</td>
    <td>${a.status === 'active' ? `<button class="small ghost" data-end="${a.id}">终止</button>` : ''}</td></tr>`).join('')}
  </tbody>`;
  adTable.querySelectorAll('[data-end]').forEach(b => b.onclick = async () => {
    const d = prompt('终止日期 YYYY-MM-DD', S.currentDate);
    if (!d) return;
    try { await Api.post('/api/admin/adoptions/terminate', { adoptionId: +b.dataset.end, endDate: d });
      toast('已终止'); loadAdoptions(); refresh();
    } catch (e) { toast(formatErr(e), true); }
  });
}
aBtn.onclick = async () => {
  try {
    const r = await Api.post('/api/admin/adoptions', {
      parcelId: +aPid.value, expectedVersion: +aVer.value, label: aLabel.value, mode: aMode.value,
      area: +aArea.value, startDate: aStart.value, endDate: aEnd.value || null,
      gift: +aGift.value, priceCents: aPrice.value ? +aPrice.value : null, contact: aContact.value || null,
    });
    toast('认养已创建；提交后占用 ' + r.capacity.used + '/' + r.capacity.area + '㎡'); await Promise.all([loadAdoptions(), refresh()]);
  } catch (e) { toast(formatErr(e), true, 7000); }
};

// 未决差异
async function loadPending() {
  const rows = await Api.get('/api/admin/pending-allocations');
  pendingBadge.textContent = rows.length;
  pendingList.innerHTML = rows.length ? rows.map(r => `
    <div class="card" style="box-shadow:none;background:#fbfaf2;margin-bottom:8px">
      <div><strong>#${r.id} ${esc(r.label)}</strong>（${r.mode}）在 <strong>${esc(r.code_snapshot)} v${r.version}</strong> 上的差异
      <span class="badge pending">${r.area.toLocaleString()}㎡</span></div>
      <div class="muted">${esc(r.note)}</div>
      <div style="margin-top:6px">
        <button class="small" data-confirm="${r.id}" data-ver="${r.parcel_version_id}">确认落实（校验占用）</button>
        <button class="small danger" data-dismiss="${r.id}">核销放弃</button>
      </div></div>`).join('') : '<p class="muted">没有未决差异。</p>';
  pendingList.querySelectorAll('[data-confirm]').forEach(b => b.onclick = async () => {
    const note = prompt('确认落实备注', '管理员核对面积后落实');
    try { await Api.post('/api/admin/allocations/resolve', { allocationId: +b.dataset.confirm, action: 'confirm', note });
      toast('已落实'); loadPending(); loadAdoptions(); refresh();
    } catch (e) { toast(formatErr(e), true, 6000); loadPending(); }
  });
  pendingList.querySelectorAll('[data-dismiss]').forEach(b => b.onclick = async () => {
    const note = prompt('核销备注', '固定份额差异不再追溯');
    try { await Api.post('/api/admin/allocations/resolve', { allocationId: +b.dataset.dismiss, action: 'dismiss', note });
      toast('差异已核销'); loadPending(); loadAdoptions();
    } catch (e) { toast(formatErr(e), true); }
  });
}

// 批次
async function loadBatchesAdmin() {
  const { batches } = await Api.get('/api/batches');
  batchTable.innerHTML = `<thead><tr><th>批次</th><th>地块版本</th><th>日</th><th>声明范围</th><th>报告</th></tr></thead><tbody>
  ${batches.map(b => `<tr><td><code>${esc(b.code)}</code></td><td>${esc(b.parcel_code)}</td><td>${b.picked_on}</td>
    <td class="muted">${esc(b.scope_note)}</td><td><a href="/api/batches/${b.id}" target="_blank">${b.total_reports} 份（有效 ${b.active_reports}）</a></td></tr>`).join('')}</tbody>`;
}
bBtn.onclick = async () => {
  try { await Api.post('/api/admin/batches', { code: bCode.value, parcelId: +bPid.value, pickedOn: bDate.value,
    scopeNote: bScope.value, leafKind: bKind.value, yieldKg: bYield.value ? +bYield.value : null });
    toast('批次已创建（绑定当日边界版本与声明范围）'); loadBatchesAdmin();
  } catch (e) { toast(formatErr(e), true); }
};
rBtn.onclick = async () => {
  try { await Api.post('/api/admin/reports', { batchId: +rBatch.value, title: rTitle.value, labName: rLab.value,
    issuedOn: rDate.value, summary: rSummary.value, attachmentId: rAtt.value ? +rAtt.value : null });
    toast('检测报告已登记'); loadBatchesAdmin();
  } catch (e) { toast(formatErr(e), true); }
};
wBtn.onclick = async () => {
  try { await Api.post('/api/admin/reports/withdraw', { reportId: +wId.value, reason: wReason.value });
    toast('报告已撤回，附件在对象层归档'); loadBatchesAdmin(); loadAttachments();
  } catch (e) { toast(formatErr(e), true); }
};

// 附件
async function loadAttachments() {
  const rows = await Api.get('/api/admin/attachments');
  attTable.innerHTML = `<thead><tr><th>id</th><th>文件</th><th>类型</th><th>大小</th><th>状态</th><th>归档原因</th></tr></thead><tbody>
  ${rows.map(a => `<tr><td>${a.id}</td><td>${esc(a.original_name)}<br><code class="mini">${esc(a.object_key.slice(0,24))}…</code></td>
    <td>${esc(a.mime_type)}</td><td>${a.size_bytes}B</td>
    <td>${a.status === 'archived' ? '<span class="badge locked">archived</span>' : '<span class="badge boundary">active</span>'}</td>
    <td class="muted">${esc(a.archived_reason||'')}</td></tr>`).join('')}</tbody>`;
}
upBtn.onclick = async () => {
  const f = upFile.files[0]; if (!f) return toast('请选择文件', true);
  const fd = new FormData(); fd.append('file', f);
  try { const a = await Api.upload('/api/admin/attachments', fd);
    toast('已入对象层，附件 id=' + a.id); rAtt.value = a.id; loadAttachments();
  } catch (e) { toast(formatErr(e), true); }
};

// 送礼链接
async function loadShares() {
  const rows = await Api.get('/api/admin/shares');
  shTable.innerHTML = `<thead><tr><th>令牌</th><th>认养</th><th>范围</th><th>过期</th><th>状态</th><th></th></tr></thead><tbody>
  ${rows.map(s => `<tr><td><code>${s.token.slice(0,10)}…</code></td><td>#${s.adoption_id}</td>
    <td>${s.scope === 'admin' ? '<span class="badge fixed">admin（含价格）</span>' : '<span class="badge gift">gift（无私有字段）</span>'}</td>
    <td>${esc(s.expires_at || '长期')}</td><td>${s.revoked ? '已撤销' : '有效'}</td>
    <td>${s.revoked ? '' : `<button class="small danger" data-rev="${s.token}">撤销</button>`}</td></tr>`).join('')}</tbody>`;
  shTable.querySelectorAll('[data-rev]').forEach(b => b.onclick = async () => {
    await Api.post('/api/admin/shares/revoke', { token: b.dataset.rev }); toast('链接已撤销'); loadShares();
  });
}
shBtn.onclick = async () => {
  try { const r = await Api.post('/api/admin/shares', { adoptionId: +shAd.value, scope: shScope.value, expiresAt: shExp.value || null });
    const url = `${location.origin}/gift?token=${r.token}`;
    shOut.innerHTML = `<div class="notice info">已签发（${r.scope}，${r.expiresAt || '长期'}）：<br>
      <a href="${url}" target="_blank">${url}</a> <button class="small ghost" onclick="navigator.clipboard.writeText('${url}');toast('已复制')">复制</button></div>`;
    loadShares();
  } catch (e) { toast(formatErr(e), true); }
};

// 审计
async function loadAudit() {
  const rows = await Api.get('/api/admin/audit');
  auditTable.innerHTML = `<thead><tr><th>时间</th><th>操作者</th><th>动作</th><th>详情</th><th>状态</th></tr></thead><tbody>
  ${rows.map(r => `<tr><td class="muted">${r.created_at}</td><td>${esc(r.actor||'')}</td><td>${esc(r.action)}</td>
    <td class="muted" style="max-width:420px;word-break:break-all">${esc(r.detail)}</td><td>${r.http_status||''}</td></tr>`).join('')}</tbody>`;
}

function formatErr(e) {
  if (e.code === 'STALE_VERSION') return `版本冲突 409：${e.message}（请刷新后重试）`;
  if (e.code === 'AREA_CONFLICT') return `占用冲突 409：${e.message}`;
  return e.message;
}
boot();
