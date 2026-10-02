'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const { getDb } = require('./db');
const auth = require('./auth');
const plotSvc = require('./plotService');
const adoptSvc = require('./adoptionService');
const farmSvc = require('./farmService');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = process.env.PORT || 3000;

function send(res, status, obj, headers = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

async function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > 8 * 1024 * 1024) { reject(auth.httpError(413, '请求体过大')); req.destroy(); } chunks.push(c); });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch { reject(auth.httpError(400, '请求体不是合法 JSON')); }
    });
    req.on('error', reject);
  });
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json' };

function serveStatic(req, res, urlPath) {
  let rel = urlPath;
  if (rel === '/') rel = '/index.html';
  // 送礼视图是独立页面（独立权限），不是被隐藏元素的管理页
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) {
      if (urlPath.startsWith('/gift/')) return fs.readFile(path.join(PUBLIC_DIR, 'gift.html'), (e, d) => e ? send(res, 404, { error: 'not found' }) : res.writeHead(200, { 'Content-Type': MIME['.html'] }) || res.end(d));
      return send(res, 404, { error: 'not found' });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
}

// 路由定义：[method, prefix, handler, mode]  mode: public | auth | admin | gift
const routes = [];
function r(method, pat, handler, mode = 'auth') { routes.push({ method, pat, handler, mode }); }

r('POST', /^\/api\/auth\/login$/, async (req) => {
  const sess = auth.login(req.body.username, req.body.password);
  if (!sess) throw auth.httpError(401, '用户名或口令错误');
  return { token: sess.token, ...sess.user };
}, 'public');
r('POST', /^\/api\/auth\/logout$/, (req) => { auth.logout(req.token); return { ok: true }; }, 'auth');
r('GET', /^\/api\/me$/, (req) => req.user, 'auth');

// 公开地图（认养人匿名化）
r('GET', /^\/api\/map$/, (req) => {
  const date = req.query.date || new Date().toISOString().slice(0, 10);
  return { at: date, features: plotSvc.mapAt(date) };
}, 'public');

// 公开地块资料：版本时间线 + 认养“时段”，服务端裁剪认养人/价格/联系方式
r('GET', /^\/api\/public\/plots\/(\d+)$/, (req, m) => {
  const db = getDb();
  const id = Number(m[1]);
  const plot = plotSvc.getPlotFull(db, id);
  if (!plot) throw auth.httpError(404, '地块不存在');
  return {
    id: plot.id, code: plot.code, name: plot.name, slope_zone: plot.slope_zone, status: plot.status,
    versions: plot.versions.map(v => ({
      id: v.id, version_no: v.version_no, event: v.event, valid_from: v.valid_from,
      valid_to: v.valid_to, area_m2: v.area_m2, note: v.note
    })),
    adopted_periods: db.prepare(`SELECT period_start,period_end,area_m2,share_policy,version_id
      FROM adoptions WHERE plot_id=? ORDER BY period_start`).all(id)
  };
}, 'public');

r('GET', /^\/api\/plots$/, () => plotSvc.listPlots(), 'auth');
r('POST', /^\/api\/plots$/, (req) => plotSvc.createPlot(req.user, req.body), 'admin');
r('GET', /^\/api\/plots\/(\d+)$/, (req, m) => plotSvc.getPlotFull(getDb(), Number(m[1])), 'auth');
r('GET', /^\/api\/plots\/(\d+)\/timeline$/, (req, m) => plotSvc.timeline(Number(m[1])), 'auth');
r('GET', /^\/api\/plots\/(\d+)\/availability$/, (req, m) => plotSvc.availability(getDb(), Number(m[1]), req.query.date || new Date().toISOString().slice(0, 10)), 'auth');
r('GET', /^\/api\/plots\/(\d+)\/policy-comparison$/, (req, m) => adoptSvc.comparePolicies(Number(m[1])), 'auth');

r('POST', /^\/api\/plots\/(\d+)\/split$/, (req, m) => plotSvc.splitPlot(req.user, Number(m[1]), req.body), 'admin');
r('POST', /^\/api\/plots\/merge$/, (req) => plotSvc.mergePlots(req.user, req.body.plot_ids, req.body), 'admin');
r('POST', /^\/api\/plots\/(\d+)\/correct$/, (req, m) => plotSvc.correctBoundary(req.user, Number(m[1]), req.body), 'admin');
r('POST', /^\/api\/versions\/(\d+)\/lock$/, (req, m) => plotSvc.acquireLock(req.user, Number(m[1]), req.body.ttl_sec || 120), 'admin');
r('DELETE', /^\/api\/versions\/(\d+)\/lock$/, (req, m) => { plotSvc.releaseLock(getDb(), Number(m[1])); return { ok: true }; }, 'admin');

r('GET', /^\/api\/adoptions$/, () => adoptSvc.listAdoptions(), 'auth');
r('POST', /^\/api\/adoptions$/, (req) => adoptSvc.createAdoption(req.user, req.body), 'admin');
r('PUT', /^\/api\/adoptions\/(\d+)$/, (req, m) => adoptSvc.updateAdoption(req.user, Number(m[1]), req.body), 'admin');
r('GET', /^\/api\/correspondences$/, (req) => adoptSvc.listCorrespondences(req.query.status), 'auth');
r('POST', /^\/api\/correspondences\/(\d+)\/resolve$/, (req, m) => adoptSvc.resolveCorrespondence(req.user, Number(m[1]), req.body), 'admin');

r('GET', /^\/api\/farmers$/, () => farmSvc.listFarmers(), 'auth');
r('POST', /^\/api\/farmers$/, (req) => farmSvc.createFarmer(req.user, req.body), 'admin');
r('GET', /^\/api\/diaries$/, (req) => farmSvc.listDiaries(req.query.plot_id ? Number(req.query.plot_id) : null), 'public');
r('POST', /^\/api\/diaries$/, (req) => farmSvc.pushDiary(req.user, req.body), 'auth');
r('POST', /^\/api\/diaries\/sync$/, (req) => farmSvc.pushDiaries(req.user, req.body.items || []), 'auth');

r('GET', /^\/api\/pickings$/, (req) => farmSvc.listPickings(req.query.plot_id ? Number(req.query.plot_id) : null), 'auth');
r('POST', /^\/api\/pickings$/, (req) => farmSvc.createPicking(req.user, req.body), 'admin');
r('GET', /^\/api\/samplings$/, () => farmSvc.listSamplings(), 'auth');
r('POST', /^\/api\/samplings$/, (req) => farmSvc.createSampling(req.user, req.body), 'admin');
r('GET', /^\/api\/samplings\/(\d+)$/, (req, m) => farmSvc.getSampling(getDb(), Number(m[1])), 'auth');

r('POST', /^\/api\/attachments$/, (req) => farmSvc.putAttachment(req.user, {
  ...req.body, content: Buffer.from(req.body.content_base64 || '', 'base64')
}), 'admin');
r('POST', /^\/api\/attachments\/(\d+)\/withdraw$/, (req, m) => farmSvc.withdrawAttachment(req.user, Number(m[1]), req.body.reason), 'admin');
r('GET', /^\/api\/attachments\/(\d+)\/download$/, (req, m, res) => {
  const { meta, stream } = farmSvc.readAttachment(Number(m[1]));
  res.writeHead(200, { 'Content-Type': meta.mime, 'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(meta.filename)}` });
  res.end(stream);
  return { __sent: true };
}, 'auth');

r('POST', /^\/api\/share-links$/, (req) => farmSvc.createShareLink(req.user, req.body), 'admin');
r('GET', /^\/api\/share-links$/, () => farmSvc.listShareLinks(), 'admin');
r('POST', /^\/api\/share-links\/(\d+)\/revoke$/, (req, m) => farmSvc.revokeShareLink(req.user, Number(m[1])), 'admin');
// 送礼视图：独立权限接口，只认 X-Gift-Token；会话无效也可访问；服务端裁剪私有字段
r('GET', /^\/api\/gift\/view$/, (req) => farmSvc.giftView(req.giftToken), 'gift');

const server = http.createServer(async (req, res) => {
  try {
    const u = new URL(req.url, `http://localhost:${PORT}`);
    const pathname = u.pathname;
    if (!pathname.startsWith('/api/')) return serveStatic(req, res, pathname);

    const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const tokenVal = (req.headers['x-auth-token'] || '').toString();
    const giftToken = (req.headers['x-gift-token'] || '').toString();
    const query = Object.fromEntries(u.searchParams);
    const ctx = { body, query, token: tokenVal, giftToken, user: null, headers: req.headers };

    for (const route of routes) {
      if (route.method !== req.method) continue;
      const m = pathname.match(route.pat);
      if (!m) continue;
      if (route.mode === 'auth' || route.mode === 'admin') {
        ctx.user = auth.getUserBySession(tokenVal);
        if (!ctx.user) return send(res, 401, { error: '未登录或会话已失效' });
        if (route.mode === 'admin' && ctx.user.role !== 'admin') {
          return send(res, 403, { error: '需要管理员权限' });
        }
      } else if (route.mode === 'gift') {
        if (!auth.resolveGiftToken(giftToken)) return send(res, 403, { error: '送礼链接无效、已过期或已达访问上限' });
      }
      const result = await route.handler(ctx, m, res);
      if (result && result.__sent) return;
      if (result === null || result === undefined) {
        if (res.writableEnded) return;
        return send(res, 200, {});
      }
      return send(res, 200, result);
    }
    send(res, 404, { error: '接口不存在' });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error(e);
    send(res, status, { error: e.message || '服务器错误', ...(e.extra || {}) });
  }
});

if (require.main === module) {
  getDb();
  server.listen(PORT, () => console.log(`茶园认养站已启动: http://localhost:${PORT}`));
}
module.exports = { server };
