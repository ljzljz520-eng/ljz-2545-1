'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const plots = require('./plotService');
const { httpError, token } = require('./auth');

const OBJECT_DIR = path.join(__dirname, '..', 'data', 'objects');
fs.mkdirSync(OBJECT_DIR, { recursive: true });

// ---------------- 农户 ----------------
function createFarmer(user, body) {
  if (!body.name) throw httpError(400, '农户姓名必填');
  const db = getDb();
  const info = db.prepare('INSERT INTO farmers(name,bio,phone_last4) VALUES(?,?,?)')
    .run(body.name, body.bio || '', body.phone_last4 || null);
  return db.prepare('SELECT * FROM farmers WHERE id=?').get(info.lastInsertRowid);
}
function listFarmers() {
  return getDb().prepare('SELECT * FROM farmers ORDER BY id').all();
}

// ---------------- 生长日记（离线幂等上送）----------------
function pushDiary(user, body) {
  const db = getDb();
  const plot = db.prepare('SELECT id FROM plots WHERE id=?').get(body.plot_id);
  if (!plot) throw httpError(404, '地块不存在');
  if (!body.entry_date || !/^\d{4}-\d{2}-\d{2}$/.test(body.entry_date)) throw httpError(400, 'entry_date 格式 YYYY-MM-DD');
  if (!body.body || !String(body.body).trim()) throw httpError(400, '日记内容必填');
  let uuid = body.client_uuid || null;
  if (uuid) {
    const existing = db.prepare('SELECT * FROM diaries WHERE client_uuid=?').get(uuid);
    if (existing) {
      // 幂等：离线客户端重试不产生重复
      db.prepare('UPDATE diaries SET body=?,weather=?,plot_id=?,farmer_id=?,entry_date=? WHERE id=?')
        .run(body.body, body.weather || null, body.plot_id, body.farmer_id || null, body.entry_date, existing.id);
      return { ...db.prepare('SELECT * FROM diaries WHERE id=?').get(existing.id), deduped: true };
    }
  } else {
    uuid = crypto.randomUUID();
  }
  const info = db.prepare('INSERT INTO diaries(plot_id,farmer_id,entry_date,body,weather,client_uuid) VALUES(?,?,?,?,?,?)')
    .run(body.plot_id, body.farmer_id || null, body.entry_date, body.body, body.weather || null, uuid);
  return db.prepare('SELECT * FROM diaries WHERE id=?').get(info.lastInsertRowid);
}
// 批量同步：全部成功或整体失败
function pushDiaries(user, items) {
  if (!Array.isArray(items)) throw httpError(400, '需要数组');
  const db = getDb();
  return db.transaction(() => items.map(it => pushDiary(user, it)))();
}
function listDiaries(plotId) {
  const db = getDb();
  const rows = plotId
    ? db.prepare(`SELECT d.*, f.name AS farmer_name FROM diaries d LEFT JOIN farmers f ON f.id=d.farmer_id
        WHERE d.plot_id=? ORDER BY entry_date DESC,d.id DESC`).all(plotId)
    : db.prepare(`SELECT d.*, f.name AS farmer_name, p.code AS plot_code FROM diaries d
        LEFT JOIN farmers f ON f.id=d.farmer_id JOIN plots p ON p.id=d.plot_id
        ORDER BY entry_date DESC,d.id DESC`).all();
  return rows.map(r => ({ ...r, has_attachments: db.prepare('SELECT COUNT(*) c FROM attachments WHERE diary_id=? AND status=?').get(r.id, 'archived').c }));
}

// ---------------- 采摘批次 ----------------
function createPicking(user, body) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM plots WHERE id=?').get(body.plot_id)) throw httpError(404, '地块不存在');
  if (!body.picked_on) throw httpError(400, '采摘日期必填');
  const code = body.code || `PK-${String(Date.now()).slice(-6)}-${crypto.randomBytes(2).toString('hex')}`;
  if (db.prepare('SELECT id FROM picking_batches WHERE code=?').get(code)) throw httpError(409, '批次编号重复');
  const info = db.prepare('INSERT INTO picking_batches(plot_id,code,picked_on,leaf_qty_kg,grade,note) VALUES(?,?,?,?,?,?)')
    .run(body.plot_id, code, body.picked_on, body.leaf_qty_kg || null, body.grade || null, body.note || '');
  return db.prepare('SELECT * FROM picking_batches WHERE id=?').get(info.lastInsertRowid);
}
function listPickings(plotId) {
  const db = getDb();
  return plotId
    ? db.prepare('SELECT * FROM picking_batches WHERE plot_id=? ORDER BY picked_on DESC').all(plotId)
    : db.prepare('SELECT pb.*, p.code AS plot_code FROM picking_batches pb JOIN plots p ON p.id=pb.plot_id ORDER BY pb.picked_on DESC').all();
}

// ---------------- 采样批：只代表声明范围 ----------------
function createSampling(user, body) {
  const db = getDb();
  const pk = db.prepare('SELECT * FROM picking_batches WHERE id=?').get(body.picking_batch_id);
  if (!pk) throw httpError(404, '采摘批次不存在');
  if (!body.scope_claim || !String(body.scope_claim).trim()) {
    throw httpError(400, '必须填写“声明范围”，检测结果仅对该范围负责，不得泛化到整园');
  }
  // 锚定采样发生时的边界版本——历史报告永远可回放当时边界
  const anchor = plots.currentVersion(db, body.plot_id || pk.plot_id, body.sampled_on || pk.picked_on);
  const code = body.code || `SP-${crypto.randomBytes(3).toString('hex')}`;
  const info = db.prepare(`INSERT INTO sampling_batches
    (picking_batch_id,plot_id,version_id,code,sampled_on,scope_claim,scope_geometry,lab,result_summary,result_at)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(pk.id, body.plot_id || pk.plot_id, anchor.id, code,
      body.sampled_on || pk.picked_on, body.scope_claim,
      body.scope_geometry ? JSON.stringify(body.scope_geometry) : null,
      body.lab || null, body.result_summary || null, body.result_at || null);
  return getSampling(db, info.lastInsertRowid);
}
function getSampling(db, id) {
  const s = db.prepare(`SELECT s.*, p.code AS plot_code, pb.code AS picking_code
    FROM sampling_batches s JOIN plots p ON p.id=s.plot_id
    JOIN picking_batches pb ON pb.id=s.picking_batch_id WHERE s.id=?`).get(id);
  if (!s) return null;
  s.scope_geometry = s.scope_geometry ? JSON.parse(s.scope_geometry) : null;
  s.attachments = db.prepare('SELECT id,filename,mime,bytes,status,created_at FROM attachments WHERE sampling_batch_id=? ORDER BY id').all(id)
    .filter(a => a.status === 'archived');
  return s;
}
function listSamplings() {
  const db = getDb();
  return db.prepare(`SELECT s.id,s.code,s.sampled_on,s.scope_claim,s.lab,s.result_summary,
      s.plot_id,p.code AS plot_code,pb.code AS picking_code,s.version_id
    FROM sampling_batches s JOIN plots p ON p.id=s.plot_id
    JOIN picking_batches pb ON pb.id=s.picking_batch_id ORDER BY s.sampled_on DESC`).all()
    .map(s => ({ ...s, applicability: `仅代表：${s.scope_claim}；不代表茶园其他地块或整园水平` }));
}

// ---------------- 检测附件：对象层归档/撤回 ----------------
function putAttachment(user, file) {
  const db = getDb();
  const idBytes = crypto.randomBytes(12).toString('hex');
  const safe = String(file.filename || 'file.bin').replace(/[^\w.\-一-龥]/g, '_');
  const key = `${new Date().toISOString().slice(0, 10)}/${idBytes}_${safe}`;
  const full = path.join(OBJECT_DIR, key);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, file.content);
  const info = db.prepare(`INSERT INTO attachments
    (object_key,filename,mime,bytes,kind,sampling_batch_id,diary_id,uploaded_by)
    VALUES(?,?,?,?,?,?,?,?)`)
    .run(key, safe, file.mime || 'application/octet-stream', file.content.length,
      file.kind || 'other', file.sampling_batch_id || null, file.diary_id || null, user.id);
  return db.prepare('SELECT id,object_key,filename,mime,bytes,kind,status,created_at FROM attachments WHERE id=?').get(info.lastInsertRowid);
}
function withdrawAttachment(user, id, reason) {
  const db = getDb();
  const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(id);
  if (!a) throw httpError(404, '附件不存在');
  if (a.status === 'withdrawn') throw httpError(409, '附件已撤回');
  db.transaction(() => {
    // 逻辑撤回 + 物理删除对象层文件；撤回后任何接口都无法再取到内容
    const full = path.join(OBJECT_DIR, a.object_key);
    if (fs.existsSync(full)) fs.unlinkSync(full);
    db.prepare(`UPDATE attachments SET status='withdrawn',withdrawn_reason=?,withdrawn_by=?,withdrawn_at=? WHERE id=?`)
      .run(reason || '', user.id, new Date().toISOString(), id);
  })();
  return { id, status: 'withdrawn', withdrawn_at: new Date().toISOString() };
}
function readAttachment(id) {
  const db = getDb();
  const a = db.prepare('SELECT * FROM attachments WHERE id=?').get(id);
  if (!a) throw httpError(404, '附件不存在');
  if (a.status === 'withdrawn') throw httpError(410, '该检测附件已被撤回，不再提供');
  const full = path.join(OBJECT_DIR, a.object_key);
  if (!fs.existsSync(full)) throw httpError(410, '对象层文件已不存在（可能已撤回）');
  return { meta: a, stream: fs.readFileSync(full) };
}

// ---------------- 送礼分享：独立权限接口 ----------------
function createShareLink(user, body) {
  const db = getDb();
  if (!db.prepare('SELECT id FROM plots WHERE id=?').get(body.plot_id)) throw httpError(404, '地块不存在');
  if (!body.expires_in_hours || body.expires_in_hours <= 0) throw httpError(400, '必须指定有效期（小时）');
  const t = token();
  const expires = new Date(Date.now() + body.expires_in_hours * 3600 * 1000).toISOString();
  const info = db.prepare(`INSERT INTO share_links(token,plot_id,gift_message,created_by,expires_at,max_views)
    VALUES(?,?,?,?,?,?)`)
    .run(t, body.plot_id, body.gift_message || '', user.id, expires,
      body.max_views == null ? null : Number(body.max_views));
  return db.prepare('SELECT id,token,plot_id,gift_message,expires_at,max_views,view_count,revoked FROM share_links WHERE id=?').get(info.lastInsertRowid);
}
function revokeShareLink(user, id) {
  const db = getDb();
  const l = db.prepare('SELECT * FROM share_links WHERE id=?').get(id);
  if (!l) throw httpError(404, '分享链接不存在');
  db.prepare('UPDATE share_links SET revoked=1 WHERE id=?').run(id);
  return { id, revoked: 1 };
}
function listShareLinks() {
  return getDb().prepare(`SELECT sl.*, p.code AS plot_code FROM share_links sl
    JOIN plots p ON p.id=sl.plot_id ORDER BY sl.id DESC`).all()
    .map(l => ({ ...l, expired: new Date(l.expires_at).getTime() < Date.now() }));
}

// 送礼视图 DTO：服务端裁剪——私有价格、认养人身份绝不序列化（不靠 CSS 隐藏）
function giftView(giftToken) {
  const db = getDb();
  const link = require('./auth').resolveGiftToken(giftToken);
  if (!link) throw httpError(403, '送礼链接无效或已过期');
  const plot = plots.getPlotFull(db, link.plot_id);
  if (!plot) throw httpError(404, '地块不存在');
  db.prepare('UPDATE share_links SET view_count=view_count+1 WHERE id=?').run(link.id);
  // 公开日记与农户故事；认养记录只暴露“时段”与“当前边界”，不暴露认养人/价格/联系方式
  const diaries = db.prepare(`SELECT entry_date,weather,body,f.name AS farmer_name FROM diaries d
    LEFT JOIN farmers f ON f.id=d.farmer_id WHERE d.plot_id=? ORDER BY entry_date DESC LIMIT 20`).all(link.plot_id);
  const farmers = db.prepare(`SELECT f.name,f.bio FROM farmers f
    WHERE f.id IN (SELECT DISTINCT farmer_id FROM diaries WHERE plot_id=? AND farmer_id IS NOT NULL)`).all(link.plot_id);
  return {
    gift: { message: link.gift_message, expires_at: link.expires_at },
    plot: {
      code: plot.code, name: plot.name, slope_zone: plot.slope_zone,
      current: plot.current ? {
        version_no: plot.current.version_no, valid_from: plot.current.valid_from,
        valid_to: plot.current.valid_to, area_m2: plot.current.area_m2, geometry: plot.current.geometry,
        time_window_text: `该边界自 ${plot.current.valid_from} 起有效${plot.current.valid_to ? `，至 ${plot.current.valid_to} 被新边界取代` : '（当前边界）'}`
      } : null,
      // 历史边界时段（让收礼人理解地图位置属于哪个时段）
      boundary_timeline: plot.versions.map(v => ({
        version_no: v.version_no, event: v.event, valid_from: v.valid_from, valid_to: v.valid_to, area_m2: v.area_m2
      }))
    },
    farmers,
    diaries,
    adopted_periods: db.prepare(`SELECT period_start,period_end,version_id FROM adoptions
      WHERE plot_id=? AND status='active' ORDER BY period_start`).all(link.plot_id),
    _disclaimer: '本页为送礼只读视图：不显示认养人身份、联系方式与认养价格；检测结论仅对其声明采样范围有效。'
  };
}

module.exports = {
  createFarmer, listFarmers,
  pushDiary, pushDiaries, listDiaries,
  createPicking, listPickings,
  createSampling, getSampling, listSamplings,
  putAttachment, withdrawAttachment, readAttachment,
  createShareLink, revokeShareLink, listShareLinks, giftView
};
