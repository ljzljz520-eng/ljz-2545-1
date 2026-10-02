'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, plotSvc, adoptSvc, farmSvc, auth } = require('./helpers');

function basePlot(admin) {
  return plotSvc.createPlot(admin, { code: 'P1', name: '坡',
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [100, 0], [100, 100], [0, 100]]] }, valid_from: '2026-01-01' });
}

test('离线日记：相同 client_uuid 重试是幂等更新，不产生重复', () => {
  const { db, admin } = setup();
  const p = basePlot(admin);
  const uuid = 'offline-uuid-001';
  const d1 = farmSvc.pushDiary(admin, { plot_id: p.id, entry_date: '2026-04-01', body: '初稿', client_uuid: uuid });
  const d2 = farmSvc.pushDiary(admin, { plot_id: p.id, entry_date: '2026-04-01', body: '联网后的修订稿', client_uuid: uuid });
  assert.equal(d1.id, d2.id, '重试必须命中同一条记录');
  assert.equal(db.prepare('SELECT COUNT(*) c FROM diaries').get().c, 1);
  assert.equal(db.prepare('SELECT body FROM diaries WHERE id=?').get(d1.id).body, '联网后的修订稿');
});

test('离线日记批量同步整体成功', () => {
  const { db, admin } = setup();
  const p = basePlot(admin);
  const items = [
    { plot_id: p.id, entry_date: '2026-04-01', body: '一', client_uuid: 'a' },
    { plot_id: p.id, entry_date: '2026-04-02', body: '二', client_uuid: 'b' }
  ];
  const out = farmSvc.pushDiaries(admin, items);
  assert.equal(out.length, 2);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM diaries').get().c, 2);
});

test('采样批必须带“声明范围”，且列表只声明其范围不泛化整园', () => {
  const { admin } = setup();
  const p = basePlot(admin);
  const pk = farmSvc.createPicking(admin, { plot_id: p.id, picked_on: '2026-04-10', leaf_qty_kg: 20 });
  try {
    farmSvc.createSampling(admin, { picking_batch_id: pk.id, sampled_on: '2026-04-10', scope_claim: '' });
    assert.fail('缺少声明范围应报错');
  } catch (e) { assert.equal(e.status, 400); }
  farmSvc.createSampling(admin, { picking_batch_id: pk.id, sampled_on: '2026-04-10',
    scope_claim: 'P1 东坡采样点 3 处', lab: '测试站', result_summary: '合格（仅该范围）' });
  const list = farmSvc.listSamplings();
  assert.equal(list.length, 1);
  assert.ok(list[0].applicability.includes('仅代表'));
  assert.ok(list[0].applicability.includes('不代表茶园其他地块或整园'));
});

test('检测附件：归档可读；撤回后 410 且对象层文件被删除', () => {
  const { admin } = setup();
  const p = basePlot(admin);
  const pk = farmSvc.createPicking(admin, { plot_id: p.id, picked_on: '2026-04-10' });
  const sp = farmSvc.createSampling(admin, { picking_batch_id: pk.id, sampled_on: '2026-04-10', scope_claim: 'P1 三点' });
  const att = farmSvc.putAttachment(admin, { filename: '报告.txt', mime: 'text/plain', kind: 'test_report',
    sampling_batch_id: sp.id, content: Buffer.from('检测内容', 'utf8') });
  const fs = require('fs'); const path = require('path');
  const before = farmSvc.readAttachment(att.id);
  assert.equal(before.stream.toString(), '检测内容');
  const objPath = path.join(__dirname, '..', 'data', 'objects', att.object_key);
  assert.ok(fs.existsSync(objPath));
  farmSvc.withdrawAttachment(admin, att.id, '农户申请撤回');
  assert.ok(!fs.existsSync(objPath), '撤回必须物理删除对象文件');
  try { farmSvc.readAttachment(att.id); assert.fail('应拒绝读取'); }
  catch (e) { assert.equal(e.status, 410); }
});

test('送礼链接：过期/吊销后 giftView 返回 403', () => {
  const { db, admin } = setup();
  const p = basePlot(admin);
  // 过期链接（直接插库）
  const tok = require('crypto').randomBytes(12).toString('hex');
  db.prepare(`INSERT INTO share_links(token,plot_id,gift_message,created_by,expires_at,revoked)
    VALUES(?,?,?,?,?,0)`).run(tok, p.id, '过期礼', admin.id, new Date(Date.now() - 1000).toISOString());
  try { farmSvc.giftView(tok); assert.fail('过期应 403'); }
  catch (e) { assert.equal(e.status, 403); }
  // 有效链接
  const link = farmSvc.createShareLink(admin, { plot_id: p.id, gift_message: '新茶快乐', expires_in_hours: 24 });
  const view = farmSvc.giftView(link.token);
  assert.equal(view.gift.message, '新茶快乐');
  // 吊销
  farmSvc.revokeShareLink(admin, link.id);
  try { farmSvc.giftView(link.token); assert.fail('吊销应 403'); }
  catch (e) { assert.equal(e.status, 403); }
});

test('送礼视图服务端裁剪：不包含价格、认养人、联系方式', () => {
  const { admin } = setup();
  const p = basePlot(admin);
  adoptSvc.createAdoption(admin, { plot_id: p.id, adopter_name: '神秘认养人', contact: '138****0000',
    period_start: '2026-01-01', period_end: '2026-12-31', area_m2: 1000, share_policy: 'fixed', price_amount: 52000 });
  const farmer = farmSvc.createFarmer(admin, { name: '老农', bio: '种茶三十年' });
  farmSvc.pushDiary(admin, { plot_id: p.id, farmer_id: farmer.id, entry_date: '2026-04-01', body: '发芽了' });
  const link = farmSvc.createShareLink(admin, { plot_id: p.id, gift_message: '礼', expires_in_hours: 24 });
  const raw = JSON.stringify(farmSvc.giftView(link.token));
  assert.ok(!raw.includes('神秘认养人'), '认养人姓名不得出现');
  assert.ok(!raw.includes('52000') && !raw.includes('price'), '价格不得出现');
  assert.ok(!raw.includes('138****0000') && !raw.includes('contact'), '联系方式不得出现');
  assert.ok(raw.includes('发芽了'), '公开日记应出现');
  assert.ok(raw.includes('老农'), '农户公开信息应出现');
});

test('送礼视图：访问次数上限 max_views 生效', () => {
  const { admin } = setup();
  const p = basePlot(admin);
  const link = farmSvc.createShareLink(admin, { plot_id: p.id, gift_message: '限一次', expires_in_hours: 24, max_views: 1 });
  farmSvc.giftView(link.token); // 第一次
  try { farmSvc.giftView(link.token); assert.fail('超过 max_views 应 403'); }
  catch (e) { assert.equal(e.status, 403); }
});
