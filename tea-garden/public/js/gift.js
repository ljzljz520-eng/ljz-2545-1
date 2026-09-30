'use strict';
(async () => {
  const token = Api.giftToken;
  const title = document.getElementById('title');
  const body = document.getElementById('body');
  if (!token) {
    title.textContent = '缺少分享令牌';
    body.innerHTML = '<div class="notice warn">请使用收到的完整送礼链接（需带 <code>?token=…</code>）。</div>';
    return;
  }
  try {
    const v = await Api.get('/api/gift/' + encodeURIComponent(token));
    const a = v.adoption;
    title.textContent = `${a.parcelCode} ${a.parcelName} · ${a.mode === 'fixed' ? '固定份额' : '随边界份额'}认养`;
    body.innerHTML = `
      <div class="notice info">链接范围：<strong>${v.scope}</strong>；有效期至 ${esc(v.expiresAt || '长期')}。
        本视图只展示该令牌被授权的字段。</div>
      <dl class="kv">
        <dt>认养署名</dt><dd>${esc(a.label)}${a.gift ? ' <span class="badge gift">🎁 送礼认养</span>' : ''}</dd>
        <dt>地块</dt><dd>${esc(a.parcelCode)} ${esc(a.parcelName)}</dd>
        <dt>认养面积</dt><dd>${a.area.toLocaleString()} ㎡（${a.mode === 'fixed' ? '固定份额：边界变化时面积不自动变，差异由园方处理' : '随边界：面积随地块边界按几何交集重映射'}）</dd>
        <dt>所属时段</dt><dd><span class="period-chip">${esc(a.period)}</span></dd>
      </dl>
      <p class="muted">认养记录与地图位置都标注所属时段，避免把历史边界或他人的认养区间误认为当前状态。</p>
      ${v.scope === 'admin' ? `
        <h3>管理员可见（admin 令牌才下发）</h3>
        <dl class="kv">
          <dt>认养编号</dt><dd>#${a.adoptionId}</dd>
          <dt>价格</dt><dd>${fmtYuan(a.priceCents)}<span class="private-tag">私有字段·服务端按范围下发</span></dd>
          <dt>联系方式</dt><dd>${esc(a.contact)}<span class="private-tag">私有字段</span></dd>
        </dl>` : `
        <div class="notice"><strong>gift 视图：</strong>价格与联系方式属于私有信息，接口在服务端就已剔除；你在前端任何地方（含查看源码/接口 JSON）都看不到它们。</div>`}
    `;
  } catch (e) {
    if (e.status === 410) {
      title.textContent = '链接已过期';
      body.innerHTML = `<div class="notice warn">${esc(e.data && e.data.reason || e.message)}（${esc(e.data && e.data.expiredAt || '')}）。<br>请联系园方重新签发。</div>`;
    } else if (e.status === 404) {
      title.textContent = '链接不可用';
      body.innerHTML = `<div class="notice warn">${esc(e.data && e.data.reason || '链接不存在或已被撤销')}。</div>`;
    } else {
      title.textContent = '无法打开';
      body.innerHTML = `<div class="notice warn">${esc(e.message)}</div>`;
    }
  }
})();
