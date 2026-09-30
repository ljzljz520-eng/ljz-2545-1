'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const { openDb, initSchema, getObjectsDir } = require('./db');
const store = require('./store');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const db = openDb();
initSchema(db);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

// ---------------- multipart 解析（无第三方依赖） ----------------
function parseMultipart(buffer, boundary) {
  const out = { fields: {}, files: {} };
  const delim = Buffer.from('--' + boundary);
  let start = buffer.indexOf(delim);
  while (start !== -1) {
    start += delim.length;
    if (buffer[start] === 45 && buffer[start + 1] === 45) break; // "--" 结束
    if (buffer[start] === 13 && buffer[start + 1] === 10) start += 2;
    const headerEnd = buffer.indexOf(Buffer.from('\r\n\r\n'), start);
    if (headerEnd === -1) break;
    const headers = buffer.slice(start, headerEnd).toString('utf8');
    let bodyStart = headerEnd + 4;
    let next = buffer.indexOf(Buffer.concat([Buffer.from('\r\n'), delim]), bodyStart);
    if (next === -1) break;
    const body = buffer.slice(bodyStart, next);
    const nameM = /name="([^"]+)"/.exec(headers);
    const fileM = /filename="([^"]*)"/.exec(headers);
    const ctM = /Content-Type:\s*([^\r\n]+)/i.exec(headers);
    if (nameM) {
      if (fileM && fileM[1]) {
        out.files[nameM[1]] = {
          filename: path.basename(fileM[1]),
          mimeType: ctM ? ctM[1].trim() : 'application/octet-stream',
          buffer: body,
        };
      } else {
        out.fields[nameM[1]] = body.toString('utf8');
      }
    }
    start = next + 2;
  }
  return out;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => { size += c.length; if (size > 20 * 1024 * 1024) { reject(new store.ApiError(413, 'TOO_LARGE', '附件不得超过 20MB')); req.destroy(); } chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---------------- 鉴权（服务端强制，不靠前端隐藏） ----------------
function getUser(req) {
  const h = req.headers.authorization || '';
  if (!h.startsWith('Bearer ')) return null;
  const token = h.slice(7);
  return db.prepare(`SELECT u.id,u.username,u.display_name,u.role,u.farmer_id FROM sessions s
    JOIN users u ON u.id=s.user_id WHERE s.token=?`).get(token) || null;
}
function requireUser(req, role) {
  const u = getUser(req);
  if (!u) throw new store.ApiError(401, 'UNAUTHORIZED', '请先登录');
  if (role && u.role !== role && role !== '*') throw new store.ApiError(403, 'FORBIDDEN', '需要 ' + role + ' 权限');
  return u;
}
function audit(actor, action, detail, status) {
  db.prepare('INSERT INTO audit_log(actor,action,detail,http_status) VALUES(?,?,?,?)')
    .run(actor || null, action, typeof detail === 'string' ? detail : JSON.stringify(detail), status || null);
}

const json = (res, code, data) => { res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };

// 列表读取辅助
function listAdoptions(full) {
  const rows = db.prepare('SELECT * FROM adoptions ORDER BY id').all();
  return rows.map(a => {
    const pvRow = db.prepare('SELECT code_snapshot,name_snapshot FROM parcel_versions WHERE id=?').get(a.created_version_id);
    const pending = db.prepare("SELECT COUNT(*) c, COALESCE(SUM(area),0) s FROM allocations WHERE adoption_id=? AND state='pending'").get(a.id);
    const base = {
      id: a.id, label: a.label, mode: a.mode, area: a.area, startDate: a.start_date, endDate: a.end_date,
      gift: !!a.gift, status: a.status, parcelCode: pvRow.code_snapshot, parcelName: pvRow.name_snapshot,
      pendingCount: pending.c, pendingArea: round2(pending.s),
      period: `${a.start_date} ~ ${a.end_date || '长期'}`,
    };
    if (full) { base.priceCents = a.price_cents; base.contact = a.contact; base.createdVersionId = a.created_version_id; }
    return base;
  });
}
function listBatches() {
  return db.prepare(`
    SELECT b.id,b.code,b.parcel_id,b.parcel_version_id,b.picked_on,b.scope_note,b.leaf_kind,b.yield_kg,
           pv.code_snapshot AS parcel_code,
           (SELECT COUNT(*) FROM lab_reports r WHERE r.batch_id=b.id AND r.withdrawn=0) AS active_reports,
           (SELECT COUNT(*) FROM lab_reports r WHERE r.batch_id=b.id) AS total_reports
    FROM batches b JOIN parcel_versions pv ON pv.id=b.parcel_version_id ORDER BY b.picked_on DESC`).all()
    .map(b => ({ ...b, scopeWarning: '本批次检测与结论仅代表其声明范围，不代表整座茶园' }));
}
function reportDetail(id) {
  const r = db.prepare('SELECT * FROM lab_reports WHERE id=?').get(id);
  if (!r) throw new store.ApiError(404, 'NOT_FOUND', '检测报告不存在');
  const att = r.attachment_id ? db.prepare('SELECT id,object_key,original_name,mime_type,size_bytes,status,archived_reason FROM attachments WHERE id=?').get(r.attachment_id) : null;
  return { ...r, attachment: att };
}
const round2 = x => Math.round(x * 100) / 100;

// ---------------- 路由 ----------------
const routes = [];
const R = (method, pattern, roles, handler) => routes.push({ method, pattern, roles, handler });

// ---- 公开 ----
R('GET', /^\/api\/map(?:\?.*)?$/, null, async (req, res, m, u, q) => {
  const date = q.get('date') || new Date().toISOString().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new store.ApiError(400, 'BAD_DATE', 'date 需为 YYYY-MM-DD');
  json(res, 200, { date, parcels: store.mapAt(db, date), periodNote: `地图显示 ${date} 当天生效的边界版本与认养区间` });
});
R('GET', /^\/api\/parcels\/(\d+)\/timeline$/, null, async (req, res, m) => json(res, 200, store.parcelTimeline(db, +m[1])));
R('GET', /^\/api\/farmers$/, null, async (req, res) => {
  json(res, 200, db.prepare('SELECT id,name,bio FROM farmers ORDER BY id').all());
});
R('GET', /^\/api\/diaries(?:\?.*)?$/, null, async (req, res, m, u, q) => {
  const pid = q.get('parcelId');
  const rows = db.prepare(`
    SELECT d.id,d.parcel_id,d.farmer_id,d.entry_date,d.weather,d.body, f.name AS farmer_name,
           pv.code_snapshot AS parcel_code_at_entry
    FROM diaries d JOIN farmers f ON f.id=d.farmer_id
    LEFT JOIN parcel_versions pv ON pv.parcel_id=d.parcel_id
      AND pv.valid_from <= d.entry_date AND (pv.valid_to IS NULL OR pv.valid_to > d.entry_date)
    WHERE (? IS NULL OR d.parcel_id=?) ORDER BY d.entry_date DESC, d.id DESC`).all(pid || null, pid || null);
  json(res, 200, rows);
});
R('GET', /^\/api\/batches(?:\?.*)?$/, null, async (req, res, m, u, q) => {
  const out = listBatches();
  const pid = q.get('parcelId');
  json(res, 200, { batches: pid ? out.filter(b => String(b.parcel_id) === pid) : out });
});
R('GET', /^\/api\/batches\/(\d+)$/, null, async (req, res, m) => {
  const b = db.prepare(`SELECT b.*, pv.code_snapshot AS parcel_code, pv.valid_from AS boundary_from, pv.valid_to AS boundary_to
    FROM batches b JOIN parcel_versions pv ON pv.id=b.parcel_version_id WHERE b.id=?`).get(+m[1]);
  if (!b) throw new store.ApiError(404, 'NOT_FOUND', '批次不存在');
  const reports = db.prepare('SELECT * FROM lab_reports WHERE batch_id=? ORDER BY issued_on').all(b.id)
    .map(r => ({ id: r.id, title: r.title, labName: r.lab_name, issuedOn: r.issued_on, summary: r.summary,
      withdrawn: !!r.withdrawn, withdrawnReason: r.withdrawn_reason, hasAttachment: !!r.attachment_id }));
  json(res, 200, {
    batch: b, reports,
    scopeNotice: `检测报告仅代表批次「${b.code}」声明的采摘范围（${b.scope_note || b.parcel_code}，${b.picked_on}），不得外推到其他地块或全园。`,
  });
});
R('GET', /^\/api\/reports\/(\d+)\/attachment$/, null, async (req, res, m) => {
  const r = reportDetail(+m[1]);
  if (r.withdrawn || !r.attachment || r.attachment.status === 'archived') {
    throw new store.ApiError(410, 'ATTACHMENT_ARCHIVED', '该检测报告已撤回，附件已在对象层归档，不再提供下载',
      r.attachment ? { archivedReason: r.attachment.archived_reason } : {});
  }
  const fp = path.join(getObjectsDir(), r.attachment.object_key);
  if (!fs.existsSync(fp)) throw new store.ApiError(404, 'OBJECT_MISSING', '对象文件缺失');
  res.writeHead(200, { 'Content-Type': r.attachment.mime_type, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(r.attachment.original_name)}` });
  fs.createReadStream(fp).pipe(res);
});

// ---- 送礼独立权限接口：gift 范围绝不下发价格/认养人联系方式 ----
R('GET', /^\/api\/gift\/([A-Za-z0-9_-]+)$/, null, async (req, res, m) => {
  const view = store.viewByToken(db, m[1]);
  audit('gift:' + m[1].slice(0, 6), 'gift_view', `scope=${view.scope || '-'} status=${view.status}`, view.status);
  json(res, view.status, view);
});

// ---- 登录 ----
R('POST', /^\/api\/auth\/login$/, null, async (req, res, m, u, q, body) => {
  const { username, password } = body || {};
  const hash = crypto.createHash('sha256').update(String(password || '')).digest('hex');
  const user = db.prepare('SELECT * FROM users WHERE username=? AND password=?').get(username, hash);
  if (!user) { audit(username, 'login_failed', '', 401); throw new store.ApiError(401, 'BAD_CREDENTIALS', '用户名或密码错误'); }
  const token = crypto.randomBytes(24).toString('base64url');
  db.prepare('INSERT INTO sessions(token,user_id) VALUES(?,?)').run(token, user.id);
  audit(username, 'login', 'ok', 200);
  json(res, 200, { token, user: { id: user.id, username: user.username, displayName: user.display_name, role: user.role } });
});
R('POST', /^\/api\/auth\/logout$/, '*', async (req, res, m, user, q, body) => {
  const h = req.headers.authorization || '';
  db.prepare('DELETE FROM sessions WHERE token=?').run(h.slice(7));
  json(res, 200, { ok: true });
});

// ---- 农户/管理员：离线日记同步（client_id 幂等去重） ----
R('POST', /^\/api\/diaries$/, '*', async (req, res, m, user, q, body) => {
  const farmerId = user.role === 'farmer' ? user.farmer_id : body.farmerId;
  if (!farmerId) throw new store.ApiError(400, 'BAD_FARMER', '无法确定农户身份（该账号未绑定农户）');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(body.entryDate || '')) throw new store.ApiError(400, 'BAD_DATE', 'entryDate 需为 YYYY-MM-DD');
  const out = store.upsertDiary(db, { parcelId: +body.parcelId, farmerId: +farmerId,
    entryDate: body.entryDate, weather: body.weather, body: body.body,
    clientId: body.clientId || null });
  audit(user.username, 'diary_sync', JSON.stringify({ id: out.id, clientId: body.clientId || null, dup: !!out.deduplicated }), 200);
  json(res, 200, out);
});

// 几何入参解析：任何解析/校验错误统一为 400 BAD_GEOMETRY
function parseGeom(g) {
  try { return typeof g === 'string' ? JSON.parse(g) : g; }
  catch { throw new store.ApiError(400, 'BAD_GEOMETRY', 'geometry 不是合法 GeoJSON'); }
}

// ---- 管理后台 ----
R('POST', /^\/api\/admin\/parcels$/, 'admin', async (req, res, m, user, q, body) => {
  let r;
  try { r = store.createParcel(db, { ...body, geometry: parseGeom(body.geometry), userId: user.id }); }
  catch (e) { throw mapGeomError(e); }
  audit(user.username, 'parcel_create', JSON.stringify(r), 200); json(res, 200, r);
});
R('POST', /^\/api\/admin\/parcels\/correct$/, 'admin', async (req, res, m, user, q, body) => {
  let r;
  try { r = store.correctBoundary(db, { ...body, geometry: parseGeom(body.geometry), userId: user.id }); }
  catch (e) { throw mapGeomError(e); }
  audit(user.username, 'boundary_correct', JSON.stringify(r), 200); json(res, 200, r);
});
function mapGeomError(e) {
  if (e instanceof store.ApiError) return e;
  if (/^BAD_GEOMETRY|BAD_CUT|BAD_MERGE|Polygon/.test(e.message)) return new store.ApiError(400, 'BAD_GEOMETRY', e.message);
  return e;
}
R('POST', /^\/api\/admin\/parcels\/split$/, 'admin', async (req, res, m, user, q, body) => {
  let r;
  try { r = store.splitParcel(db, { ...body, userId: user.id }); }
  catch (e) { throw mapGeomError(e); }
  audit(user.username, 'parcel_split', JSON.stringify(r), 200); json(res, 200, r);
});
R('POST', /^\/api\/admin\/parcels\/merge$/, 'admin', async (req, res, m, user, q, body) => {
  let r;
  try { r = store.mergeParcels(db, { ...body, userId: user.id }); }
  catch (e) { throw mapGeomError(e); }
  audit(user.username, 'parcel_merge', JSON.stringify(r), 200); json(res, 200, r);
});
R('GET', /^\/api\/admin\/adoptions$/, 'admin', async (req, res) => json(res, 200, listAdoptions(true)));
R('POST', /^\/api\/admin\/adoptions$/, 'admin', async (req, res, m, user, q, body) => {
  const r = store.createAdoption(db, body);
  audit(user.username, 'adoption_create', JSON.stringify(r), 200); json(res, 200, r);
});
R('POST', /^\/api\/admin\/adoptions\/terminate$/, 'admin', async (req, res, m, user, q, body) => {
  const r = store.terminateAdoption(db, body);
  audit(user.username, 'adoption_terminate', JSON.stringify(r), 200); json(res, 200, r);
});
R('GET', /^\/api\/admin\/pending-allocations$/, 'admin', async (req, res) => {
  const rows = db.prepare(`
    SELECT al.id,al.area,al.note,al.parcel_version_id,al.adoption_id,
           a.label,a.mode,pv.code_snapshot,pv.version,pv.area AS version_area
    FROM allocations al JOIN adoptions a ON a.id=al.adoption_id
    JOIN parcel_versions pv ON pv.id=al.parcel_version_id
    WHERE al.state='pending' ORDER BY al.id`).all();
  json(res, 200, rows);
});
R('POST', /^\/api\/admin\/allocations\/resolve$/, 'admin', async (req, res, m, user, q, body) => {
  const r = store.resolveAllocation(db, body);
  audit(user.username, 'allocation_resolve', JSON.stringify(r), 200); json(res, 200, r);
});
R('POST', /^\/api\/admin\/batches$/, 'admin', async (req, res, m, user, q, body) => {
  const r = store.createBatch(db, body);
  audit(user.username, 'batch_create', JSON.stringify(r), 200); json(res, 200, r);
});
R('POST', /^\/api\/admin\/reports$/, 'admin', async (req, res, m, user, q, body) => {
  const r = store.addLabReport(db, body);
  audit(user.username, 'report_add', JSON.stringify(r), 200); json(res, 200, r);
});
R('POST', /^\/api\/admin\/reports\/withdraw$/, 'admin', async (req, res, m, user, q, body) => {
  const r = store.withdrawReport(db, body);
  audit(user.username, 'report_withdraw', JSON.stringify(r), 200); json(res, 200, r);
});
R('GET', /^\/api\/admin\/attachments$/, 'admin', async (req, res) => {
  json(res, 200, db.prepare('SELECT id,object_key,original_name,mime_type,size_bytes,sha256,status,archived_reason,created_at,archived_at FROM attachments ORDER BY id').all());
});
R('POST', /^\/api\/admin\/shares$/, 'admin', async (req, res, m, user, q, body) => {
  const r = store.issueShare(db, { ...body, userId: user.id });
  audit(user.username, 'share_issue', JSON.stringify({ scope: r.scope, token: r.token.slice(0, 6) + '…' }), 200);
  json(res, 200, r);
});
R('GET', /^\/api\/admin\/shares$/, 'admin', async (req, res) => {
  json(res, 200, db.prepare('SELECT token,adoption_id,scope,expires_at,revoked,created_at FROM gift_shares ORDER BY rowid DESC').all());
});
R('POST', /^\/api\/admin\/shares\/revoke$/, 'admin', async (req, res, m, user, q, body) => {
  const r = store.revokeShare(db, body.token);
  audit(user.username, 'share_revoke', body.token, 200); json(res, 200, r);
});
R('GET', /^\/api\/admin\/audit$/, 'admin', async (req, res) => {
  json(res, 200, db.prepare('SELECT * FROM audit_log ORDER BY id DESC LIMIT 100').all());
});

// ---- 附件上传（对象层：文件写 data/objects，元数据入库） ----
R('POST', /^\/api\/admin\/attachments$/, 'admin', async (req, res) => {
  const ct = req.headers['content-type'] || '';
  const bm = /boundary=(?:"([^"]+)"|([^;]+))/.exec(ct);
  if (!ct.startsWith('multipart/form-data') || !bm) throw new store.ApiError(400, 'BAD_CT', '需要 multipart/form-data');
  const raw = await readBody(req);
  const { files } = parseMultipart(raw, bm[1] || bm[2]);
  const f = files.file;
  if (!f) throw new store.ApiError(400, 'NO_FILE', '缺少 file 字段');
  if (!/^text\/(plain|csv)|application\/(pdf|json)|image\//.test(f.mimeType)) {
    throw new store.ApiError(415, 'BAD_MIME', '仅接受文本/PDF/图片/JSON 检测附件');
  }
  const sha = crypto.createHash('sha256').update(f.buffer).digest('hex');
  const key = sha.slice(0, 20) + '-' + f.filename.replace(/[^\w.\-]+/g, '_');
  fs.writeFileSync(path.join(getObjectsDir(), key), f.buffer);
  const att = store.registerAttachment(db, { objectKey: key, originalName: f.filename, mimeType: f.mimeType, sizeBytes: f.buffer.length, sha256: sha });
  audit(getUser(req).username, 'attachment_upload', JSON.stringify({ id: att.id, key }), 200);
  json(res, 200, att);
});

// ---------------- 静态文件 ----------------
function serveStatic(req, res, pathname) {
  let rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  // 友好路由
  if (rel === 'admin') rel = 'admin.html';
  if (rel === 'gift') rel = 'gift.html';
  if (rel === 'design') rel = 'design.html';
  const fp = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!fp.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(fp, (err, data) => {
    if (err) {
      // SPA 回退（非 API）
      if (!pathname.startsWith('/api/')) return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] }); res.end(d2);
      });
      res.writeHead(404); return res.end('not found');
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const pathname = u.pathname;
  try {
    if (pathname.startsWith('/api/')) {
      const route = routes.find(r => r.method === req.method && r.pattern.test(pathname));
      if (!route) throw new store.ApiError(404, 'NO_ROUTE', '接口不存在: ' + req.method + ' ' + pathname);
      const user = route.roles ? requireUser(req, route.roles) : null;
      let body = null;
      if (req.method === 'POST' && !(req.headers['content-type'] || '').startsWith('multipart/form-data')) {
        const raw = await readBody(req);
        body = raw.length ? JSON.parse(raw.toString('utf8')) : {};
      }
      await route.handler(req, res, pathname.match(route.pattern), user, u.searchParams, body);
      return;
    }
    serveStatic(req, res, pathname);
  } catch (e) {
    if (e instanceof SyntaxError) return json(res, 400, { error: 'BAD_JSON', message: '请求体不是合法 JSON' });
    const status = e.status || 500;
    if (status === 500) console.error(e);
    audit((getUser(req) || {}).username || 'anon', 'error', e.message, status);
    json(res, status, { error: e.code || 'INTERNAL', message: e.message, details: e.details || {} });
  }
});

function start(port = PORT) {
  return new Promise((resolve) => {
    if (server.listening) return resolve(server);
    server.listen(port, () => { console.log(`茶园认养站已启动：http://localhost:${port}  （后台 /admin，设计说明 /design）`); resolve(server); });
  });
}
if (require.main === module) start();
module.exports = { server, db, start };
