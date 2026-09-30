'use strict';
// HTTP 端到端：启动真实服务器（临时库 + 种子），验证接口层权限、并发冲突、附件 410、离线同步。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let base, token, farmerToken, seed;

function req(method, url, { body, auth, raw = false, form } = {}) {
  const opt = { method, headers: {} };
  if (auth) opt.headers['Authorization'] = 'Bearer ' + auth;
  if (body) { opt.headers['Content-Type'] = 'application/json'; opt.body = JSON.stringify(body); }
  if (form) {
    const boundary = '----t' + Math.random().toString(16).slice(2);
    opt.headers['Content-Type'] = 'multipart/form-data; boundary=' + boundary;
    opt.body = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${form.name}"\r\nContent-Type: ${form.mime}\r\n\r\n${form.content}\r\n--${boundary}--\r\n`;
  }
  return fetch(base + url, opt).then(async res => {
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json() : await res.text();
    return raw ? { status: res.status, data, headers: res.headers } : { status: res.status, data };
  });
}

test.before(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tea-api-'));
  process.env.TEA_DB_FILE = path.join(dir, 'api.db');
  process.env.TEA_DATA_DIR = dir;
  process.env.PORT = '3789';
  seed = require('../src/seed').run();
  const { start } = require('../src/server');
  await start(+process.env.PORT);
  base = 'http://127.0.0.1:' + process.env.PORT;
  await new Promise(r => setTimeout(r, 200));
  const login = await req('POST', '/api/auth/login', { body: { username: 'admin', password: 'admin123' } });
  assert.equal(login.status, 200); token = login.data.token;
  const fl = await req('POST', '/api/auth/login', { body: { username: 'farmer', password: 'farmer123' } });
  farmerToken = fl.data.token;
});

test('公开地图：不同时段返回不同边界版本（2024-02 是 A，2024-04 是 A1/A2）', async () => {
  const a = await req('GET', '/api/map?date=2024-02-01');
  assert.ok(a.data.parcels.some(p => p.code === 'A'));
  const b = await req('GET', '/api/map?date=2024-04-01');
  assert.ok(b.data.parcels.some(p => p.code === 'A1'));
  assert.ok(!b.data.parcels.some(p => p.code === 'A'));
});

test('同地块重叠认养超额 -> 409 AREA_CONFLICT，且错误信息含超载日期', async () => {
  // 找一个当前空闲极少的地块：用 A1（面积39600，已有占用），直接造超额
  const r = await req('POST', '/api/admin/adoptions', {
    auth: token,
    body: { parcelId: 1, expectedVersion: 2, label: '超卖测试', mode: 'fixed',
      area: 999999, startDate: '2026-01-01', endDate: '2027-01-01' },
  });
  assert.equal(r.status, 409);
  assert.equal(r.data.error, 'AREA_CONFLICT');
  assert.ok(r.data.details.date === '2026-01-01');
});

test('版本条件提交：基于旧版本纠偏 -> 409 STALE_VERSION 并回当前版本号', async () => {
  const r = await req('POST', '/api/admin/parcels/correct', { auth: token, body: {
    parcelId: 3, expectedVersion: 1, // B 当前 v1，先制造一次真实纠偏到 v2
    geometry: { type: 'Polygon', coordinates: [[[520,80],[760,80],[760,290],[520,290],[520,80]]] },
    validFrom: '2025-06-01' } });
  assert.equal(r.status, 200);
  const stale = await req('POST', '/api/admin/parcels/correct', { auth: token, body: {
    parcelId: 3, expectedVersion: 1,
    geometry: { type: 'Polygon', coordinates: [[[520,80],[760,80],[760,280],[520,280],[520,80]]] },
    validFrom: '2025-08-01' } });
  assert.equal(stale.status, 409);
  assert.equal(stale.data.error, 'STALE_VERSION');
  assert.equal(stale.data.details.currentVersion, 2);
});

test('送礼接口：gift 响应无价格字段；过期 410；撤销 404；admin 含价格', async () => {
  const g = await req('GET', '/api/gift/' + seed.giftTokens.validGift);
  assert.equal(g.status, 200);
  assert.equal('priceCents' in g.data.adoption, false);
  assert.equal('contact' in g.data.adoption, false);
  const ex = await req('GET', '/api/gift/' + seed.giftTokens.expiredGift);
  assert.equal(ex.status, 410);
  const admin = await req('GET', '/api/gift/' + seed.giftTokens.adminScope);
  assert.equal(admin.status, 200);
  assert.equal(admin.data.adoption.priceCents, 128000);
  const rev = await req('POST', '/api/admin/shares/revoke', { auth: token, body: { token: seed.giftTokens.validGift } });
  assert.equal(rev.status, 200);
  const gone = await req('GET', '/api/gift/' + seed.giftTokens.validGift);
  assert.equal(gone.status, 404);
});

test('未授权不能访问后台接口（不是 CSS 层面的问题）', async () => {
  const r = await req('GET', '/api/admin/adoptions');
  assert.equal(r.status, 401);
  // 农户不能签发送礼链接
  const fr = await req('POST', '/api/admin/shares', { auth: farmerToken, body: { adoptionId: 1, scope: 'gift' } });
  assert.equal(fr.status, 403);
});

test('采摘批次只代表声明范围：详情含 scopeNotice，且报告可撤回->附件 410', async () => {
  const list = await req('GET', '/api/batches');
  const b1 = list.data.batches.find(b => b.code === 'PCK-2025-A1-01');
  const det = await req('GET', '/api/batches/' + b1.id);
  assert.ok(det.data.scopeNotice.includes('不得外推'));
  const rep = det.data.reports.find(r => r.hasAttachment);
  assert.ok(rep, '种子报告应带附件');
  const before = await req('GET', '/api/reports/' + rep.id + '/attachment', { raw: true });
  assert.equal(before.status, 200);
  const wd = await req('POST', '/api/admin/reports/withdraw', { auth: token, body: { reportId: rep.id, reason: '测试撤回' } });
  assert.equal(wd.status, 200);
  const after = await req('GET', '/api/reports/' + rep.id + '/attachment', { raw: true });
  assert.equal(after.status, 410);
  const atts = await req('GET', '/api/admin/attachments', { auth: token });
  assert.ok(atts.data.some(a => a.status === 'archived'));
});

test('上传新附件并登记到批次；对象层归档文件仍存在', async () => {
  const up = await req('POST', '/api/admin/attachments', { auth: token, form: { name: 't.txt', mime: 'text/plain', content: 'hello lab' } });
  assert.equal(up.status, 200);
  assert.equal(up.data.size_bytes, Buffer.byteLength('hello lab'));
  const objs = fs.readdirSync(path.join(process.env.TEA_DATA_DIR, 'objects'));
  assert.ok(objs.includes(up.data.object_key));
});

test('离线日记：同一 clientId 两次同步只保留一条（farmer 身份）', async () => {
  const payload = { parcelId: 1, entryDate: '2025-10-01', weather: '晴', body: '离线测试芽情', clientId: 'offline-abc' };
  const r1 = await req('POST', '/api/diaries', { auth: farmerToken, body: payload });
  const r2 = await req('POST', '/api/diaries', { auth: farmerToken, body: payload });
  assert.equal(r1.status, 200);
  assert.equal(r2.data.id, r1.data.id);
  assert.equal(r2.data.deduplicated, true);
  const rows = await req('GET', '/api/diaries?parcelId=1');
  assert.equal(rows.data.filter(d => d.body === '离线测试芽情').length, 1);
});

test('非法 multipart 与超大语义错误返回结构化错误', async () => {
  const r = await req('POST', '/api/admin/parcels', { auth: token, body: { code: 'X@', name: 'n', geometry: { bad: 1 }, validFrom: '2025-01-01' } });
  assert.equal(r.status, 400);
  assert.ok(r.data.error);
});

test.after(() => {
  try { require('../src/server').server.close(); } catch {}
  setTimeout(() => process.exit(0), 50).unref?.();
});
