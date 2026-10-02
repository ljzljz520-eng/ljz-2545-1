import { api, store, fmt, toast } from '/js/api.js';
import { HillMap } from '/js/hillmap.js';

const map = new HillMap(document.getElementById('map'), { onPick: showDetail });
const dateInput = document.getElementById('atDate');
dateInput.value = '2026-10-02';
let currentAt = dateInput.value;

async function load() {
  currentAt = dateInput.value || new Date().toISOString().slice(0, 10);
  try {
    const data = await api('GET', `/api/map?date=${currentAt}`);
    map.setFeatures(data.features);
    document.getElementById('detail').style.display = 'none';
  } catch (e) { toast(e.message, true); }
}

async function showDetail(f) {
  const el = document.getElementById('detail');
  el.style.display = '';
  el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  el.innerHTML = '<div class="muted">加载中…</div>';
  try {
    const info = await api('GET', `/api/public/plots/${f.plot_id}`);
    // 认养记录补充其锚定版本号（公开页只映射版本，不涉及认养人）
    const vMap = Object.fromEntries(info.versions.map(v => [v.id, v]));
    let html = `
      <div class="row" style="justify-content:space-between">
        <h2 style="margin:0">${info.name} <span class="muted">${info.code}</span>
          <span class="badge">${info.slope_zone || '未分区'}</span></h2>
        <div class="muted">地图选中日期：${currentAt}</div>
      </div>
      <dl class="kv">
        <dt>当前点选版本</dt><dd>v${f.version_no}（${({ create: '初始', split: '拆分形成', merge: '合并形成', correct: '纠偏' })[f.event]}）</dd>
        <dt>该版本时段</dt><dd><b>${f.valid_from}</b> 起 ${f.valid_to ? `至 <b>${f.valid_to}</b> 被新边界取代` : '，至今有效'}</dd>
        <dt>边界面积</dt><dd>${f.area_m2} ㎡（约 ${(f.area_m2 / 666.67).toFixed(2)} 亩）</dd>
      </dl>
      <h3>边界版本时间线（空间数据不可变）</h3>
      <table><thead><tr><th>版本</th><th>事件</th><th>生效</th><th>失效</th><th>面积</th><th>说明</th></tr></thead><tbody>
      ${info.versions.map(v => `<tr ${v.id === f.version_id ? 'style="background:#eef7e8"' : ''}>
        <td>v${v.version_no}</td><td>${v.event}</td><td>${v.valid_from}</td>
        <td>${v.valid_to || '<span class="badge">当前</span>'}</td><td>${v.area_m2} ㎡</td><td class="muted">${v.note || ''}</td></tr>`).join('')}
      </tbody></table>
      <h3>认养时段（记录锚定的边界版本）</h3>
      ${!info.adopted_periods.length ? '<div class="muted">暂无认养记录</div>' : `
      <table><thead><tr><th>时段</th><th>面积</th><th>份额策略</th><th>锚定边界</th></tr></thead><tbody>
        ${info.adopted_periods.map(a => {
          const av = vMap[a.version_id];
          return `<tr><td>${a.period_start} ~ ${a.period_end}</td><td>${a.area_m2} ㎡</td>
          <td><span class="badge ${a.share_policy}">${a.share_policy === 'fixed' ? '固定地块份额' : '随边界重分配'}</span></td>
          <td><small class="code">v${av ? av.version_no : '?'}（${av ? av.valid_from : ''} 起）</small></td></tr>`;
        }).join('')}
      </tbody></table>`}
      <div class="notice" style="margin-top:10px">认养人身份、联系方式与价格属于后台/送礼权限信息，<b>本公开页的接口响应中即不包含这些字段</b>。</div>`;
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = `<div class="notice">${e.message}</div>`;
  }
}

dateInput.addEventListener('change', load);
document.getElementById('todayBtn').addEventListener('click', () => { dateInput.value = '2026-10-02'; load(); });
if (store.user) document.getElementById('who').textContent = `${store.user.display_name}（${store.user.role}）`;
load();
