'use strict';
const crypto = require('crypto');
const { getDb } = require('./db');

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(':');
  const test = crypto.scryptSync(String(pw), salt, 32).toString('hex');
  const a = Buffer.from(hash, 'hex'), b = Buffer.from(test, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function token() { return crypto.randomBytes(24).toString('hex'); }

function login(username, password) {
  const db = getDb();
  const user = db.prepare('SELECT * FROM users WHERE username=?').get(username);
  if (!user || !verifyPassword(password, user.password)) return null;
  const t = token();
  db.prepare('INSERT INTO sessions(token,user_id) VALUES(?,?)').run(t, user.id);
  return { token: t, user: publicUser(user) };
}
function publicUser(u) {
  return { id: u.id, username: u.username, role: u.role, display_name: u.display_name };
}
function getUserBySession(tok) {
  if (!tok) return null;
  const db = getDb();
  const row = db.prepare(`
    SELECT u.* FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=?`).get(tok);
  return row ? publicUser(row) : null;
}
function logout(tok) {
  if (tok) getDb().prepare('DELETE FROM sessions WHERE token=?').run(tok);
}

// 会话认证中间件（供路由包装器调用）
function requireAuth(req) {
  const user = getUserBySession(req.token);
  if (!user) throw httpError(401, '未登录或会话已失效');
  return user;
}
function requireAdmin(req) {
  const user = requireAuth(req);
  if (user.role !== 'admin') throw httpError(403, '需要管理员权限');
  return user;
}

// 送礼视图：独立权限——只认 gift token，与登录会话完全分离
function resolveGiftToken(giftToken) {
  if (!giftToken) return null;
  const db = getDb();
  const link = db.prepare('SELECT * FROM share_links WHERE token=?').get(giftToken);
  if (!link || link.revoked) return null;
  if (new Date(link.expires_at).getTime() < Date.now()) return null;
  if (link.max_views != null && link.view_count >= link.max_views) return null;
  return link;
}

function httpError(status, message, extra = {}) {
  const e = new Error(message);
  e.status = status; e.extra = extra;
  return e;
}

module.exports = {
  hashPassword, verifyPassword, token, login, logout, getUserBySession,
  publicUser, requireAuth, requireAdmin, resolveGiftToken, httpError
};
