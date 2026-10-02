'use strict';
// 初始化演示数据库（幂等：先清空再播种）
const { getDb, resetDb } = require('./src/db');
const auth = require('./src/auth');
const plotSvc = require('./src/plotService');
const adoptSvc = require('./src/adoptionService');
const farmSvc = require('./src/farmService');

const db = getDb();
resetDb(db);

const admin = (() => {
  const info = db.prepare("INSERT INTO users(username,password,role,display_name) VALUES('admin',?,'admin','茶园管理员')")
    .run(auth.hashPassword('tea-admin-2026'));
  return { id: info.lastInsertRowid };
})();
const staff = (() => {
  const info = db.prepare("INSERT INTO users(username,password,role,display_name) VALUES('staff',?,'staff','运营小周')")
    .run(auth.hashPassword('tea-staff-2026'));
  return { id: info.lastInsertRowid };
})();

const u = admin;
// 坡地初始地块（平面坐标，单位米；约 1 亩≈666.7㎡）
const p1 = plotSvc.createPlot(u, { code: 'P-01', name: '云坞一号坡', slope_zone: '云坞', valid_from: '2025-03-01',
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [120, 0], [120, 90], [0, 90]]] }, note: '开园首块坡，左缘 (0,0)-(0,90) 与 P-04 共边' });
const p2 = plotSvc.createPlot(u, { code: 'P-02', name: '青峰向阳坡', slope_zone: '青峰', valid_from: '2025-03-01',
  geometry: { type: 'Polygon', coordinates: [[[130, 0], [240, 0], [240, 90], [130, 90]]] }, note: '日照充足' });
const p3 = plotSvc.createPlot(u, { code: 'P-03', name: '栖霞老枞坡', slope_zone: '栖霞', valid_from: '2025-03-01',
  geometry: { type: 'Polygon', coordinates: [[[0, 100], [120, 100], [120, 180], [0, 180]]] }, note: '老枞茶树' });
const p4 = plotSvc.createPlot(u, { code: 'P-04', name: '云坞西坡', slope_zone: '云坞', valid_from: '2025-03-01',
  geometry: { type: 'Polygon', coordinates: [[[0, 0], [0, 90], [-50, 90], [-50, 0]]] }, note: '与云坞一号坡共右边界 (0,0)-(0,90)' });

// 农户
const f1 = farmSvc.createFarmer(u, { name: '陆建国', bio: '云坞片区三十年种茶户，擅长明前手采。', phone_last4: '2183' });
const f2 = farmSvc.createFarmer(u, { name: '韦敏', bio: '青峰片区农户，负责有机堆肥与虫情记录。', phone_last4: '0957' });
const f3 = farmSvc.createFarmer(u, { name: '盘文秀', bio: '栖霞老枞守护者，瑶家制茶技艺传人。', phone_last4: '6642' });

// 认养（锚定 2025 年的原始边界）
adoptSvc.createAdoption(u, { plot_id: p1.id, adopter_name: '沈知秋', contact: '138****2211',
  period_start: '2025-03-15', period_end: '2026-12-31', area_m2: 2400, share_policy: 'fixed',
  price_amount: 168000, note: '每年明前两斤' });
adoptSvc.createAdoption(u, { plot_id: p2.id, adopter_name: '杭州拾光科技', contact: 'hr@shiguang.example',
  period_start: '2025-04-01', period_end: '2026-06-30', area_m2: 3000, share_policy: 'redistribute',
  price_amount: 298000, note: '企业团建份额' });
adoptSvc.createAdoption(u, { plot_id: p3.id, adopter_name: '温言', contact: '159****8802',
  period_start: '2025-05-01', period_end: '2027-04-30', area_m2: 8000, share_policy: 'fixed',
  price_amount: 428000, note: '老枞专享（大面积固定份额）' });

// 2026-06-01：云坞一号坡沿竖向拆分为两块（验证旧认养保留 + 新边界面积对应 + 未决差异）
const split = plotSvc.splitPlot(u, p1.id, { line: { p1: [60, -10], p2: [60, 110] },
  names: ['云坞一号东坡', '云坞一号西坡'], event_date: '2026-06-01', note: '排水沟整修，依沟渠划界' });

// 2026-07-01：青峰向阳坡边界纠偏（GPS 复测，向坡顶微调）——版本条件提交场景
const cur2 = plotSvc.currentVersion(db, p2.id);
plotSvc.correctBoundary(u, p2.id, { expected_version_id: cur2.id, event_date: '2026-07-01',
  geometry: { type: 'Polygon', coordinates: [[[130, -4], [240, -4], [244, 92], [130, 92]]] },
  note: 'GPS RTK 复测纠偏，坡顶外扩约 4㎡' });

// 2026-08-01：栖霞老枞坡边界纠偏——因坡顶划为生态保育区而收缩边界。
// 温言的固定份额认养 8000㎡ 锚定旧边界，收缩后产生真实“未决差异”，等待后台裁决。
const cur3 = plotSvc.currentVersion(db, p3.id);
plotSvc.correctBoundary(u, p3.id, { expected_version_id: cur3.id, event_date: '2026-08-01',
  geometry: { type: 'Polygon', coordinates: [[[0, 100], [110, 100], [110, 164], [0, 164]]] },
  note: '坡顶 16㎡ 带宽划入生态保育区，边界收缩，老枞认养出现未决差异' });

// 2026-09-01：西坡（拆分产物）与云坞西坡 P-04 共整条直边，合并成一块
const [eastId, westId] = split.new_plots.map(p => p.id);
// 合并前在西坡上的固定份额认养：合并后旧认养按原边界保留，并对合并坡建立面积对应/未决差异
adoptSvc.createAdoption(u, { plot_id: westId, adopter_name: '苏婉', contact: '186****3012',
  period_start: '2026-07-10', period_end: '2027-07-09', area_m2: 1500, share_policy: 'fixed',
  price_amount: 96000, note: '西坡份额（合并演示）' });
const merged = plotSvc.mergePlots(u, [westId, p4.id], { name: '云坞西合并坡', event_date: '2026-09-01', note: '统一水肥管理合并' });
const mergedId = merged.new_plot.id;

// 拆分后在东坡上的新认养（同地块血缘重叠检查会参考历史）
adoptSvc.createAdoption(u, { plot_id: eastId, adopter_name: '林白', contact: '131****4455',
  period_start: '2026-07-01', period_end: '2027-06-30', area_m2: 900, share_policy: 'redistribute',
  price_amount: 88800, note: '新边界认养' });

// 日记
farmSvc.pushDiary(u, { plot_id: p2.id, farmer_id: f2.id, entry_date: '2026-03-12', weather: '多云 14℃',
  body: '经过一冬休养，向阳坡新芽密度高于去年，今日完成第一次浅耕。' });
farmSvc.pushDiary(u, { plot_id: p3.id, farmer_id: f3.id, entry_date: '2026-04-02', weather: '晴 19℃',
  body: '老枞开采首日，只采一芽一叶，下午萎凋四小时。' });
farmSvc.pushDiary(u, { plot_id: eastId, farmer_id: f1.id, entry_date: '2026-06-05', weather: '小雨',
  body: '拆沟后第一场雨，新西沟排水顺畅，东坡土壤含水量适宜。' });

// 采摘 + 采样批（严格声明范围）
const pk = farmSvc.createPicking(u, { plot_id: eastId, picked_on: '2026-06-10', leaf_qty_kg: 38.5, grade: '明后一级', note: '手采' });
const sp = farmSvc.createSampling(u, { picking_batch_id: pk.id, sampled_on: '2026-06-10',
  scope_claim: '云坞一号东坡（拆分后新边界，版本 v1）2026-06-10 批次鲜叶，按五点法取 3 个采样点，共 250g',
  scope_geometry: { type: 'MultiPoint', coordinates: [[75, 25], [100, 50], [85, 72]] },
  lab: '浙江省茶叶检验站', result_summary: '农残未检出（该采样范围内）；水浸出物 42.1%', result_at: '2026-06-18' });
farmSvc.putAttachment(u, { filename: '云坞东坡-2026春茶检测报告.txt', mime: 'text/plain', kind: 'test_report',
  sampling_batch_id: sp.id, content: Buffer.from('检测报告（示例）\n声明范围：仅限云坞一号东坡（x:60-120）2026-06-10 批次采样点。\n本结论不代表整座茶园。\n农残：未检出\n', 'utf8') });

// 送礼链接（15 天有效）
const gift = farmSvc.createShareLink(u, { plot_id: eastId, gift_message: '送你一亩春天的山坡，愿新茶与好消息一起发芽。', expires_in_hours: 24 * 15 });
const giftExpiredId = db.prepare(`INSERT INTO share_links(token,plot_id,gift_message,created_by,expires_at,revoked,max_views,view_count)
  VALUES(?,?,?,?,?,0,NULL,0)`).run(
  require('crypto').randomBytes(24).toString('hex'), p2.id,
  '这是一张已过期的示例链接。', u.id, new Date(Date.now() - 2 * 3600 * 1000).toISOString());
const giftExpired = { token: db.prepare('SELECT token FROM share_links WHERE id=?').get(giftExpiredId.lastInsertRowid).token };

console.log('种子数据已就绪');
console.log('登录：admin / tea-admin-2026 ；staff / tea-staff-2026');
console.log('送礼 token（有效）:', gift.token);
console.log('送礼 token（过期示例）:', giftExpired.token);
