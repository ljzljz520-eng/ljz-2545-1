'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { setup, plotSvc, adoptSvc } = require('./helpers');

// 捕获服务抛出的 httpError（带 .status / .extra）
function expectThrow(fn, status) {
  try { fn(); } catch (e) {
    assert.equal(e.status, status, `期望 ${status}，实际 ${e.status}: ${e.message}`);
    return e;
  }
  assert.fail(`期望抛出 ${status}，但没有抛错`);
}

test('拆分：旧认养按原边界保留，新边界建立面积对应（fixed）', () => {
  const { db, admin } = setup();
  const p = plotSvc.createPlot(admin, { code: 'P1', name: '坡', geometry: { type: 'Polygon', coordinates: [[[0, 0], [120, 0], [120, 90], [0, 90]]] }, valid_from: '2026-01-01' });
  adoptSvc.createAdoption(admin, { plot_id: p.id, adopter_name: '甲', period_start: '2026-01-01',
    period_end: '2026-12-31', area_m2: 2400, share_policy: 'fixed', price_amount: 10000 });
  const r = plotSvc.splitPlot(admin, p.id, { line: { p1: [60, -10], p2: [60, 110] },
    names: ['东', '西'], event_date: '2026-06-01' });
  assert.equal(r.new_plots.length, 2);
  assert.equal(db.prepare("SELECT status FROM plots WHERE id=?").get(p.id).status, 'superseded');
  const total = r.new_plots.reduce((s, np) => s + np.current.area_m2, 0);
  assert.equal(Math.round(total), 10800);
  const old = db.prepare('SELECT * FROM adoptions WHERE adopter_name=?').get('甲');
  assert.equal(old.status, 'active');
  assert.equal(old.version_id, p.versions[0].id);
  assert.equal(old.area_m2, 2400);
  assert.equal(old.price_amount, 10000);
  const corrs = db.prepare('SELECT * FROM area_correspondences WHERE adoption_id=?').all(old.id);
  assert.equal(corrs.length, 2);
  assert.equal(corrs.reduce((s, c) => s + c.mapped_area_m2, 0), 2400);
  assert.ok(corrs.every(c => c.status === 'pending'));
});

test('redistribute：拆分后按几何比例新建认养，旧记录 migrated', () => {
  const { db, admin } = setup();
  const p = plotSvc.createPlot(admin, { code: 'P1', name: '坡', geometry: { type: 'Polygon', coordinates: [[[0, 0], [120, 0], [120, 90], [0, 90]]] }, valid_from: '2026-01-01' });
  adoptSvc.createAdoption(admin, { plot_id: p.id, adopter_name: '乙', period_start: '2026-01-01',
    period_end: '2026-12-31', area_m2: 2400, share_policy: 'redistribute', price_amount: 10000 });
  plotSvc.splitPlot(admin, p.id, { line: { p1: [60, -10], p2: [60, 110] }, names: ['东', '西'], event_date: '2026-06-01' });
  assert.ok(db.prepare("SELECT * FROM adoptions WHERE adopter_name='乙' AND status='migrated'").get());
  const fresh = db.prepare("SELECT * FROM adoptions WHERE adopter_name='乙' AND status='active'").all();
  assert.equal(fresh.length, 2);
  assert.equal(Math.round(fresh.reduce((s, a) => s + a.area_m2, 0)), 2400);
});

test('同地块同时期认养面积重复分配被拒绝（409）', () => {
  const { admin } = setup();
  const p = plotSvc.createPlot(admin, { code: 'P1', name: '坡', geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10]]] }, valid_from: '2026-01-01' });
  adoptSvc.createAdoption(admin, { plot_id: p.id, adopter_name: 'A', period_start: '2026-03-01',
    period_end: '2026-08-31', area_m2: 60, share_policy: 'fixed' });
  const e = expectThrow(() => adoptSvc.createAdoption(admin, { plot_id: p.id, adopter_name: 'B',
    period_start: '2026-05-01', period_end: '2026-09-30', area_m2: 60, share_policy: 'fixed' }), 409);
  assert.ok(e.extra.conflicting.length >= 1);
});

test('不重叠时段允许同一面积被再次认养', () => {
  const { db, admin } = setup();
  const p = plotSvc.createPlot(admin, { code: 'P1', name: '坡', geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10]]] }, valid_from: '2026-01-01' });
  adoptSvc.createAdoption(admin, { plot_id: p.id, adopter_name: 'A', period_start: '2026-01-01',
    period_end: '2026-06-30', area_m2: 100, share_policy: 'fixed' });
  adoptSvc.createAdoption(admin, { plot_id: p.id, adopter_name: 'B', period_start: '2026-07-01',
    period_end: '2026-12-31', area_m2: 100, share_policy: 'fixed' });
  assert.equal(db.prepare('SELECT COUNT(*) c FROM adoptions').get().c, 2);
});

test('跨版本：拆分后新认养不得与按原边界保留的旧认养超卖', () => {
  const { admin } = setup();
  const p = plotSvc.createPlot(admin, { code: 'P1', name: '坡', geometry: { type: 'Polygon', coordinates: [[[0, 0], [100, 0], [100, 100], [0, 100]]] }, valid_from: '2026-01-01' });
  adoptSvc.createAdoption(admin, { plot_id: p.id, adopter_name: '旧', period_start: '2026-01-01',
    period_end: '2026-12-31', area_m2: 10000, share_policy: 'fixed' });
  const r = plotSvc.splitPlot(admin, p.id, { line: { p1: [50, -10], p2: [50, 110] },
    names: ['东', '西'], event_date: '2026-06-01' });
  const east = r.new_plots[0].id;
  expectThrow(() => adoptSvc.createAdoption(admin, { plot_id: east, adopter_name: '新',
    period_start: '2026-07-01', period_end: '2026-12-31', area_m2: 100, share_policy: 'redistribute' }), 409);
});

test('跨版本：旧认养到期后，新边界面积可重新认养', () => {
  const { db, admin } = setup();
  const p = plotSvc.createPlot(admin, { code: 'P1', name: '坡', geometry: { type: 'Polygon', coordinates: [[[0, 0], [100, 0], [100, 100], [0, 100]]] }, valid_from: '2026-01-01' });
  adoptSvc.createAdoption(admin, { plot_id: p.id, adopter_name: '旧', period_start: '2026-01-01',
    period_end: '2026-06-30', area_m2: 10000, share_policy: 'fixed' });
  const r = plotSvc.splitPlot(admin, p.id, { line: { p1: [50, -10], p2: [50, 110] },
    names: ['东', '西'], event_date: '2026-07-01' });
  // 旧认养 6/30 到期、拆分 7/1 生效 → 新认养从 7/1 起不冲突
  adoptSvc.createAdoption(admin, { plot_id: r.new_plots[0].id, adopter_name: '新',
    period_start: '2026-07-01', period_end: '2027-06-30', area_m2: 1000, share_policy: 'redistribute' });
  assert.equal(db.prepare("SELECT COUNT(*) c FROM adoptions WHERE adopter_name='新'").get().c, 1);
});

test('边界纠偏：版本条件提交——旧版本号提交返回 409', () => {
  const { admin } = setup();
  const p = plotSvc.createPlot(admin, { code: 'P1', name: '坡', geometry: { type: 'Polygon', coordinates: [[[0, 0], [100, 0], [100, 100], [0, 100]]] }, valid_from: '2026-01-01' });
  const v1 = p.versions[0].id;
  plotSvc.correctBoundary(admin, p.id, { expected_version_id: v1, event_date: '2026-05-01',
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [105, 0], [105, 100], [0, 100]]] } });
  const e = expectThrow(() => plotSvc.correctBoundary(admin, p.id, {
    expected_version_id: v1, event_date: '2026-06-01',
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [108, 0], [108, 100], [0, 100]]] } }), 409);
  assert.ok(e.extra.current_version_id > v1);
});

test('并发占用：第二个管理员在租约期内编辑返回 423', () => {
  const { db, admin } = setup();
  const otherId = db.prepare("INSERT INTO users(username,password,role,display_name) VALUES('b',?,'admin','B')")
    .run(require('../src/auth').hashPassword('x')).lastInsertRowid;
  const p = plotSvc.createPlot(admin, { code: 'P1', name: '坡', geometry: { type: 'Polygon', coordinates: [[[0, 0], [100, 0], [100, 100], [0, 100]]] }, valid_from: '2026-01-01' });
  const vid = p.versions[0].id;
  plotSvc.acquireLock(admin, vid, 600);
  expectThrow(() => plotSvc.acquireLock({ id: otherId, role: 'admin' }, vid, 600), 423);
  assert.doesNotThrow(() => plotSvc.acquireLock(admin, vid, 600));
});

test('时间回放：mapAt 返回对应日期存在的边界', () => {
  const { admin } = setup();
  const p = plotSvc.createPlot(admin, { code: 'P1', name: '坡', geometry: { type: 'Polygon', coordinates: [[[0, 0], [100, 0], [100, 100], [0, 100]]] }, valid_from: '2026-01-01' });
  plotSvc.splitPlot(admin, p.id, { line: { p1: [50, -10], p2: [50, 110] }, names: ['东', '西'], event_date: '2026-06-01' });
  const before = plotSvc.mapAt('2026-05-31');
  const after = plotSvc.mapAt('2026-06-02');
  assert.ok(before.some(f => f.code === 'P1'));
  assert.equal(before.filter(f => f.plot_id === p.id).length, 1);
  assert.ok(!after.some(f => f.code === 'P1'));
  assert.equal(after.length, 2);
});

test('合并共边地块后面积=两块之和', () => {
  const { admin } = setup();
  const a = plotSvc.createPlot(admin, { code: 'A', name: '东', geometry: { type: 'Polygon', coordinates: [[[0, 0], [60, 0], [60, 90], [0, 90]]] }, valid_from: '2026-01-01' });
  const b = plotSvc.createPlot(admin, { code: 'B', name: '西', geometry: { type: 'Polygon', coordinates: [[[-50, 0], [0, 0], [0, 90], [-50, 90]]] }, valid_from: '2026-01-01' });
  const m = plotSvc.mergePlots(admin, [a.id, b.id], { event_date: '2026-07-01' });
  assert.equal(Math.round(m.new_plot.current.area_m2), 5400 + 4500);
});

test('fixed 纠偏外扩：未决面积不为负，已对应面积保持旧认养面积', () => {
  const { db, admin } = setup();
  const p = plotSvc.createPlot(admin, { code: 'P1', name: '坡', geometry: { type: 'Polygon', coordinates: [[[0, 0], [100, 0], [100, 100], [0, 100]]] }, valid_from: '2026-01-01' });
  adoptSvc.createAdoption(admin, { plot_id: p.id, adopter_name: '甲', period_start: '2026-01-01',
    period_end: '2026-12-31', area_m2: 5000, share_policy: 'fixed' });
  plotSvc.correctBoundary(admin, p.id, { expected_version_id: p.versions[0].id,
    event_date: '2026-05-01', geometry: { type: 'Polygon', coordinates: [[[0, 0], [105, 0], [105, 100], [0, 100]]] } });
  const c = db.prepare('SELECT * FROM area_correspondences').get();
  assert.ok(c.pending_area_m2 >= 0);
  assert.equal(c.mapped_area_m2, 5000);
});

test('面积超当时边界：创建认养返回 422', () => {
  const { admin } = setup();
  const p = plotSvc.createPlot(admin, { code: 'P1', name: '坡', geometry: { type: 'Polygon', coordinates: [[[0, 0], [10, 0], [10, 10], [0, 10]]] }, valid_from: '2026-01-01' });
  expectThrow(() => adoptSvc.createAdoption(admin, { plot_id: p.id, adopter_name: 'X',
    period_start: '2026-01-01', period_end: '2026-12-31', area_m2: 200, share_policy: 'fixed' }), 422);
});

test('纠偏收缩：fixed 认养超出新边界的部分成为未决差异（pending>0）', () => {
  const { db, admin } = setup();
  const p = plotSvc.createPlot(admin, { code: 'P1', name: '坡', geometry: { type: 'Polygon', coordinates: [[[0, 0], [100, 0], [100, 100], [0, 100]]] }, valid_from: '2026-01-01' });
  adoptSvc.createAdoption(admin, { plot_id: p.id, adopter_name: '大户', period_start: '2026-01-01',
    period_end: '2027-12-31', area_m2: 8000, share_policy: 'fixed' });
  // 边界收缩到 7040 ㎡（110 x 64）
  plotSvc.correctBoundary(admin, p.id, { expected_version_id: p.versions[0].id, event_date: '2026-08-01',
    geometry: { type: 'Polygon', coordinates: [[[0, 0], [110, 0], [110, 64], [0, 64]]] } });
  const c = db.prepare('SELECT * FROM area_correspondences').get();
  assert.ok(c.pending_area_m2 > 0, '应有正的未决差异');
  assert.equal(Math.round((c.mapped_area_m2 + c.pending_area_m2) * 100), 800000);
  // 未决差异占位：新边界上无法再按完整面积重复认养
  const avail = plotSvc.availability(db, p.id, '2026-09-01');
  assert.ok(avail.available_m2 < avail.area_m2);
});

test('两种份额策略对比可查（comparePolicies）', () => {
  const { admin } = setup();
  const p = plotSvc.createPlot(admin, { code: 'P1', name: '坡', geometry: { type: 'Polygon', coordinates: [[[0, 0], [100, 0], [100, 100], [0, 100]]] }, valid_from: '2026-01-01' });
  adoptSvc.createAdoption(admin, { plot_id: p.id, adopter_name: '甲', period_start: '2026-01-01',
    period_end: '2026-12-31', area_m2: 3000, share_policy: 'fixed' });
  const cmp = adoptSvc.comparePolicies(p.id);
  assert.equal(cmp.length, 1);
  assert.equal(cmp[0].current_policy, 'fixed');
  assert.ok(cmp[0].fixed.未决差异暴露 === true);
});
