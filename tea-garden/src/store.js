'use strict';
// 领域层：所有写操作在 better-sqlite3 同步事务内完成；
// 事务提交前统一校验「同一时期认养面积不得超过地块版本面积」。
const crypto = require('crypto');
const geo = require('./geo');

class ApiError extends Error {
  constructor(status, code, message, details = {}) {
    super(message);
    this.status = status; this.code = code; this.details = details;
  }
}
const PENDING_TOL = 0.5; // 平方米，小于该差异视为几何误差直接落实
const round2 = x => Math.round(x * 100) / 100;

// 事务包装：function(db, ...) -> 自动事务
const txn = fn => (db, ...args) => db.transaction(() => fn(db, ...args))();

// ---------- 查询辅助 ----------
function versionAt(db, parcelId, date) {
  return db.prepare(`
    SELECT pv.* FROM parcel_versions pv
    WHERE pv.parcel_id=? AND pv.valid_from <= ?
      AND (pv.valid_to IS NULL OR pv.valid_to > ?)
    ORDER BY pv.version DESC LIMIT 1`).get(parcelId, date, date);
}
function currentVersion(db, parcelId) {
  const v = db.prepare(`SELECT * FROM parcel_versions WHERE parcel_id=? AND valid_to IS NULL
    ORDER BY version DESC LIMIT 1`).get(parcelId);
  if (!v) throw new ApiError(404, 'NO_VERSION', `地块 ${parcelId} 不存在当前版本`);
  return v;
}
function getParcel(db, id) {
  const p = db.prepare('SELECT * FROM parcels WHERE id=?').get(id);
  if (!p) throw new ApiError(404, 'NOT_FOUND', '地块不存在');
  return p;
}
// 当前仍生效（存在 valid_to IS NULL 版本）的地块中编码是否被占用
function activeCodeTaken(db, code, excludeId = null) {
  const row = db.prepare(`
    SELECT p.id FROM parcels p
    JOIN parcel_versions pv ON pv.parcel_id=p.id AND pv.valid_to IS NULL
    WHERE p.code=? AND (? IS NULL OR p.id<>?) LIMIT 1`).get(code, excludeId, excludeId);
  return !!row;
}
function expectVersion(row, expectedVersion) {
  if (expectedVersion != null && +expectedVersion !== row.version) {
    throw new ApiError(409, 'STALE_VERSION',
      `版本条件提交失败：该地块已被其他人修改（当前 v${row.version}，你基于 v${expectedVersion} 提交）`,
      { currentVersion: row.version, submittedBase: +expectedVersion });
  }
}

// 认养占用：某版本上每条 confirmed 分配在其认养区间内的面积，扫掠求任意一天的最大占用
function capacityReport(db, versionId) {
  const v = db.prepare('SELECT area, version FROM parcel_versions WHERE id=?').get(versionId);
  const rows = db.prepare(`
    SELECT a.id AS aid, a.label, a.start_date, a.end_date, al.area
    FROM allocations al JOIN adoptions a ON a.id=al.adoption_id
    WHERE al.parcel_version_id=? AND al.state='confirmed' AND a.status='active'
  `).all(versionId);
  const dates = [...new Set(rows.flatMap(r => [r.start_date, r.end_date].filter(Boolean)))].sort();
  let worst = { used: 0, date: null, by: [] };
  const snap = date => {
    const by = []; let sum = 0;
    for (const r of rows) {
      if (r.start_date <= date && (!r.end_date || r.end_date > date)) { sum += r.area; by.push({ adoptionId: r.aid, label: r.label, area: r.area }); }
    }
    if (sum > worst.used) worst = { used: round2(sum), date, by };
  };
  dates.forEach(snap);
  if (!worst.date && rows.length) snap(rows[0].start_date);
  return { versionId, version: v.version, area: v.area, over: round2(worst.used - v.area), ...worst };
}
function assertCapacity(db, versionId) {
  const rep = capacityReport(db, versionId);
  if (rep.used > rep.area + 1e-6) {
    throw new ApiError(409, 'AREA_CONFLICT',
      `并发占用冲突：地块版本 v${rep.version} 在 ${rep.date} 认养面积 ${rep.used}㎡ 超过面积 ${rep.area}㎡`, rep);
  }
  return rep;
}

// ---------- 写辅助 ----------
function insertVersion(db, parcelId, geometry, validFrom, note, userId) {
  const pts = geo.parse(geometry);
  const last = db.prepare('SELECT MAX(version) m FROM parcel_versions WHERE parcel_id=?').get(parcelId).m || 0;
  const p = db.prepare('SELECT code,name FROM parcels WHERE id=?').get(parcelId);
  const info = db.prepare(`INSERT INTO parcel_versions
    (parcel_id,version,code_snapshot,name_snapshot,geometry,area,valid_from,change_note,created_by)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(parcelId, last + 1, p.code, p.name, JSON.stringify(geo.geojson(pts)), round2(geo.area(pts)), validFrom, note, userId);
  return db.prepare('SELECT * FROM parcel_versions WHERE id=?').get(info.lastInsertRowid);
}
function addAllocation(db, adoptionId, versionId, area, state, note) {
  if (area <= 0.005) return null;
  return db.prepare('INSERT INTO allocations(adoption_id,parcel_version_id,area,state,note) VALUES(?,?,?,?,?)')
    .run(adoptionId, versionId, round2(area), state, note).lastInsertRowid;
}

function createParcel(db, { code, name, geometry, validFrom, note = '', userId = null, slopeAngle = null }) {
  if (activeCodeTaken(db, code)) throw new ApiError(409, 'CODE_TAKEN', `编码 ${code} 已被生效地块占用`);
  const pts = geo.parse(geometry);
  const ar = geo.area(pts);
  const pid = db.prepare('INSERT INTO parcels(code,name,slope_angle) VALUES(?,?,?)').run(code, name, slopeAngle).lastInsertRowid;
  const v = db.prepare(`INSERT INTO parcel_versions
    (parcel_id,version,code_snapshot,name_snapshot,geometry,area,valid_from,change_note,created_by)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(pid, 1, code, name, JSON.stringify(geo.geojson(pts)), round2(ar), validFrom, note || '初始边界', userId);
  db.prepare('INSERT INTO version_lineage(op,from_version_id,to_version_id) VALUES(?,?,?)').run('create', null, v.lastInsertRowid);
  return { parcelId: pid, versionId: v.lastInsertRowid, area: round2(ar) };
}

// 旧版本认养 -> 新版本集合的面积对应
function remapAdoptions(db, oldVersions, newVersions, date) {
  const result = [];
  for (const oldV of oldVersions) {
    const ads = db.prepare(`
      SELECT a.* FROM adoptions a JOIN allocations al ON al.adoption_id=a.id
      WHERE al.parcel_version_id=? AND al.state='confirmed' AND a.status='active'
        AND a.start_date < ? AND (a.end_date IS NULL OR a.end_date > ?)`).all(oldV.id, date, date);
    for (const a of ads) {
      const f = a.area / oldV.area; // 原认养占旧地块份额
      const parts = newVersions.map(nv => ({ nv, inter: geo.intersectionArea(oldV.geometry, nv.geometry) }))
        .filter(p => p.inter > 1e-6).sort((x, y) => y.inter - x.inter);
      if (!parts.length) {
        if (a.mode === 'fixed') addAllocation(db, a.id, newVersions[0].id, a.area, 'pending',
          `边界于 ${date} 整体迁移，原 ${a.area}㎡ 无对应地块，待人工处理`);
        result.push({ adoptionId: a.id, label: a.label, mode: a.mode, remapped: 0, pending: a.mode === 'fixed' ? a.area : 0 });
        continue;
      }
      let confirmedSum = 0;
      for (const p of parts) {
        const c = f * p.inter; // 按新旧几何交集落实面积
        addAllocation(db, a.id, p.nv.id, c, 'confirmed', `${date} 边界演化自 v${oldV.version} 按交集重映射`);
        confirmedSum += c;
      }
      let pending = 0;
      if (a.mode === 'fixed' && (pending = a.area - confirmedSum) > PENDING_TOL) {
        addAllocation(db, a.id, parts[0].nv.id, pending, 'pending',
          `固定份额 ${a.area}㎡，新边界仅对应 ${round2(confirmedSum)}㎡，差异待决`);
      }
      // boundary 模式：确认面积随边界，差异不挂账（权利随地面移动）
      result.push({ adoptionId: a.id, label: a.label, mode: a.mode, remapped: round2(confirmedSum), pending: round2(pending) });
    }
  }
  return result;
}

// 边界演化：条件校验 -> 关闭旧版本 -> 建新版本 -> 谱系 -> 面积对应 -> 占用校验
function evolve(db, { oldSpecs, buildNew, op, userId, date, note }) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new ApiError(400, 'BAD_DATE', '日期格式应为 YYYY-MM-DD');
  const olds = oldSpecs.map(s => {
    const parcel = getParcel(db, s.parcelId);
    const v = versionAt(db, s.parcelId, date) || currentVersion(db, s.parcelId);
    if (v.valid_to && v.valid_to <= date) throw new ApiError(409, 'NO_ACTIVE_VERSION', `地块 ${parcel.code} 在 ${date} 没有可演化的当前版本`);
    expectVersion(v, s.expectedVersion);
    v.parsedGeometry = JSON.parse(v.geometry);
    return { parcel, version: v };
  });
  const specs = buildNew(olds);
  if (!specs.length) throw new ApiError(400, 'EMPTY_RESULT', '演化未产生新版本');
  const created = specs.map(s => insertVersion(db, s.parcelId, s.geometry, date, s.note || note || '', userId));
  olds.forEach(o => db.prepare('UPDATE parcel_versions SET valid_to=? WHERE id=? AND valid_to IS NULL').run(date, o.version.id));
  olds.forEach(o => created.forEach(nv => {
    const w = geo.intersectionArea(o.version.parsedGeometry, nv.geometry) / o.version.area;
    db.prepare('INSERT INTO version_lineage(op,from_version_id,to_version_id,weight) VALUES(?,?,?,?)')
      .run(op, o.version.id, nv.id, round2(w));
  }));
  const remap = remapAdoptions(db, olds.map(o => o.version), created, date);
  created.forEach(nv => assertCapacity(db, nv.id));
  return {
    date,
    newVersions: created.map(v => ({ id: v.id, parcelId: v.parcel_id, version: v.version, code: v.code_snapshot, area: v.area })),
    remap,
  };
}

// ---------- 纠偏（同地块换边界） ----------
const correctBoundary = txn((db, { parcelId, expectedVersion, geometry, validFrom, note, userId }) => {
  const p = getParcel(db, parcelId);
  expectVersion(currentVersion(db, parcelId), expectedVersion);
  const pts = geo.parse(geometry);
  const cur = currentVersion(db, parcelId);
  if (geo.intersectionArea(cur.geometry, JSON.stringify(geo.geojson(pts))) <= 1e-6) {
    throw new ApiError(400, 'DISJOINT_GEOMETRY', '纠偏后边界与原边界完全不相交，拒绝替换（请新建地块）');
  }
  const res = evolve(db, {
    oldSpecs: [{ parcelId, expectedVersion }],
    buildNew: () => [{ parcelId, geometry: geo.geojson(pts), note: note || '边界纠偏' }],
    op: 'correct', userId, date: validFrom, note: note || '边界纠偏',
  });
  res.parcelId = parcelId; res.code = p.code;
  return res;
});

// ---------- 拆分（父=延续片 v+1，第二片=新地块 v1） ----------
const splitParcel = txn((db, { parcelId, expectedVersion, cut, children, validFrom, note, userId }) => {
  const p = getParcel(db, parcelId);
  const cur = currentVersion(db, parcelId);
  expectVersion(cur, expectedVersion);
  if (!Array.isArray(children) || children.length !== 2) throw new ApiError(400, 'BAD_CHILDREN', '拆分必须给出两个子地块 code/name');
  if (children[0].code === children[1].code) throw new ApiError(400, 'BAD_CHILDREN', '两个子地块编码不能相同');
  if (activeCodeTaken(db, children[0].code, parcelId) || activeCodeTaken(db, children[1].code, parcelId)) {
    throw new ApiError(409, 'CODE_TAKEN', `编码 ${children[0].code} / ${children[1].code} 已被其他生效地块占用`);
  }
  const [g1, g2] = geo.splitByLine(cur.geometry, { x: +cut.p1.x, y: +cut.p1.y }, { x: +cut.p2.x, y: +cut.p2.y });
  db.prepare('UPDATE parcels SET code=?, name=?, slope_angle=? WHERE id=?')
    .run(children[0].code, children[0].name, children[0].slopeAngle ?? null, parcelId);
  const newParcelId = db.prepare('INSERT INTO parcels(code,name,slope_angle) VALUES(?,?,?)')
    .run(children[1].code, children[1].name, children[1].slopeAngle ?? null).lastInsertRowid;
  const res = evolve(db, {
    oldSpecs: [{ parcelId, expectedVersion }],
    buildNew: () => ([
      { parcelId, geometry: g1, note: `由 ${p.code} v${cur.version} 拆分（延续片）` },
      { parcelId: newParcelId, geometry: g2, note: `由 ${p.code} v${cur.version} 拆分（新建片）` },
    ]),
    op: 'split', userId, date: validFrom, note: note || `拆分 ${p.code}`,
  });
  res.parentParcelId = parcelId; res.newParcelId = newParcelId;
  return res;
});

// ---------- 合并（首个=延续片，其余同日关闭） ----------
const mergeParcels = txn((db, { items, code, name, validFrom, note, userId }) => {
  if (!Array.isArray(items) || items.length < 2) throw new ApiError(400, 'BAD_ITEMS', '合并至少选择两个地块');
  if (activeCodeTaken(db, code, items[0].parcelId)) {
    throw new ApiError(409, 'CODE_TAKEN', `编码 ${code} 已被其他生效地块占用`);
  }
  const keepId = items[0].parcelId;
  const olds = items.map(it => {
    const parcel = getParcel(db, it.parcelId);
    const cur = currentVersion(db, it.parcelId);
    expectVersion(cur, it.expectedVersion);
    return { parcel, cur, geom: JSON.parse(cur.geometry) };
  });
  let merged = olds[0].geom;
  for (let i = 1; i < olds.length; i++) merged = geo.mergeConvex(merged, olds[i].geom);
  db.prepare('UPDATE parcels SET code=?, name=? WHERE id=?').run(code, name, keepId);
  const res = evolve(db, {
    oldSpecs: items.map(it => ({ parcelId: it.parcelId, expectedVersion: it.expectedVersion })),
    buildNew: () => [{ parcelId: keepId, geometry: merged, note: `由 ${olds.map(o => o.parcel.code).join('+')} 合并（延续片）` }],
    op: 'merge', userId, date: validFrom, note: note || `合并为 ${code}`,
  });
  res.keptParcelId = keepId;
  res.closedParcelIds = items.slice(1).map(it => it.parcelId);
  return res;
});

// ---------- 认养 ----------
const createAdoption = txn((db, { parcelId, expectedVersion, label, mode, area, startDate, endDate, gift = 0, priceCents = null, contact = null }) => {
  if (!label || !label.trim()) throw new ApiError(400, 'BAD_INPUT', '认养署名不能为空');
  if (!['fixed', 'boundary'].includes(mode)) throw new ApiError(400, 'BAD_MODE', 'mode 必须是 fixed 或 boundary');
  if (!(area > 0)) throw new ApiError(400, 'BAD_AREA', '认养面积必须大于 0');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate)) throw new ApiError(400, 'BAD_DATE', '开始日期格式错误');
  if (endDate && (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate <= startDate)) {
    throw new ApiError(400, 'BAD_DATE', '结束日期必须晚于开始日期');
  }
  const v = currentVersion(db, parcelId);
  expectVersion(v, expectedVersion);
  if (startDate < v.valid_from) throw new ApiError(400, 'BAD_DATE', `认养开始不得早于当前边界版本生效日 ${v.valid_from}`);
  const id = db.prepare(`INSERT INTO adoptions
    (label,mode,area,start_date,end_date,gift,price_cents,contact,created_version_id)
    VALUES(?,?,?,?,?,?,?,?,?)`)
    .run(label.trim(), mode, round2(area), startDate, endDate || null, gift ? 1 : 0, priceCents, contact, v.id).lastInsertRowid;
  addAllocation(db, id, v.id, area, 'confirmed', '初始认养');
  let cap;
  try { cap = assertCapacity(db, v.id); }
  catch (e) { if (e.code === 'AREA_CONFLICT') e.details.adoptionId = id; throw e; }
  return { adoptionId: id, versionId: v.id, version: v.version, capacity: cap };
});

const terminateAdoption = txn((db, { adoptionId, endDate }) => {
  const a = db.prepare('SELECT * FROM adoptions WHERE id=?').get(adoptionId);
  if (!a) throw new ApiError(404, 'NOT_FOUND', '认养记录不存在');
  if (a.status !== 'active') throw new ApiError(409, 'ALREADY_TERMINATED', '认养已终止');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(endDate) || endDate <= a.start_date) throw new ApiError(400, 'BAD_DATE', '终止日期必须晚于开始日期');
  db.prepare("UPDATE adoptions SET end_date=?, status='terminated' WHERE id=?").run(endDate, adoptionId);
  return { adoptionId, endDate };
});

// 未决差异人工处理
const resolveAllocation = txn((db, { allocationId, action, note }) => {
  const al = db.prepare('SELECT * FROM allocations WHERE id=?').get(allocationId);
  if (!al) throw new ApiError(404, 'NOT_FOUND', '分配不存在');
  if (al.state !== 'pending') throw new ApiError(409, 'NOT_PENDING', '该分配不是未决状态');
  if (action === 'dismiss') {
    db.prepare("UPDATE allocations SET state='confirmed', area=0, note=? WHERE id=?")
      .run(`${al.note}；差异 ${al.area}㎡ 经核销放弃（${note || '无备注'}）`, allocationId);
  } else if (action === 'confirm') {
    db.prepare("UPDATE allocations SET state='confirmed', note=? WHERE id=?")
      .run(`${al.note}；差异已人工确认落实（${note || ''}）`, allocationId);
    assertCapacity(db, al.parcel_version_id);
  } else throw new ApiError(400, 'BAD_ACTION', 'action 必须是 confirm 或 dismiss');
  return { allocationId, action };
});

// ---------- 日记（含离线幂等） ----------
const upsertDiary = txn((db, { parcelId, farmerId, entryDate, weather = '', body, clientId = null }) => {
  if (!body || !body.trim()) throw new ApiError(400, 'BAD_INPUT', '日记内容不能为空');
  if (clientId) {
    const dup = db.prepare('SELECT * FROM diaries WHERE client_id=?').get(clientId);
    if (dup) return { ...dup, deduplicated: true };
  }
  getParcel(db, parcelId);
  if (!db.prepare('SELECT 1 FROM farmers WHERE id=?').get(farmerId)) throw new ApiError(404, 'NOT_FOUND', '农户不存在');
  const id = db.prepare('INSERT INTO diaries(parcel_id,farmer_id,entry_date,weather,body,client_id) VALUES(?,?,?,?,?,?)')
    .run(parcelId, farmerId, entryDate, weather, body.trim(), clientId).lastInsertRowid;
  return db.prepare('SELECT * FROM diaries WHERE id=?').get(id);
});

// ---------- 采摘批次与检测 ----------
const createBatch = txn((db, { parcelId, code, pickedOn, scopeNote, leafKind, yieldKg }) => {
  const p = getParcel(db, parcelId);
  const v = versionAt(db, parcelId, pickedOn) || currentVersion(db, parcelId);
  if (db.prepare('SELECT 1 FROM batches WHERE code=?').get(code)) throw new ApiError(409, 'CODE_TAKEN', `批次号 ${code} 已存在`);
  const id = db.prepare(`INSERT INTO batches(code,parcel_id,parcel_version_id,picked_on,scope_note,leaf_kind,yield_kg)
    VALUES(?,?,?,?,?,?,?)`).run(code, parcelId, v.id, pickedOn, scopeNote || '', leafKind || null, yieldKg ?? null).lastInsertRowid;
  return { batchId: id, parcelCode: v.code_snapshot, versionId: v.id, version: v.version, pickedOn };
});
const addLabReport = txn((db, { batchId, title, labName, issuedOn, summary, attachmentId = null }) => {
  if (!db.prepare('SELECT 1 FROM batches WHERE id=?').get(batchId)) throw new ApiError(404, 'NOT_FOUND', '批次不存在');
  const id = db.prepare(`INSERT INTO lab_reports(batch_id,title,lab_name,issued_on,summary,attachment_id)
    VALUES(?,?,?,?,?,?)`).run(batchId, title, labName || '', issuedOn, summary, attachmentId).lastInsertRowid;
  return { reportId: id };
});
// 撤回：报告软撤回 + 对象层归档（文件不物理删除）
const withdrawReport = txn((db, { reportId, reason }) => {
  const r = db.prepare('SELECT * FROM lab_reports WHERE id=?').get(reportId);
  if (!r) throw new ApiError(404, 'NOT_FOUND', '检测报告不存在');
  if (r.withdrawn) throw new ApiError(409, 'ALREADY_WITHDRAWN', '报告已撤回');
  const now = new Date().toISOString();
  db.prepare('UPDATE lab_reports SET withdrawn=1,withdrawn_reason=?,withdrawn_at=datetime(?) WHERE id=?')
    .run(reason || '', now, reportId);
  if (r.attachment_id) {
    db.prepare("UPDATE attachments SET status='archived',archived_reason=?,archived_at=datetime(?) WHERE id=?")
      .run(`检测报告 #${reportId} 撤回：${reason || ''}`, now, r.attachment_id);
  }
  return { reportId, withdrawn: true };
});

// ---------- 附件（对象层） ----------
const registerAttachment = txn((db, { objectKey, originalName, mimeType, sizeBytes, sha256 }) => {
  const id = db.prepare(`INSERT INTO attachments(object_key,original_name,mime_type,size_bytes,sha256)
    VALUES(?,?,?,?,?)`).run(objectKey, originalName, mimeType, sizeBytes, sha256).lastInsertRowid;
  return db.prepare('SELECT * FROM attachments WHERE id=?').get(id);
});

// ---------- 送礼分享（独立权限） ----------
const issueShare = txn((db, { adoptionId, scope, expiresAt, userId = null }) => {
  if (!db.prepare('SELECT 1 FROM adoptions WHERE id=?').get(adoptionId)) throw new ApiError(404, 'NOT_FOUND', '认养记录不存在');
  if (!['gift', 'admin'].includes(scope)) throw new ApiError(400, 'BAD_SCOPE', 'scope 必须是 gift 或 admin');
  if (expiresAt && !/^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2})?/.test(expiresAt)) throw new ApiError(400, 'BAD_DATE', '过期时间格式错误');
  const token = crypto.randomBytes(18).toString('base64url');
  db.prepare('INSERT INTO gift_shares(token,adoption_id,issued_by,scope,expires_at) VALUES(?,?,?,?,?)')
    .run(token, adoptionId, userId, scope, expiresAt || null);
  return { token, scope, expiresAt: expiresAt || null };
});
const revokeShare = txn((db, token) => {
  const info = db.prepare('UPDATE gift_shares SET revoked=1 WHERE token=?').run(token);
  if (!info.changes) throw new ApiError(404, 'NOT_FOUND', '分享链接不存在');
  return { token, revoked: true };
});
// 服务端按令牌范围返回：gift 范围绝不包含价格/联系方式（不靠 CSS 隐藏）
function viewByToken(db, token, now = new Date()) {
  const s = db.prepare('SELECT * FROM gift_shares WHERE token=?').get(token);
  if (!s || s.revoked) return { status: 404, reason: '链接不存在或已撤销' };
  if (s.expires_at) {
    const exp = s.expires_at.length === 10 ? new Date(s.expires_at + 'T23:59:59') : new Date(s.expires_at);
    if (exp < now) return { status: 410, reason: '分享链接已过期', expiredAt: s.expires_at };
  }
  const a = db.prepare('SELECT * FROM adoptions WHERE id=?').get(s.adoption_id);
  const pvRow = db.prepare('SELECT code_snapshot,name_snapshot FROM parcel_versions WHERE id=?').get(a.created_version_id);
  const out = {
    status: 200, scope: s.scope, expiresAt: s.expires_at || null,
    adoption: {
      label: a.label, mode: a.mode, area: a.area, gift: !!a.gift,
      startDate: a.start_date, endDate: a.end_date,
      parcelCode: pvRow.code_snapshot, parcelName: pvRow.name_snapshot,
      period: `${a.start_date} ~ ${a.end_date || '长期'}`,
    },
  };
  if (s.scope === 'admin') {
    Object.assign(out.adoption, { adoptionId: a.id, priceCents: a.price_cents, contact: a.contact });
  }
  return out;
}

// ---------- 读模型 ----------
function mapAt(db, date) {
  const vs = db.prepare(`
    SELECT pv.*, p.slope_angle FROM parcel_versions pv JOIN parcels p ON p.id=pv.parcel_id
    WHERE pv.valid_from <= ? AND (pv.valid_to IS NULL OR pv.valid_to > ?)
    ORDER BY pv.code_snapshot`).all(date, date);
  return vs.map(v => {
    const cap = capacityReport(db, v.id);
    const ads = db.prepare(`
      SELECT a.id,a.label,a.mode,a.start_date,a.end_date,al.state,al.area AS alloc_area,al.note AS alloc_note
      FROM allocations al JOIN adoptions a ON a.id=al.adoption_id
      WHERE al.parcel_version_id=? AND a.start_date <= ? AND (a.end_date IS NULL OR a.end_date > ?)
      ORDER BY a.id, al.state`).all(v.id, date, date);
    return {
      parcelId: v.parcel_id, code: v.code_snapshot, name: v.name_snapshot, slopeAngle: v.slope_angle,
      version: v.version, versionId: v.id, validFrom: v.valid_from, validTo: v.valid_to,
      geometry: JSON.parse(v.geometry), area: v.area, used: cap.used, free: round2(v.area - cap.used),
      adoptions: ads.map(a => ({ id: a.id, label: a.label, mode: a.mode, area: a.alloc_area,
        state: a.state, startDate: a.start_date, endDate: a.end_date, note: a.alloc_note })),
    };
  });
}

function parcelTimeline(db, parcelId) {
  const p = getParcel(db, parcelId);
  const versions = db.prepare('SELECT * FROM parcel_versions WHERE parcel_id=? ORDER BY version').all(parcelId)
    .map(v => ({ ...v, geometry: JSON.parse(v.geometry) }));
  const lineage = db.prepare(`
    SELECT l.id,l.op,l.weight,l.from_version_id,l.to_version_id,
           fv.version AS from_version, fp.code AS from_code,
           tv.version AS to_version, tp.code AS to_code
    FROM version_lineage l
    LEFT JOIN parcel_versions fv ON fv.id=l.from_version_id
    LEFT JOIN parcels fp ON fp.id=fv.parcel_id
    JOIN parcel_versions tv ON tv.id=l.to_version_id
    LEFT JOIN parcels tp ON tp.id=tv.parcel_id
    WHERE l.to_version_id IN (SELECT id FROM parcel_versions WHERE parcel_id=?)
       OR l.from_version_id IN (SELECT id FROM parcel_versions WHERE parcel_id=?)
    ORDER BY l.id`).all(parcelId, parcelId);
  return { parcel: p, versions, lineage };
}

module.exports = {
  ApiError, PENDING_TOL,
  createParcel, correctBoundary, splitParcel, mergeParcels,
  createAdoption, terminateAdoption, resolveAllocation,
  upsertDiary, createBatch, addLabReport, withdrawReport, registerAttachment,
  issueShare, revokeShare, viewByToken,
  mapAt, parcelTimeline, currentVersion, versionAt, capacityReport,
};
