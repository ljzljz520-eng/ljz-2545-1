'use strict';
process.env.TEA_DB = ':memory:';
const test = require('node:test');
const assert = require('node:assert/strict');
const { server } = require('../src/server');
const { getDb, resetDb } = require('../src/db');
const auth = require('../src/auth');
const plotSvc = require('../src/plotService');
const adoptSvc = require('../src/adoptionService');
const farmSvc = require('../src/farmService');

const PORT = 4123;
const BASE = `http://127.0.0.1:${PORT}`;
let adminToken, staffToken, goodGiftToken, badGiftToken;

async function call(method, url, { token, gift, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['X-Auth-Token'] = token;
  if (gift) headers['X-Gift-Token'] = gift;
  const res = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let json = null;
  try { json = await res.json(); } catch {}
  return { status: res.status, json };
}

test.before(async () => {
  await new Promise(r => server.listen(PORT, r));
  const db = getDb(); resetDb(db);
  const aid = db.prepare("INSERT INTO users(username,password,role,display_name) VALUES('admin',?,'admin','管')").run(auth.hashPassword('pw')).lastInsertRowid;
  const sid = db.prepare("INSERT INTO users(username,password,role,display_name) VALUES('staff',?,'staff','员')").run(auth.hashPassword('pw')).lastInsertRowid;
  const a = { id: aid };
  const p = plotSvc.createPlot(a, { code: 'P1', name: '测试坡', geometry: { type: 'Polygon', coordinates: [[[0,0],[100,0],[100,100],[0,100]]] }, valid_from: '2026-01-01' });
  adoptSvc.createAdoption(a, { plot_id: p.id, adopter_name: '私密人', contact: '138****0001',
    period_start: '2026-01-01', period_end: '2026-12-31', area_m2: 2000, share_policy: 'fixed', price_amount: 99000 });
  farmSvc.pushDiary(a, { plot_id: p.id, entry_date: '2026-04-01', body: '春芽' });
  const g = farmSvc.createShareLink(a, { plot_id: p.id, gift_message: '节日快乐', expires_in_hours: 24 });
  goodGiftToken = g.token;
  db.prepare("INSERT INTO share_links(token,plot_id,gift_message,created_by,expires_at,revoked) VALUES('expiredtok',?,'过期',?,?,0)")
    .run(p.id, aid, new Date(Date.now() - 1000).toISOString());
  badGiftToken = 'expiredtok';
});
test.after(() => server.close());

test('登录获取会话 token', async () => {
  const r = await call('POST', '/api/auth/login', { body: { username: 'admin', password: 'pw' } });
  assert.equal(r.status, 200);
  assert.ok(r.json.token);
  assert.equal(r.json.role, 'admin');
  adminToken = r.json.token;
  const s = await call('POST', '/api/auth/login', { body: { username: 'staff', password: 'pw' } });
  staffToken = s.json.token;
});

test('错误口令 401', async () => {
  const r = await call('POST', '/api/auth/login', { body: { username: 'admin', password: '错' } });
  assert.equal(r.status, 401);
});

test('公开地图无需登录', async () => {
  const r = await call('GET', '/api/map?date=2026-10-01');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.features));
});

test('staff 受 403 拦截管理员操作（创建地块）', async () => {
  const r = await call('POST', '/api/plots', { token: staffToken, body: { name: 'x' } });
  assert.equal(r.status, 403);
});

test('admin 可创建地块并得到 v1', async () => {
  const r = await call('POST', '/api/plots', { token: adminToken, body: { name: '新坡', geometry: { type: 'Polygon', coordinates: [[[0,0],[20,0],[20,20],[0,20]]] } } });
  assert.equal(r.status, 200);
  assert.equal(r.json.versions.length, 1);
});

test('未登录访问受保护接口 401', async () => {
  assert.equal((await call('GET', '/api/adoptions')).status, 401);
});

test('公开地块接口匿名可读且裁剪认养人/价格/联系方式', async () => {
  const r = await call('GET', '/api/public/plots/1');
  assert.equal(r.status, 200);
  const raw = JSON.stringify(r.json);
  assert.ok(!raw.includes('私密人'));
  assert.ok(!raw.includes('99000'));
  assert.ok(!raw.includes('138****0001'));
  assert.ok(Array.isArray(r.json.versions));
  assert.ok(Array.isArray(r.json.adopted_periods));
});

test('重复分配认养通过 API 返回 409 + 冲突详情', async () => {
  const r = await call('POST', '/api/adoptions', { token: adminToken, body: {
    plot_id: 1, adopter_name: '抢面积', period_start: '2026-02-01', period_end: '2026-13-31', area_m2: 9000, share_policy: 'fixed' } });
  // 日期非法先 400
  assert.equal(r.status, 400);
  const r2 = await call('POST', '/api/adoptions', { token: adminToken, body: {
    plot_id: 1, adopter_name: '抢面积', period_start: '2026-02-01', period_end: '2026-12-31', area_m2: 9000, share_policy: 'fixed' } });
  assert.equal(r2.status, 409);
  assert.ok(r2.json.available_m2 !== undefined);
});

test('送礼视图：有效 token 200，过期 token 403，且私有字段不在响应体', async () => {
  const good = await call('GET', '/api/gift/view', { gift: goodGiftToken });
  assert.equal(good.status, 200);
  const raw = JSON.stringify(good.json);
  assert.ok(!raw.includes('私密人'));
  assert.ok(!raw.includes('99000'));
  assert.ok(!raw.includes('138****0001'));
  assert.equal(good.json.gift.message, '节日快乐');
  assert.equal((await call('GET', '/api/gift/view', { gift: badGiftToken })).status, 403);
  // 会话 token 不能当送礼 token 用（权限分离）
  assert.equal((await call('GET', '/api/gift/view', { gift: adminToken })).status, 403);
});

test('送礼视图不依赖登录会话（匿名可访问）', async () => {
  const r = await call('GET', '/api/gift/view', { gift: goodGiftToken });
  assert.equal(r.status, 200);
});

test('检测附件上传后撤回，下载从 200 变 410', async () => {
  const plots = await call('GET', '/api/plots', { token: adminToken });
  const pid = plots.json[0].id;
  const pk = await call('POST', '/api/pickings', { token: adminToken, body: { plot_id: pid, picked_on: '2026-05-01' } });
  const sp = await call('POST', '/api/samplings', { token: adminToken, body: { picking_batch_id: pk.json.id, sampled_on: '2026-05-01', scope_claim: '仅本批三点' } });
  const att = await call('POST', '/api/attachments', { token: adminToken, body: {
    filename: 'r.txt', mime: 'text/plain', sampling_batch_id: sp.json.id, content_base64: Buffer.from('hello').toString('base64') } });
  assert.equal(att.status, 200);
  const dl = await fetch(`${BASE}/api/attachments/${att.json.id}/download`, { headers: { 'X-Auth-Token': adminToken } });
  assert.equal(dl.status, 200);
  const wd = await call('POST', `/api/attachments/${att.json.id}/withdraw`, { token: adminToken, body: { reason: '撤回' } });
  assert.equal(wd.status, 200);
  const dl2 = await fetch(`${BASE}/api/attachments/${att.json.id}/download`, { headers: { 'X-Auth-Token': adminToken } });
  assert.equal(dl2.status, 410);
});
