'use strict';
const { getDb } = require('./db');
const plots = require('./plotService');
const { httpError } = require('./auth');
const geo = require('./geometry');

function validPeriod(start, end) {
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(start || '') || !iso.test(end || '')) {
    throw httpError(400, '日期格式应为 YYYY-MM-DD');
  }
  const validDate = (d) => {
    const [y, m, day] = d.split('-').map(Number);
    if (m < 1 || m > 12) return false;
    return day >= 1 && day <= new Date(Date.UTC(y, m, 0)).getUTCDate();
  };
  if (!validDate(start) || !validDate(end)) throw httpError(400, '日期不存在，请检查月份与日');
  if (start > end) throw httpError(400, '认养开始日不能晚于结束日');
}

// 创建认养（后台）。关键约束：同一时期同一地块血缘的认养面积不得重复分配。
// 校验按“几何面积份额”在时间重叠窗口内汇总，无论锚定哪个边界版本——
// 旧认养按原边界保留，在其有效期内持续占位。
function createAdoption(user, body) {
  const db = getDb();
  const { plot_id, adopter_name, period_start, period_end, area_m2, share_policy, price_amount, contact, note } = body;
  if (!adopter_name) throw httpError(400, '认养人必填');
  validPeriod(period_start, period_end);
  const area = Number(area_m2);
  if (!(area > 0)) throw httpError(400, '认养面积必须为正数');
  const policy = share_policy === 'redistribute' ? 'redistribute' : 'fixed';

  // 认养锚定“认养开始时”的边界版本
  const anchor = plots.currentVersion(db, plot_id, period_start);
  if (!anchor) throw httpError(404, '该日期没有有效地块边界');
  if (area > anchor.area_m2 + 0.01) {
    throw httpError(422, `认养面积 ${area}㎡ 超过当时边界面积 ${anchor.area_m2}㎡`);
  }
  assertNoOverbook(db, plot_id, period_start, period_end, area, null, anchor);

  const info = db.prepare(`INSERT INTO adoptions
    (plot_id,version_id,adopter_name,contact,period_start,period_end,area_m2,share_policy,price_amount,note,created_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
    .run(plot_id, anchor.id, adopter_name, contact || null, period_start, period_end,
      area, policy, price_amount == null ? null : Math.round(price_amount), note || '', user.id);
  return getAdoption(db, info.lastInsertRowid);
}

// 重叠占用检查。同一地块血缘上、同一时期的认养面积不得重复分配：
//  1) 直接锚定本地块且时间重叠的认养；
//  2) 拆分/合并后“按原边界保留”的祖先认养——按事件面积对应（mapped，含 pending 未决差异）折算到本地块。
function assertNoOverbook(db, plotId, start, end, addArea, excludeId, anchorVersion) {
  const direct = db.prepare(`SELECT * FROM adoptions WHERE plot_id=? AND status='active'
    AND period_start <= ? AND period_end >= ?`).all(plotId, end, start)
    .filter(r => r.id !== excludeId);
  const days = new Set([start, ...direct.map(r => r.period_start)]);
  const boundaryArea = anchorVersion.area_m2;
  for (const day of days) {
    if (day < start || day > end) continue;
    const v = plots.currentVersion(db, plotId, day);
    const limit = Math.min(boundaryArea, v ? v.area_m2 : boundaryArea);
    const activeDirect = direct.filter(r => r.period_start <= day && r.period_end >= day);
    let used = activeDirect.reduce((s, r) => s + r.area_m2, 0);
    // 祖先认养（原边界保留）在该日、该地块上的占用份额；未决差异同样占位，裁决前不可再分
    const lineage = plots.lineageOccupancy(db, plotId, day)
      .filter(o => {
        if (o.adoption_id === excludeId) return false;
        const a = db.prepare('SELECT * FROM adoptions WHERE id=?').get(o.adoption_id);
        return a && a.status === 'active' && a.period_start <= day && a.period_end >= day &&
          a.plot_id !== plotId;
      });
    used += lineage.reduce((s, o) => s + o.area_m2 + o.pending_m2, 0);
    if (used + addArea > limit + 0.01) {
      throw httpError(409, `日期 ${day} 将出现重复分配：已认养（含原边界保留份额）${Math.round(used * 100) / 100}㎡ + 本次 ${addArea}㎡ > 可用 ${Math.round(limit * 100) / 100}㎡`, {
        date: day, used_m2: Math.round(used * 100) / 100, requested_m2: addArea,
        available_m2: Math.round(Math.max(0, limit - used) * 100) / 100,
        conflicting: activeDirect.map(r => ({ adoption_id: r.id, adopter: r.adopter_name, period: [r.period_start, r.period_end], area_m2: r.area_m2 })),
        lineage: lineage.map(o => ({ adoption_id: o.adoption_id, mapped_m2: o.area_m2, pending_m2: o.pending_m2, policy: o.policy }))
      });
    }
  }
}

function updateAdoption(user, id, body) {
  const db = getDb();
  const cur = getAdoption(db, id);
  if (!cur) throw httpError(404, '认养记录不存在');
  const start = body.period_start || cur.period_start;
  const end = body.period_end || cur.period_end;
  const area = body.area_m2 != null ? Number(body.area_m2) : cur.area_m2;
  validPeriod(start, end);
  const anchor = plots.currentVersion(db, cur.plot_id, start);
  if (area > anchor.area_m2 + 0.01) throw httpError(422, '认养面积超过当时边界面积');
  assertNoOverbook(db, cur.plot_id, start, end, area, id, anchor);
  db.prepare(`UPDATE adoptions SET period_start=?,period_end=?,area_m2=?,
    share_policy=?,price_amount=?,contact=?,note=? WHERE id=?`)
    .run(start, end, area,
      body.share_policy === 'redistribute' ? 'redistribute' : (body.share_policy || cur.share_policy),
      body.price_amount === undefined ? cur.price_amount : (body.price_amount == null ? null : Math.round(body.price_amount)),
      body.contact === undefined ? cur.contact : body.contact,
      body.note === undefined ? cur.note : body.note, id);
  return getAdoption(db, id);
}

function resolveCorrespondence(user, id, { status, resolution_note }) {
  const db = getDb();
  const c = db.prepare('SELECT * FROM area_correspondences WHERE id=?').get(id);
  if (!c) throw httpError(404, '对应关系不存在');
  if (status !== 'resolved') throw httpError(400, '只能标记为 resolved');
  db.prepare('UPDATE area_correspondences SET status=?,resolution_note=?,resolved_by=?,resolved_at=? WHERE id=?')
    .run('resolved', resolution_note || '', user.id, new Date().toISOString(), id);
  return db.prepare('SELECT * FROM area_correspondences WHERE id=?').get(id);
}

function getAdoption(db, id) {
  const a = db.prepare('SELECT * FROM adoptions WHERE id=?').get(id);
  if (!a) return null;
  const v = plots.getVersion(db, a.version_id);
  return { ...a, anchor_version_no: v.version_no, anchor_valid_from: v.valid_from, anchor_valid_to: v.valid_to };
}
function listAdoptions(plotId) {
  const db = getDb();
  const sql = plotId
    ? 'SELECT * FROM adoptions WHERE plot_id=? ORDER BY period_start'
    : 'SELECT * FROM adoptions ORDER BY period_start';
  const rows = plotId ? db.prepare(sql).all(plotId) : db.prepare(sql).all();
  return rows.map(a => {
    const v = plots.getVersion(db, a.version_id);
    const plot = db.prepare('SELECT code,name FROM plots WHERE id=?').get(a.plot_id);
    return { ...a, plot_code: plot.code, plot_name: plot.name, anchor_version_no: v.version_no, anchor_valid_from: v.valid_from };
  });
}
function listCorrespondences(status) {
  const db = getDb();
  const sql = `SELECT ac.*, a.adopter_name, a.period_start, a.period_end,
      po.code AS old_plot_code, pn.code AS new_plot_code, pe.event_date
    FROM area_correspondences ac
    JOIN adoptions a ON a.id=ac.adoption_id
    JOIN plot_versions vo ON vo.id=ac.old_version_id JOIN plots po ON po.id=vo.plot_id
    JOIN plot_versions vn ON vn.id=ac.new_version_id JOIN plots pn ON pn.id=vn.plot_id
    JOIN plot_events pe ON pe.id=ac.event_id
    ${status ? 'WHERE ac.status=?' : ''}
    ORDER BY ac.id`;
  return status ? db.prepare(sql).all(status) : db.prepare(sql).all();
}

// 比较“固定地块份额”与“随边界重分配”两种策略（供前端预览，不落库）
function comparePolicies(plotId) {
  const db = getDb();
  const adops = db.prepare(`SELECT a.*, pv.event AS anchor_event, po.code
    FROM adoptions a JOIN plot_versions pv ON pv.id=a.version_id
    JOIN plots po ON po.id=a.plot_id WHERE a.plot_id=? AND a.status='active'`).all(plotId);
  return adops.map(a => ({
    adoption_id: a.id, adopter: a.adopter_name, area_m2: a.area_m2,
    current_policy: a.share_policy,
    fixed: {
      含义: '旧认养按原边界保留，面积/价格不变；新边界只建立面积对应，差异进入未决清单',
      新边界面积: a.area_m2, 未决差异暴露: true
    },
    redistribute: {
      含义: '按几何交集比例在新边界上自动建立认养，原记录归档为 migrated',
      新边界面积: '按交集比例分摊', 未决差异暴露: false
    }
  }));
}

module.exports = { createAdoption, updateAdoption, listAdoptions, getAdoption,
  resolveCorrespondence, listCorrespondences, comparePolicies, assertNoOverbook, validPeriod };
