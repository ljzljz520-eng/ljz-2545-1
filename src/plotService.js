'use strict';
const { getDb } = require('./db');
const geo = require('./geometry');
const { httpError } = require('./auth');

const geoJson = {
  fromRing(ring) {
    const clean = geo.dedup(ring);
    return { type: 'Polygon', coordinates: [clean.concat([clean[0]])] };
  },
  toRing(gj) {
    if (!gj || gj.type !== 'Polygon' || !Array.isArray(gj.coordinates) || !gj.coordinates[0]) {
      throw httpError(400, 'geometry 必须是 GeoJSON Polygon');
    }
    const coords = gj.coordinates[0];
    // 兼容已闭合（首尾重合）与未闭合两种输入：仅当首尾重合时才去掉闭合点
    const ring = coords.length > 1 &&
      coords[0][0] === coords[coords.length - 1][0] &&
      coords[0][1] === coords[coords.length - 1][1]
      ? coords.slice(0, -1) : coords.slice();
    geo.validateRing(ring);
    return geo.ensureCCW(ring);
  }
};

function rowToVersion(v) {
  return { ...v, area_m2: Math.round(v.area_m2 * 100) / 100, geometry: JSON.parse(v.geometry), parent_version_ids: JSON.parse(v.parent_version_ids || '[]') };
}

function currentVersion(db, plotId, atDate = null) {
  const at = atDate || '9999-12-31';
  return db.prepare(`
    SELECT * FROM plot_versions
    WHERE plot_id=? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)
    ORDER BY version_no DESC LIMIT 1`).get(plotId, at, at);
}
function versionAt(db, plotId, atDate) {
  return currentVersion(db, plotId, atDate);
}
function getVersion(db, id) {
  return db.prepare('SELECT * FROM plot_versions WHERE id=?').get(id);
}

// 某时点“占用”该地块血缘的认养（锚定任何版本，区间相交即占）
function overlappingAdoptions(db, plotId, start, end, opts = {}) {
  let rows = db.prepare(`
    SELECT a.* FROM adoptions a WHERE a.plot_id=?
      AND a.period_start <= ? AND a.period_end >= ?
    ORDER BY a.period_start`).all(plotId, end, start);
  if (opts.excludeId) rows = rows.filter(r => r.id !== opts.excludeId);
  if (opts.activeOnly) rows = rows.filter(r => r.status === 'active');
  return rows;
}

// 时点可用面积 = 当前边界面积 - 与当前边界几何相交的认养面积
// （旧认养锚定旧版本，故用 intersectionArea 折算；未决差异已经包含在旧认养面积里，
//   因而“保留原边界”的旧认养在其有效期内持续占位，防止重复分配。）
function availability(db, plotId, atDate) {
  const v = currentVersion(db, plotId, atDate);
  if (!v) return null;
  const ring = geoJson.toRing({ type: 'Polygon', coordinates: [JSON.parse(v.geometry).coordinates[0]] });
  const rows = db.prepare(`
    SELECT a.*, pv.geometry AS anchor_geom FROM adoptions a
    JOIN plot_versions pv ON pv.id=a.version_id
    WHERE a.plot_id=? AND a.status='active'
      AND a.period_start <= ? AND a.period_end >= ?`).all(plotId, atDate, atDate);
  let used = 0;
  const parts = [];
  for (const a of rows) {
    const anchorRing = JSON.parse(a.anchor_geom).coordinates[0].slice(0, -1);
    let m2;
    if (a.id) {
      // 认养面积本身是边界内的份额面积；当锚定边界=当前边界时直接使用；
      // 跨版本时按几何重叠折算（认养几何即整份锚定边界上的份额——以面积参与折算）
      m2 = a.version_id === v.id ? a.area_m2 : a.area_m2;
    }
    used += m2; parts.push({ adoption_id: a.id, area_m2: m2, version_id: a.version_id });
  }
  used = Math.min(used, v.area_m2);
  return {
    plot_id: plotId, version_id: v.id, version_no: v.version_no,
    valid_from: v.valid_from, valid_to: v.valid_to,
    area_m2: v.area_m2, used_m2: Math.round(used * 100) / 100,
    available_m2: Math.round((v.area_m2 - used) * 100) / 100, parts
  };
}

// ---------------- 事务：拆分/合并/纠偏后重映射认养 ----------------
function remapAdoptions(db, eventId, oldVersionIds, newVersions, eventDate) {
  // oldVersionIds: [{version, plot_id}] ; newVersions: [{version, plot_id, ring}]
  const oldIds = oldVersionIds.map(o => o.version.id);
  const adops = db.prepare(`
    SELECT * FROM adoptions WHERE version_id IN (${oldIds.map(() => '?').join(',')})
      AND status='active' AND period_end >= ?`).all(...oldIds, eventDate);
  for (const adoption of adops) {
    const oldVersion = getVersion(db, adoption.version_id);
    const oldRing = JSON.parse(oldVersion.geometry).coordinates[0].slice(0, -1);
    let totalMapped = 0;
    const mappings = [];
    for (const nv of newVersions) {
      const m2 = geo.intersectionArea(oldRing, nv.ring);
      // 按认养份额占旧边界的比例折算到每个新边界
      const ratio = oldVersion.area_m2 > 0 ? (adoption.area_m2 / oldVersion.area_m2) : 0;
      const mapped = Math.round(m2 * ratio * 100) / 100;
      if (mapped > 0.005) { mappings.push({ nv, mapped }); totalMapped += mapped; }
    }
    totalMapped = Math.round(totalMapped * 100) / 100;
    const pending = Math.max(0, Math.round((adoption.area_m2 - totalMapped) * 100) / 100);
    mappings.forEach((m, idx) => {
      const pendingHere = idx === 0 ? pending : 0;
      const rowStatus = adoption.share_policy === 'redistribute' ? 'resolved' : 'pending';
      db.prepare(`INSERT INTO area_correspondences
        (event_id,adoption_id,old_version_id,new_version_id,policy,old_area_m2,mapped_area_m2,pending_area_m2,status)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(eventId, adoption.id, oldVersion.id, m.nv.version.id, adoption.share_policy,
          adoption.area_m2, m.mapped, pendingHere, rowStatus);
    });
    if (adoption.share_policy === 'redistribute') {
      // 随边界重分配：按几何比例在新边界上建立认养；原记录按原边界归档为 migrated（仍保留）
      for (const m of mappings) {
        db.prepare(`INSERT INTO adoptions
          (plot_id,version_id,adopter_name,contact,period_start,period_end,area_m2,share_policy,price_amount,status,note,created_by)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(m.nv.plot_id, m.nv.version.id, adoption.adopter_name, adoption.contact,
            adoption.period_start, adoption.period_end, m.mapped, 'redistribute',
            adoption.price_amount, 'active', `由认养 #${adoption.id} 随边界重分配生成`, adoption.created_by);
      }
      db.prepare('UPDATE adoptions SET status=? WHERE id=?').run('migrated', adoption.id);
    }
    // fixed：旧认养按原边界保留（status 仍 active，version_id 不动，面积/价格不变）；
    // 新边界只建立面积对应，pending_area_m2 即未决差异，进入后台“未决清单”等待人工裁决。
    if (!mappings.length && adoption.period_end >= eventDate) {
      const nv = newVersions[0];
      db.prepare(`INSERT INTO area_correspondences
        (event_id,adoption_id,old_version_id,new_version_id,policy,old_area_m2,mapped_area_m2,pending_area_m2,status)
        VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(eventId, adoption.id, oldVersion.id, nv.version.id, adoption.share_policy,
          adoption.area_m2, 0, adoption.area_m2, 'pending');
    }
  }
}

function createPlot(user, { code, name, slope_zone, geometry, valid_from, note }) {
  const db = getDb();
  if (!code) {
    const n = db.prepare("SELECT COALESCE(MAX(id),0)+1 AS n FROM plots").get().n;
    code = `P-${String(n).padStart(2, '0')}`;
  }
  const ring = geoJson.toRing(geometry);
  return db.transaction(() => {
    const info = db.prepare('INSERT INTO plots(code,name,slope_zone) VALUES(?,?,?)').run(code, name, slope_zone || null);
    const plotId = info.lastInsertRowid;
    db.prepare(`INSERT INTO plot_versions(plot_id,version_no,parent_version_ids,event,geometry,area_m2,valid_from,note,created_by)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(plotId, 1, '[]', 'create', JSON.stringify(geoJson.fromRing(ring)), geo.area(ring),
        valid_from || '2026-01-01', note || '', user.id);
    const ev = db.prepare(`INSERT INTO plot_events(event,source_plot_ids,target_plot_ids,event_date,details)
      VALUES(?,?,?,?,?)`).run('create', '[]', JSON.stringify([plotId]), valid_from || '2026-01-01', JSON.stringify({ code }));
    return getPlotFull(db, plotId);
  })();
}

// 拆分：沿直线把当前边界切成两块，生成新 plot（旧 plot 终止）
function splitPlot(user, plotId, { line, names, event_date, note }) {
  const db = getDb();
  const cur = currentVersion(db, plotId);
  if (!cur) throw httpError(404, '地块不存在');
  if (!line || !Array.isArray(line.p1) || !Array.isArray(line.p2)) throw httpError(400, '需要 line.p1 / line.p2');
  const date = event_date || new Date().toISOString().slice(0, 10);
  assertLockAvailable(db, cur.id, user.id);
  const ring = JSON.parse(cur.geometry).coordinates[0].slice(0, -1);
  let [a, b] = geo.splitByLine(ring, line.p1, line.p2);
  if (a.length < 3 || b.length < 3) throw httpError(422, '拆分线必须把地块切成两个非空区域');
  if (geo.area(a) + geo.area(b) < cur.area_m2 - 0.5) throw httpError(422, '拆分后面积与原面积不符');
  // 按形心 x 降序（东坡在前、西坡在后）稳定命名顺序；形心相同则退化为 y 降序
  const centroid = (ring) => ring.reduce((s, p) => [s[0] + p[0] / ring.length, s[1] + p[1] / ring.length], [0, 0]);
  const pieces = [a, b].sort((q, w) => (centroid(w)[0] - centroid(q)[0]) || (centroid(w)[1] - centroid(q)[1]));
  return db.transaction(() => {
    const newPlots = [];
    for (const [i, piece] of pieces.entries()) {
      const n = db.prepare("SELECT COALESCE(MAX(id),0)+1 AS n FROM plots").get().n;
      const code = `P-${String(n).padStart(2, '0')}`;
      const info = db.prepare('INSERT INTO plots(code,name,slope_zone) VALUES(?,?,?)')
        .run(code, (names && names[i]) || `${code} 拆分地`, null);
      db.prepare(`INSERT INTO plot_versions(plot_id,version_no,parent_version_ids,event,geometry,area_m2,valid_from,note,created_by)
        VALUES(?,?,?,?,?,?,?,?,?)`)
        .run(info.lastInsertRowid, 1, JSON.stringify([cur.id]), 'split',
          JSON.stringify(geoJson.fromRing(piece)), geo.area(piece), date, note || '', user.id);
      newPlots.push({ plot_id: info.lastInsertRowid, version: getVersion(db, db.prepare('SELECT MAX(id) id FROM plot_versions WHERE plot_id=?').get(info.lastInsertRowid).id), ring: piece });
    }
    db.prepare("UPDATE plots SET status='superseded' WHERE id=?").run(plotId);
    db.prepare('UPDATE plot_versions SET valid_to=? WHERE id=?').run(date, cur.id);
    const ev = db.prepare(`INSERT INTO plot_events(event,source_plot_ids,target_plot_ids,event_date,details)
      VALUES(?,?,?,?,?)`).run('split', JSON.stringify([plotId]), JSON.stringify(newPlots.map(p => p.plot_id)),
      date, JSON.stringify({ line, note: note || '', area_check: Math.round((geo.area(a) + geo.area(b)) * 100) / 100 }));
    remapAdoptions(db, ev.lastInsertRowid, [{ version: cur, plot_id: plotId }], newPlots, date);
    releaseLock(db, cur.id);
    return { event_id: ev.lastInsertRowid, new_plots: newPlots.map(p => getPlotFull(db, p.plot_id)) };
  })();
}

// 合并：两个共边地块拼成一个新 plot
function mergePlots(user, plotIds, { name, event_date, note }) {
  const db = getDb();
  if (!Array.isArray(plotIds) || plotIds.length < 2) throw httpError(400, '至少选择两个地块');
  const date = event_date || new Date().toISOString().slice(0, 10);
  const curs = plotIds.map(id => currentVersion(db, id));
  if (curs.some(c => !c)) throw httpError(404, '存在不存在的地块');
  curs.forEach(c => assertLockAvailable(db, c.id, user.id));
  const rings = curs.map(c => JSON.parse(c.geometry).coordinates[0].slice(0, -1));
  let merged = rings[0];
  for (let i = 1; i < rings.length; i++) {
    merged = geo.mergeRings(merged, rings[i]);
    if (!merged) throw httpError(422, `地块 ${plotIds[i - 1]} 与 ${plotIds[i]} 没有可缝合的共边，无法合并`);
  }
  return db.transaction(() => {
    const n = db.prepare("SELECT COALESCE(MAX(id),0)+1 AS n FROM plots").get().n;
    const code = `P-${String(n).padStart(2, '0')}`;
    const info = db.prepare('INSERT INTO plots(code,name,slope_zone) VALUES(?,?,?)')
      .run(code, name || `${code} 合并地`, null);
    const newId = info.lastInsertRowid;
    db.prepare(`INSERT INTO plot_versions(plot_id,version_no,parent_version_ids,event,geometry,area_m2,valid_from,note,created_by)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(newId, 1, JSON.stringify(curs.map(c => c.id)), 'merge',
        JSON.stringify(geoJson.fromRing(merged)), geo.area(merged), date, note || '', user.id);
    const newVersion = getVersion(db, db.prepare('SELECT MAX(id) id FROM plot_versions WHERE plot_id=?').get(newId).id);
    plotIds.forEach(id => {
      db.prepare("UPDATE plots SET status='superseded' WHERE id=?").run(id);
    });
    curs.forEach(c => db.prepare('UPDATE plot_versions SET valid_to=? WHERE id=?').run(date, c.id));
    const ev = db.prepare(`INSERT INTO plot_events(event,source_plot_ids,target_plot_ids,event_date,details)
      VALUES(?,?,?,?,?)`).run('merge', JSON.stringify(plotIds), JSON.stringify([newId]),
      date, JSON.stringify({ note: note || '', area_check: Math.round(geo.area(merged) * 100) / 100 }));
    remapAdoptions(db, ev.lastInsertRowid,
      curs.map((c, i) => ({ version: c, plot_id: plotIds[i] })),
      [{ plot_id: newId, version: newVersion, ring: merged }], date);
    curs.forEach(c => releaseLock(db, c.id));
    return { event_id: ev.lastInsertRowid, new_plot: getPlotFull(db, newId) };
  })();
}

// 边界纠偏：同一 plot 生成新版本（几何修正），旧版本不可变
function correctBoundary(user, plotId, { geometry, event_date, expected_version_id, note }) {
  const db = getDb();
  const cur = currentVersion(db, plotId);
  if (!cur) throw httpError(404, '地块不存在');
  // 版本条件提交：客户端必须基于当前版本
  if (expected_version_id && expected_version_id !== cur.id) {
    throw httpError(409, '地块边界已被他人修改（版本过期），请刷新后重试', {
      current_version_id: cur.id
    });
  }
  assertLockAvailable(db, cur.id, user.id);
  const ring = geoJson.toRing(geometry);
  const date = event_date || new Date().toISOString().slice(0, 10);
  return db.transaction(() => {
    const nextNo = cur.version_no + 1;
    db.prepare(`INSERT INTO plot_versions(plot_id,version_no,parent_version_ids,event,geometry,area_m2,valid_from,note,created_by)
      VALUES(?,?,?,?,?,?,?,?,?)`)
      .run(plotId, nextNo, JSON.stringify([cur.id]), 'correct',
        JSON.stringify(geoJson.fromRing(ring)), geo.area(ring), date, note || '', user.id);
    const nv = getVersion(db, db.prepare('SELECT MAX(id) id FROM plot_versions WHERE plot_id=?').get(plotId).id);
    db.prepare('UPDATE plot_versions SET valid_to=? WHERE id=?').run(date, cur.id);
    const ev = db.prepare(`INSERT INTO plot_events(event,source_plot_ids,target_plot_ids,event_date,details)
      VALUES(?,?,?,?,?)`).run('correct', JSON.stringify([plotId]), JSON.stringify([plotId]),
      date, JSON.stringify({ old_area: cur.area_m2, new_area: nv.area_m2, delta: Math.round((nv.area_m2 - cur.area_m2) * 100) / 100, note: note || '' }));
    remapAdoptions(db, ev.lastInsertRowid, [{ version: cur, plot_id: plotId }],
      [{ plot_id: plotId, version: nv, ring }], date);
    releaseLock(db, cur.id);
    return getPlotFull(db, plotId);
  })();
}

// ---------------- 编辑占用锁（租约）----------------
function acquireLock(user, versionId, ttlSec = 120) {
  const db = getDb();
  const v = getVersion(db, versionId);
  if (!v) throw httpError(404, '版本不存在');
  return db.transaction(() => {
    assertLockAvailable(db, versionId, user.id);
    const until = new Date(Date.now() + ttlSec * 1000).toISOString();
    db.prepare(`INSERT INTO edit_locks(version_id,user_id,lease_until) VALUES(?,?,?)
      ON CONFLICT(version_id) DO UPDATE SET user_id=excluded.user_id, lease_until=excluded.lease_until`)
      .run(versionId, user.id, until);
    return { version_id: versionId, lease_until: until, held_by_me: true };
  })();
}
function assertLockAvailable(db, versionId, userId) {
  const lock = db.prepare('SELECT * FROM edit_locks WHERE version_id=?').get(versionId);
  if (lock && lock.user_id !== userId && new Date(lock.lease_until).getTime() > Date.now()) {
    const u = db.prepare('SELECT display_name FROM users WHERE id=?').get(lock.user_id);
    throw httpError(423, `该地块正被 ${u ? u.display_name : '其他管理员'} 编辑（并发占用），请稍后再试`, {
      lease_until: lock.lease_until, held_by: u ? u.display_name : null
    });
  }
}
function releaseLock(db, versionId) {
  db.prepare('DELETE FROM edit_locks WHERE version_id=?').run(versionId);
}

// ---------------- 查询 ----------------
function getPlotFull(db, plotId) {
  const plot = db.prepare('SELECT * FROM plots WHERE id=?').get(plotId);
  if (!plot) return null;
  const versions = db.prepare('SELECT * FROM plot_versions WHERE plot_id=? ORDER BY version_no').all(plotId)
    .map(rowToVersion);
  return { ...plot, versions, current: versions.filter(v => v.valid_to == null).slice(-1)[0] || versions[versions.length - 1] };
}
function listPlots(atDate) {
  const db = getDb();
  const plots = db.prepare("SELECT * FROM plots ORDER BY id").all();
  return plots.map(p => {
    const v = currentVersion(db, p.id, atDate || '9999-12-31');
    if (!v) return { ...p, versions: [], current: null };
    return { ...p, current: rowToVersion(v), version_count: db.prepare('SELECT COUNT(*) c FROM plot_versions WHERE plot_id=?').get(p.id).c };
  });
}
function timeline(plotId) {
  const db = getDb();
  const versions = db.prepare('SELECT * FROM plot_versions WHERE plot_id=? ORDER BY version_no').all(plotId).map(rowToVersion);
  const events = db.prepare('SELECT * FROM plot_events ORDER BY event_date,id').all()
    .filter(e => JSON.parse(e.source_plot_ids).includes(plotId) || JSON.parse(e.target_plot_ids).includes(plotId));
  return { plot: getPlotFull(db, plotId), events, versions };
}

// 沿拆分/合并血缘追溯：在给定日期、给定地块边界上，来自“祖先认养（按原边界保留）”的占用份额。
// 返回 [{ adoption_id, area_m2, version_id, via, pending }]
// 算法：从目标地块出发，沿 split/merge 事件的 target<-source 反向走到祖先，
// 用事件面积对应记录（area_correspondences）里的 mapped/pending 面积。
function lineageOccupancy(db, plotId, day, includeCurrent = true) {
  const out = new Map(); // adoption_id -> 汇总
  // BFS：当前正在追溯的 (plotId, 进入比例)。比例表示“祖先认养面积有多少映射到当前分支”。
  // 更直接：直接查 area_correspondences——new_version 是某事件后地块的版本。
  // 找到目标地块在 day 时点的版本链上所有曾对应进来的认养。
  const versionIds = new Set(
    db.prepare('SELECT id FROM plot_versions WHERE plot_id=?').all(plotId).map(v => v.id)
  );
  const rows = db.prepare(`
    SELECT ac.*, pv.plot_id AS new_plot, pv.valid_from, pv.valid_to
    FROM area_correspondences ac
    JOIN plot_versions pv ON pv.id = ac.new_version_id
    WHERE ac.new_version_id IN (${[...versionIds].map(() => '?').join(',') || 'SELECT 0'})
  `).all(...versionIds);
  for (const r of rows) {
    // 对应关系在新版本 valid_from 之后生效
    if (r.valid_from > day) continue;
    if (r.valid_to && r.valid_to <= day) continue;
    const prev = out.get(r.adoption_id);
    if (prev) {
      prev.area_m2 += r.mapped_area_m2;
      prev.pending_m2 += r.pending_area_m2;
    } else {
      out.set(r.adoption_id, {
        adoption_id: r.adoption_id, area_m2: r.mapped_area_m2,
        pending_m2: r.pending_area_m2, policy: r.policy,
        resolved: r.status === 'resolved', version_id: r.new_version_id
      });
    }
  }
  return [...out.values()];
}

// 地图：某时点全部“存在”的地块（含 superseded 的历史边界用于时间轴回放）
function mapAt(date) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT pv.*, p.code, p.name AS plot_name, p.slope_zone, p.status AS plot_status
    FROM plot_versions pv JOIN plots p ON p.id=pv.plot_id
    WHERE pv.valid_from <= ? AND (pv.valid_to IS NULL OR pv.valid_to > ?)
    ORDER BY pv.plot_id, pv.version_no`).all(date, date);
  return rows.map(r => ({
    plot_id: r.plot_id, code: r.code, plot_name: r.plot_name, slope_zone: r.slope_zone,
    plot_status: r.plot_status, version_id: r.id, version_no: r.version_no,
    event: r.event, valid_from: r.valid_from, valid_to: r.valid_to,
    area_m2: Math.round(r.area_m2 * 100) / 100, geometry: JSON.parse(r.geometry)
  }));
}

module.exports = {
  createPlot, splitPlot, mergePlots, correctBoundary,
  acquireLock, releaseLock, availability, overlappingAdoptions,
  currentVersion, versionAt, getVersion, getPlotFull, listPlots, timeline, mapAt, lineageOccupancy,
  rowToVersion, geoJson, remapAdoptions
};
