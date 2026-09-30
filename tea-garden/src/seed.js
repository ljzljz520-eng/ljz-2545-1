'use strict';
// 初始化演示数据：山坡 4 个地块（其中 A 在 2024 年拆分过），农户、日记、采摘批次+检测、送礼链接
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { openDb, initSchema, getDbFile, getObjectsDir } = require('./db');
const store = require('./store');

const today = () => new Date().toISOString().slice(0, 10);

function reset() {
  const dbFile = getDbFile(), objs = getObjectsDir();
  for (const f of [dbFile, dbFile + '-wal', dbFile + '-shm']) {
    try { fs.rmSync(f); } catch (_) {}
  }
  fs.mkdirSync(objs, { recursive: true });
  for (const f of fs.readdirSync(objs)) fs.rmSync(path.join(objs, f), { recursive: true, force: true });
}

function run() {
  reset();
  const db = openDb();
  initSchema(db);

  // 用户（演示用弱口令，仅本地）
  const hash = pw => crypto.createHash('sha256').update(pw).digest('hex');
  db.prepare('INSERT INTO users(username,display_name,role,password,farmer_id) VALUES(?,?,?,?,?)')
    .run('admin', '茶园管理员', 'admin', hash('admin123'), null);

  // 农户
  const f1 = db.prepare("INSERT INTO farmers(name,bio) VALUES(?,?)")
    .run('周阿福', '云雾峰种茶 28 年，负责北坡 A、B 区，擅长明前手工采摘。').lastInsertRowid;
  const f2 = db.prepare("INSERT INTO farmers(name,bio) VALUES(?,?)")
    .run('林小满', '回乡青年农人，负责南坡 C 区，推行虫情诱捕与堆肥。').lastInsertRowid;
  db.prepare('INSERT INTO users(username,display_name,role,password,farmer_id) VALUES(?,?,?,?,?)')
    .run('farmer', '周阿福', 'farmer', hash('farmer123'), f1);
  const adminId = db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  const farmerUserId = db.prepare("SELECT id FROM users WHERE username='farmer'").get().id;

  // 坐标：米制；山坡示意（北坡在图上方）。2023-01-01 初始大地块 P01
  const A2023 = { type: 'Polygon', coordinates: [[[120, 80], [520, 80], [520, 300], [120, 300], [120, 80]]] };
  store.createParcel(db, { code: 'A', name: '北坡甲坞（老区）', geometry: A2023, validFrom: '2023-01-01', note: '开园原始边界', userId: adminId });

  // 一份跨越 2024 拆分的老认养：创建于旧边界 v1；拆分时旧版本记录按原边界保留，
  // 系统自动按几何交集把面积对应到 A1/A2，固定份额不足部分记为未决差异。
  store.createAdoption(db, { parcelId: 1, expectedVersion: 1, label: '老客户·何老伯', mode: 'fixed',
    area: 3000, startDate: '2023-05-01', endDate: '2025-05-01', gift: 0, priceCents: 50000, contact: 'he@example.com' });

  // 2024-03-01 拆分 A -> A1（延续片 v2）+ A2（新地块 v1），竖直切于 x=300
  db.prepare("UPDATE parcels SET slope_angle=18 WHERE code='A'").run();
  store.splitParcel(db, {
    parcelId: 1, expectedVersion: 1,
    cut: { p1: { x: 300, y: 80 }, p2: { x: 300, y: 300 } },
    children: [{ code: 'A1', name: '北坡甲坞·西片', slopeAngle: 20 }, { code: 'A2', name: '北坡甲坞·东片', slopeAngle: 16 }],
    validFrom: '2024-03-01', note: '排水沟扩建，沿石坎拆为两片', userId: adminId,
  });

  // 拆分后：id 1=A1（延续片 v2），id 2=A2（新建 v1）
  // B 区（与 A2 东片相邻，id=3）
  const B = { type: 'Polygon', coordinates: [[[520, 80], [760, 80], [760, 300], [520, 300], [520, 80]]] };
  store.createParcel(db, { code: 'B', name: '北坡云带', geometry: B, validFrom: '2023-01-01', note: '初始边界', userId: adminId });
  db.prepare("UPDATE parcels SET slope_angle=22 WHERE code='B'").run();

  // C 区（南坡）
  const C = { type: 'Polygon', coordinates: [[[220, 360], [620, 360], [620, 560], [220, 560], [220, 360]]] };
  store.createParcel(db, { code: 'C', name: '南坡向阳坪', geometry: C, validFrom: '2023-01-01', note: '初始边界', userId: adminId });
  db.prepare("UPDATE parcels SET slope_angle=12 WHERE code='C'").run();

  // 认养
  const pv = id => db.prepare('SELECT id FROM parcel_versions WHERE parcel_id=? AND valid_to IS NULL').get(id).id;
  store.createAdoption(db, { parcelId: 1, expectedVersion: 2, label: '陈一（明前份额）', mode: 'fixed',
    area: 4000, startDate: '2024-03-02', endDate: '2025-03-01', gift: 1, priceCents: 128000, contact: 'chen@example.com' });
  store.createAdoption(db, { parcelId: 1, expectedVersion: 2, label: '青野工作室', mode: 'boundary',
    area: 2000, startDate: '2025-01-01', endDate: null, gift: 0, priceCents: 60000, contact: 'team@qingye.test' });
  store.createAdoption(db, { parcelId: 2, expectedVersion: 1, label: '苏晓（随边界份额）', mode: 'boundary',
    area: 3000, startDate: '2024-06-01', endDate: null, gift: 0, priceCents: 90000, contact: 'su@example.com' });
  store.createAdoption(db, { parcelId: 4, expectedVersion: 1, label: '山雾读书会', mode: 'fixed',
    area: 6000, startDate: '2025-04-01', endDate: '2026-04-01', gift: 1, priceCents: 180000, contact: 'club@shanwu.test' });

  // 日记
  const diary = (parcelId, farmerId, date, weather, body, clientId) =>
    store.upsertDiary(db, { parcelId, farmerId, entryDate: date, weather, body, clientId });
  diary(1, f1, '2025-03-12', '多云转晴 14℃', '明前芽头冒出约一粒米长，石坎西片发芽早两到三天。今天安排四人手采，留鱼叶。', 'seed-d1');
  diary(2, f1, '2025-03-15', '阴 12℃', '东片昨夜有轻霜，推迟采摘一天，沟边覆盖稻草防冻。', 'seed-d2');
  diary(4, f2, '2025-04-02', '晴 19℃', '南坡放置黄色诱虫板 40 张，堆肥追施茶树行间距根部 20cm。', 'seed-d3');
  diary(1, f1, '2025-09-20', '小雨 18℃', '秋梢整齐，修剪蓬面保持弧形。给认养人寄出秋茶小样。', 'seed-d4');

  // 采摘批次 + 检测（只声明该批次范围）
  const b1 = store.createBatch(db, { parcelId: 1, code: 'PCK-2025-A1-01', pickedOn: '2025-03-12',
    scopeNote: '仅 A1 西片、2025-03-12 当日手采的明前鲜叶，约 42kg', leafKind: '明前龙井种', yieldKg: 42 });
  const b2 = store.createBatch(db, { parcelId: 2, code: 'PCK-2025-A2-01', pickedOn: '2025-03-18',
    scopeNote: '仅 A2 东片霜后第一轮，约 30kg', leafKind: '明前龙井种', yieldKg: 30 });
  const b3 = store.createBatch(db, { parcelId: 4, code: 'PCK-2025-C-01', pickedOn: '2025-04-05',
    scopeNote: '仅 C 区南坡向阳坪雨前批次，约 80kg', leafKind: '群体种', yieldKg: 80 });

  // 造一个文本附件入对象层
  const objDir = getObjectsDir();
  const put = (name, content, mime) => {
    const buf = Buffer.from(content);
    const key = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16) + '-' + name.replace(/[^\w.-]/g, '_');
    fs.writeFileSync(path.join(objDir, key), buf);
    return store.registerAttachment(db, { objectKey: key, originalName: name, mimeType: mime, sizeBytes: buf.length,
      sha256: crypto.createHash('sha256').update(buf).digest('hex') });
  };
  const rep = put('A1-2025明前-农残快检.txt',
    '样品：PCK-2025-A1-01（A1 西片 2025-03-12 手采）\n项目：有机磷/拟除虫菊酯快速检测\n结果：阴性（未检出）\n检测方：县农产品检测流动站\n注意：本结果仅对来样批次负责。\n',
    'text/plain');
  store.addLabReport(db, { batchId: b1.batchId, title: 'A1 明前批次农残快检', labName: '县农产品检测流动站',
    issuedOn: '2025-03-14', summary: '该批次鲜叶快检未检出有机磷与拟除虫菊酯。结论仅适用于 PCK-2025-A1-01 声明范围。', attachmentId: rep.id });
  store.addLabReport(db, { batchId: b2.batchId, title: 'A2 霜后批次自检记录', labName: '茶农合作社自检',
    issuedOn: '2025-03-19', summary: '合作社自检含水率与碎茶率合格。无第三方农残检测，不代表全园结论。' });

  // 送礼链接：一个有效（gift 范围，不含价格），一个已过期，一个 admin 范围
  const g1 = store.issueShare(db, { adoptionId: 1, scope: 'gift', expiresAt: '2099-12-31', userId: adminId });
  const g2 = store.issueShare(db, { adoptionId: 4, scope: 'gift', expiresAt: '2025-12-31', userId: adminId });
  const g3 = store.issueShare(db, { adoptionId: 1, scope: 'admin', expiresAt: '2099-12-31', userId: adminId });

  const summary = {
    users: { admin: 'admin / admin123', farmer: 'farmer / farmer123' },
    giftTokens: { validGift: g1.token, expiredGift: g2.token, adminScope: g3.token },
    parcels: db.prepare('SELECT id,code,name FROM parcels').all(),
  };
  fs.writeFileSync(path.join(path.dirname(getDbFile()), 'seed-manifest.json'), JSON.stringify(summary, null, 2));
  console.log('种子数据写入完成：');
  console.log(JSON.stringify(summary, null, 2));
  db.close();
  return summary;
}

if (require.main === module) run();
module.exports = { run };
