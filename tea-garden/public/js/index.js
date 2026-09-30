'use strict';
const state = { date: '2025-09-30', parcels: [], selected: null };

async function loadMap(date) {
  state.date = date;
  const data = await Api.get('/api/map?date=' + date);
  state.parcels = data.parcels;
  document.getElementById('periodChip').textContent = '查看时段：' + date;
  document.getElementById('mapHint').innerHTML = esc(data.periodNote) + '。拖动滑块切换时段。';
  TeaMap.render(document.getElementById('map'), { date, parcels: data.parcels,
    selectedId: state.selected, onSelect: selectParcel });
  if (state.selected) renderDetail(state.parcels.find(p => p.parcelId === state.selected));
  // 填地块下拉
  const sel = document.getElementById('dParcel');
  if (!sel.options.length) data.parcels.forEach(p => sel.add(new Option(`${p.code} ${p.name}`, p.parcelId)));
}

function adoptionRows(p) {
  if (!p.adoptions.length) return '<p class="muted">该时段此地无认养。</p>';
  return p.adoptions.map(a => `
    <div class="adopt-line">
      <span>
        <strong>${esc(a.label)}</strong>
        <span class="badge ${a.mode}">${a.mode === 'fixed' ? '固定份额' : '随边界'}</span>
        ${a.state === 'pending' ? '<span class="badge pending">待决差异</span>' : ''}
      </span>
      <span class="muted">${a.area.toLocaleString()}㎡<br>${a.startDate} ~ ${esc(a.endDate || '长期')}</span>
    </div>`).join('');
}

function renderDetail(p) {
  if (!p) return;
  const over = p.used > p.area + 1e-6;
  document.getElementById('detail').innerHTML = `
    <dl class="kv">
      <dt>地块</dt><dd><strong>${esc(p.code)}</strong> ${esc(p.name)}（坡度 ${p.slopeAngle ?? '—'}°）</dd>
      <dt>边界版本</dt><dd>v${p.version}（编号 #${p.versionId}）<br>
        <span class="muted">生效 ${p.validFrom} ~ ${esc(p.validTo || '至今')}，面积 ${p.area.toLocaleString()}㎡</span></dd>
      <dt>当日认养</dt><dd><span class="pill ${over ? 'over' : ''}">${p.used.toLocaleString()} / ${p.area.toLocaleString()}㎡</span>
        <span class="pill free">余 ${p.free.toLocaleString()}㎡</span></dd>
    </dl>
    <h3>该时段认养区间</h3>
    ${adoptionRows(p)}
    <p class="muted" style="margin-top:8px">仅显示与所选时段 <strong>${esc(state.date)}</strong> 重叠的认养；历史认养保留在其创建时的边界版本上。</p>
    <button class="small ghost" id="timelineBtn">查看该地块版本谱系</button>`;
  document.getElementById('timelineBtn').onclick = () => openTimeline(p);
}

async function openTimeline(p) {
  const t = await Api.get('/api/parcels/' + p.parcelId + '/timeline');
  const rows = t.versions.map(v => `
    <tr><td>v${v.version}</td><td>${v.valid_from} ~ ${esc(v.valid_to || '至今')}</td>
    <td>${v.area.toLocaleString()}㎡</td><td>${esc(v.change_note)}</td></tr>`).join('');
  const lin = t.lineage.map(l => `<span class="badge">${({create:'创建',split:'拆分',merge:'合并',correct:'纠偏'})[l.op]}：${esc(l.from_code||'∅')} v${l.from_version||'—'} → ${esc(l.to_code)} v${l.to_version}${l.weight!=null?`（交集 ${(l.weight*100).toFixed(1)}%）`:''}</span>`).join('');
  const dlg = document.getElementById('parcelDlg');
  dlg.innerHTML = `<div class="dlg-head"><b>${esc(p.code)} · 边界版本谱系</b><button class="ghost small" onclick="document.getElementById('parcelDlg').close()">关闭</button></div>
  <div class="dlg-body">
    <p class="muted">同一逻辑地块（id #${p.parcelId}）的边界按版本保存，半开区间 <code>[valid_from, valid_to)</code>。</p>
    <table><thead><tr><th>版本</th><th>有效期</th><th>面积</th><th>变更说明</th></tr></thead><tbody>${rows}</tbody></table>
    <h3>谱系</h3><p>${lin || '—'}</p>
  </div>`;
  dlg.showModal();
}

function selectParcel(id) { state.selected = id; loadMap(state.date); }

async function loadDiaries() {
  const rows = await Api.get('/api/diaries');
  document.getElementById('diaryList').innerHTML = rows.map(d => `
    <div class="card" style="box-shadow:none;margin-bottom:10px;background:#fbfaf2">
      <div><strong>${esc(d.parcel_code_at_entry || '?')}</strong> · ${esc(d.farmer_name)}
        <span class="muted">${d.entry_date} ${esc(d.weather||'')}</span></div>
      <div>${esc(d.body)}</div>
    </div>`).join('') || '<p class="muted">暂无日记。</p>';
}
async function loadFarmers() {
  const rows = await Api.get('/api/farmers');
  document.getElementById('farmerList').innerHTML = rows.map(f =>
    `<div class="card" style="margin:0"><strong>👩‍🌾 ${esc(f.name)}</strong><p class="muted" style="margin:4px 0">${esc(f.bio)}</p></div>`).join('');
}
async function loadBatches() {
  const { batches } = await Api.get('/api/batches');
  document.getElementById('batchList').innerHTML = `<table><thead><tr>
    <th>批次号</th><th>地块（采摘时版本）</th><th>采摘日</th><th>声明范围</th><th>检测</th><th></th></tr></thead><tbody>
    ${batches.map(b => `<tr>
      <td><code>${esc(b.code)}</code></td><td>${esc(b.parcel_code)}</td><td>${b.picked_on}</td>
      <td class="muted">${esc(b.scope_note)}</td>
      <td>${b.active_reports}/${b.total_reports} 份有效</td>
      <td><button class="small" data-batch="${b.id}">查看检测</button></td></tr>`).join('')}
  </tbody></table>`;
  document.querySelectorAll('[data-batch]').forEach(btn => btn.onclick = () => openBatch(+btn.dataset.batch));
}
async function openBatch(id) {
  const data = await Api.get('/api/batches/' + id);
  const b = data.batch;
  const reports = data.reports.map(r => `
    <div class="card" style="box-shadow:none;background:#fbfaf2;margin-bottom:8px">
      <div><strong>${esc(r.title)}</strong> ${r.withdrawn ? '<span class="badge locked">已撤回</span>' : `<span class="badge">${esc(r.labName)}</span>`}
      <span class="muted">${r.issuedOn}</span></div>
      <div>${r.withdrawn ? `<span class="muted">已撤回：${esc(r.withdrawnReason)}；附件已在对象层归档，不再提供下载。</span>` : esc(r.summary)}</div>
      ${r.hasAttachment && !r.withdrawn ? `<p><a class="btn small ghost" href="/api/reports/${r.id}/attachment" target="_blank">查看检测附件</a></p>` : ''}
    </div>`).join('') || '<p class="muted">无检测报告。</p>';
  const dlg = document.getElementById('parcelDlg');
  dlg.innerHTML = `<div class="dlg-head"><b>批次 ${esc(b.code)}</b><button class="ghost small" onclick="document.getElementById('parcelDlg').close()">关闭</button></div>
  <div class="dlg-body">
    <div class="notice warn">${esc(data.scopeNotice)}</div>
    <dl class="kv">
      <dt>地块</dt><dd>${esc(b.parcel_code)}（采摘日生效的边界版本，${b.boundary_from} ~ ${esc(b.boundary_to||'至今')}）</dd>
      <dt>采摘日</dt><dd>${b.picked_on}</dd>
      <dt>声明范围</dt><dd>${esc(b.scope_note)}</dd>
      <dt>茶种/产量</dt><dd>${esc(b.leaf_kind||'—')} / ${b.yield_kg ?? '—'}kg</dd>
    </dl>
    <h3>检测报告（仅对该批次来样负责）</h3>${reports}
  </div>`;
  dlg.showModal();
}

// 日记（离线）
function bindOffline() {
  Offline.onChange(st => {
    document.getElementById('netDot').className = 'offline-dot ' + (st.online ? 'on' : 'off');
    document.getElementById('netText').textContent = st.online ? (st.pending ? `同步中…待发 ${st.pending}` : '在线') : `离线 · 待发 ${st.pending}`;
    document.getElementById('offlineStatus').textContent =
      st.pending ? `有 ${st.pending} 条日记在本机待发，联网后自动同步。` : (st.online ? '可直接发布；断网时自动转本地队列。' : '当前离线，日记将保存到本机待发队列。');
  });
  document.addEventListener('visibilitychange', () => { if (!document.hidden) Offline.sync().catch(()=>{}); });
}
function bindDiaryDialog(parcels) {
  const dlg = document.getElementById('diaryDlg');
  document.getElementById('addDiaryBtn').onclick = () => {
    document.getElementById('dDate').value = state.date;
    dlg.showModal();
  };
  document.getElementById('dSave').onclick = async () => {
    const entry = {
      parcelId: +document.getElementById('dParcel').value,
      entryDate: document.getElementById('dDate').value,
      weather: document.getElementById('dWeather').value,
      body: document.getElementById('dBody').value,
    };
    if (!entry.body.trim()) return toast('请填写日记内容', true);
    if (Api.getToken() && navigator.onLine) {
      try { await Api.post('/api/diaries', entry); toast('日记已发布'); }
      catch (e) { if (e.status === 401) { Offline.enqueue(entry); toast('未登录，已存入离线队列'); } else throw e; }
    } else {
      Offline.enqueue(entry); toast(navigator.onLine ? '未登录，已存入离线队列（登录后同步）' : '已离线保存，联网后自动同步');
    }
    document.getElementById('dBody').value = '';
    dlg.close(); loadDiaries();
    if (Api.getToken()) Offline.sync().catch(()=>{});
  };
  document.addEventListener('diary-synced', loadDiaries);
}

// 时段控件
document.getElementById('dateRange').addEventListener('input', e => {
  document.getElementById('datePick').value = e.target.value; loadMap(e.target.value);
});
document.getElementById('datePick').addEventListener('change', e => {
  document.getElementById('dateRange').value = e.target.value; loadMap(e.target.value);
});
document.getElementById('todayBtn').onclick = () => {
  const t = new Date().toISOString().slice(0, 10);
  document.getElementById('dateRange').value = t; document.getElementById('datePick').value = t; loadMap(t);
};

(async function init() {
  await loadMap(state.date);
  await Promise.all([loadDiaries(), loadFarmers(), loadBatches()]);
  bindOffline(); bindDiaryDialog();
  if (Api.getToken() && navigator.onLine) Offline.sync().catch(()=>{});
})().catch(e => toast(e.message, true, 6000));
