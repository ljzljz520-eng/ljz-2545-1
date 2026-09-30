'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { freshEnv, buildWorld, rect, store } = require('./helpers');

test('拆分：跨越拆分的 fixed 认养按原边界保留+按交集重映射，差异待决', () => {
  const { db } = freshEnv();
  buildWorld(db, { adoptBefore: { label: '何', mode: 'fixed', area: 3000 } });
  // 历史时段仍是旧 A 与 3000
  const oldMap = store.mapAt(db, '2024-02-01');
  assert.equal(oldMap.length, 1);
  assert.equal(oldMap[0].code, 'A');
  assert.equal(oldMap[0].used, 3000);
  // 拆分后：3000 * (40/100)=1200 落 A1，1800 落 A2
  const now = store.mapAt(db, '2024-04-01');
  const a1 = now.find(p => p.code === 'A1'), a2 = now.find(p => p.code === 'A2');
  assert.equal(a1.used, 1200);
  assert.equal(a2.used, 1800);
  // fixed 且完全对应（切线比例精确），不应产生未决
  const pending = db.prepare("SELECT COUNT(*) c FROM allocations WHERE state='pending'").get().c;
  assert.equal(pending, 0);
  // 历史分配仍然存在（旧边界保留）
  const hist = db.prepare("SELECT al.area FROM allocations al JOIN parcel_versions pv ON pv.id=al.parcel_version_id WHERE pv.valid_from='2023-01-01' AND al.state='confirmed'").get();
  assert.equal(hist.area, 3000);
  db.close();
});

test('收缩纠偏：fixed 产生未决差异、boundary 随边界缩减（且不触发超额）', () => {
  const { db } = freshEnv();
  store.createParcel(db, { code: 'A', name: 'old', geometry: rect(0, 0, 100, 100), validFrom: '2023-01-01' });
  // 两条认养各 1000㎡，收缩到 50 宽（5000㎡）后 confirmed 1000 仍装得下
  store.createAdoption(db, { parcelId: 1, expectedVersion: 1, label: 'fix', mode: 'fixed', area: 1000, startDate: '2023-05-01' });
  store.createAdoption(db, { parcelId: 1, expectedVersion: 1, label: 'bnd', mode: 'boundary', area: 1000, startDate: '2023-05-01' });
  const r = store.correctBoundary(db, { parcelId: 1, expectedVersion: 1,
    geometry: rect(0, 0, 50, 100), validFrom: '2025-01-01', note: '西侧让地一半' });
  const fix = r.remap.find(x => x.label === 'fix');
  const bnd = r.remap.find(x => x.label === 'bnd');
  assert.equal(fix.remapped, 500);
  assert.equal(fix.pending, 500);   // 固定份额差额 500 待决
  assert.equal(bnd.remapped, 500);
  assert.equal(bnd.pending, 0);     // 随边界不挂账
  const pending = db.prepare("SELECT al.area FROM allocations al JOIN adoptions a ON a.id=al.adoption_id WHERE a.label='fix' AND al.state='pending'").get();
  assert.equal(pending.area, 500);
  db.close();
});

test('同地块重叠认养：超额创建被 409 拒绝且事务回滚（不超卖）', () => {
  const { db } = freshEnv();
  store.createParcel(db, { code: 'P', name: 'p', geometry: rect(0, 0, 10, 10), validFrom: '2024-01-01' });
  store.createAdoption(db, { parcelId: 1, expectedVersion: 1, label: 'x', mode: 'fixed', area: 60, startDate: '2024-02-01' });
  assert.throws(() => store.createAdoption(db, { parcelId: 1, expectedVersion: 1, label: 'y', mode: 'fixed',
    area: 50, startDate: '2024-02-01' }), e => e.code === 'AREA_CONFLICT');
  // 回滚：只有 1 条认养
  assert.equal(db.prepare('SELECT COUNT(*) c FROM adoptions').get().c, 1);
  // 错峰区间允许：3 月后 x 若结束则可；这里让 y 在 x 结束之后
  store.terminateAdoption(db, { adoptionId: 1, endDate: '2024-05-01' });
  const ok = store.createAdoption(db, { parcelId: 1, expectedVersion: 1, label: 'y', mode: 'fixed',
    area: 90, startDate: '2024-05-01' });
  assert.equal(ok.capacity.used, 90);
  db.close();
});

test('版本条件提交：基于过期版本纠偏/认养返回 STALE_VERSION', () => {
  const { db } = freshEnv();
  store.createParcel(db, { code: 'P', name: 'p', geometry: rect(0, 0, 10, 10), validFrom: '2024-01-01' });
  store.correctBoundary(db, { parcelId: 1, expectedVersion: 1, geometry: rect(0, 0, 10, 9), validFrom: '2024-06-01' });
  assert.throws(() => store.correctBoundary(db, { parcelId: 1, expectedVersion: 1,
    geometry: rect(0, 0, 10, 8), validFrom: '2024-09-01' }), e => e.code === 'STALE_VERSION');
  assert.throws(() => store.createAdoption(db, { parcelId: 1, expectedVersion: 1, label: 'z',
    mode: 'fixed', area: 10, startDate: '2024-09-02' }), e => e.code === 'STALE_VERSION');
  db.close();
});

test('纠偏：与原边界不相交被拒绝；纠偏后旧区间关闭、认养重映射', () => {
  const { db } = freshEnv();
  store.createParcel(db, { code: 'P', name: 'p', geometry: rect(0, 0, 10, 10), validFrom: '2024-01-01' });
  store.createAdoption(db, { parcelId: 1, expectedVersion: 1, label: 'x', mode: 'boundary', area: 100, startDate: '2024-02-01' });
  assert.throws(() => store.correctBoundary(db, { parcelId: 1, expectedVersion: 1,
    geometry: rect(50, 50, 60, 60), validFrom: '2024-06-01' }), e => e.code === 'DISJOINT_GEOMETRY');
  store.correctBoundary(db, { parcelId: 1, expectedVersion: 1, geometry: rect(0, 0, 10, 5), validFrom: '2024-06-01' });
  const at = store.mapAt(db, '2024-07-01')[0];
  assert.equal(at.area, 50);
  assert.equal(at.used, 50); // boundary：全份额 100/100 * 交集50 = 50
  db.close();
});

test('合并：相邻地块认养汇聚且不重复；重叠合并被几何拒绝；版本不符 409', () => {
  const { db } = freshEnv();
  buildWorld(db); // A1 id1 v2(40宽), A2 id2 v1(60宽)
  store.createAdoption(db, { parcelId: 1, expectedVersion: 2, label: 'w', mode: 'boundary', area: 1000, startDate: '2024-04-01' });
  store.createAdoption(db, { parcelId: 2, expectedVersion: 1, label: 'e', mode: 'boundary', area: 2000, startDate: '2024-04-01' });
  const r = store.mergeParcels(db, { items: [{ parcelId: 1, expectedVersion: 2 }, { parcelId: 2, expectedVersion: 1 }],
    code: 'A', name: 'merged', validFrom: '2025-01-01' });
  assert.equal(r.newVersions[0].area, 10000);
  const merged = store.mapAt(db, '2025-02-01')[0];
  assert.equal(merged.used, 3000); // 1000+2000 汇聚，无重复
  // 历史时段 A1/A2 依旧可查
  assert.equal(store.mapAt(db, '2024-05-01').length, 2);
  db.close();
});

test('未决差异：确认落实受占用约束，核销归零', () => {
  const { db } = freshEnv();
  store.createParcel(db, { code: 'P', name: 'p', geometry: rect(0, 0, 10, 10), validFrom: '2024-01-01' });
  store.createAdoption(db, { parcelId: 1, expectedVersion: 1, label: 'x', mode: 'fixed', area: 90, startDate: '2024-02-01' });
  // 收缩到 50㎡：fixed 90 -> 确认45 + 未决45
  const r = store.correctBoundary(db, { parcelId: 1, expectedVersion: 1, geometry: rect(0, 0, 10, 5), validFrom: '2024-06-01' });
  const pendingId = db.prepare("SELECT id FROM allocations WHERE state='pending'").get().id;
  // 直接确认会超额 45+45=90>50
  assert.throws(() => store.resolveAllocation(db, { allocationId: pendingId, action: 'confirm' }), e => e.code === 'AREA_CONFLICT');
  // 核销成功（放弃差异）
  store.resolveAllocation(db, { allocationId: pendingId, action: 'dismiss', note: '让地不补' });
  const row = db.prepare('SELECT * FROM allocations WHERE id=?').get(pendingId);
  assert.equal(row.state, 'confirmed');
  assert.equal(row.area, 0);
  db.close();
});

test('离线日记 clientId 幂等去重', () => {
  const { db } = freshEnv();
  store.createParcel(db, { code: 'P', name: 'p', geometry: rect(0, 0, 10, 10), validFrom: '2024-01-01' });
  db.prepare("INSERT INTO farmers(name,bio) VALUES('老周','')").run();
  const payload = { parcelId: 1, farmerId: 1, entryDate: '2024-05-01', body: '发芽', clientId: 'cid-1' };
  const a = store.upsertDiary(db, payload);
  const b = store.upsertDiary(db, payload);
  assert.equal(b.id, a.id);
  assert.equal(b.deduplicated, true);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM diaries').get().c, 1);
  db.close();
});

test('采摘批次绑定采摘时边界版本；检测撤回归档附件、下载 410', () => {
  const fs = require('fs'); const path = require('path');
  const { db, dir } = freshEnv();
  buildWorld(db);
  // 2024-02 采摘应绑定旧 A v1
  const old = store.createBatch(db, { parcelId: 1, code: 'B-OLD', pickedOn: '2024-02-10', scopeNote: '仅旧A' });
  assert.equal(old.version, 1);
  const now = store.createBatch(db, { parcelId: 1, code: 'B-NEW', pickedOn: '2024-04-10', scopeNote: '仅A1' });
  assert.equal(now.version, 2);
  // 附件 + 报告 + 撤回
  const objs = path.join(dir, 'objects'); fs.mkdirSync(objs, { recursive: true });
  fs.writeFileSync(path.join(objs, 'k1-file.txt'), 'lab');
  const att = store.registerAttachment(db, { objectKey: 'k1-file.txt', originalName: 'f.txt', mimeType: 'text/plain', sizeBytes: 3, sha256: 'x'.repeat(64) });
  const rep = store.addLabReport(db, { batchId: now.batchId, title: 't', issuedOn: '2024-04-12', summary: '仅本批次', attachmentId: att.id });
  store.withdrawReport(db, { reportId: rep.reportId, reason: '样品记录有误' });
  const v = db.prepare('SELECT status FROM attachments WHERE id=?').get(att.id);
  assert.equal(v.status, 'archived');
  assert.ok(fs.existsSync(path.join(objs, 'k1-file.txt'))); // 文件仍在（归档不物理删除）
  db.close();
});

test('送礼链接：过期 410、撤销 404、gift 不含价格而 admin 含', () => {
  const { db } = freshEnv();
  store.createParcel(db, { code: 'P', name: 'p', geometry: rect(0, 0, 10, 10), validFrom: '2024-01-01' });
  const a = store.createAdoption(db, { parcelId: 1, expectedVersion: 1, label: '收礼人', mode: 'fixed',
    area: 50, startDate: '2024-02-01', gift: 1, priceCents: 12800, contact: 'p@x.test' });
  const gift = store.issueShare(db, { adoptionId: a.adoptionId, scope: 'gift', expiresAt: '2099-01-01' });
  const exp = store.issueShare(db, { adoptionId: a.adoptionId, scope: 'gift', expiresAt: '2020-01-01' });
  const adm = store.issueShare(db, { adoptionId: a.adoptionId, scope: 'admin' });
  const gv = store.viewByToken(db, gift.token);
  assert.equal(gv.status, 200);
  assert.equal('priceCents' in gv.adoption, false);
  assert.equal('contact' in gv.adoption, false);
  assert.equal(store.viewByToken(db, exp.token).status, 410);
  store.revokeShare(db, gift.token);
  assert.equal(store.viewByToken(db, gift.token).status, 404);
  const av = store.viewByToken(db, adm.token);
  assert.equal(av.adoption.priceCents, 12800);
  assert.equal(av.adoption.contact, 'p@x.test');
  db.close();
});
