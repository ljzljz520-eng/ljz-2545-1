// 极简 API 客户端：会话 token 存 localStorage；送礼 token 独立存放，绝不混用
export const store = {
  get token() { return localStorage.getItem('tea_token') || ''; },
  set token(v) { v ? localStorage.setItem('tea_token', v) : localStorage.removeItem('tea_token'); },
  get user() { try { return JSON.parse(localStorage.getItem('tea_user') || 'null'); } catch { return null; } },
  set user(v) { v ? localStorage.setItem('tea_user', JSON.stringify(v)) : localStorage.removeItem('tea_user'); },
  get giftToken() { return new URLSearchParams(location.search).get('gift') || sessionStorage.getItem('gift_token') || ''; }
};

export async function api(method, url, body, { gift = false } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (gift) headers['X-Gift-Token'] = store.giftToken;
  else if (store.token) headers['X-Auth-Token'] = store.token;
  const res = await fetch(url, { method, headers, body: body ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch {}
  if (!res.ok) {
    const err = new Error((data && data.error) || `请求失败 ${res.status}`);
    err.status = res.status; err.data = data || {};
    throw err;
  }
  return data;
}

export const fmt = {
  yuan(fen) { return fen == null ? '—' : '¥' + (fen / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 }); },
  mu(m2) { return (m2 / 666.67).toFixed(2) + 亩'; },
  date(s) { return s || '—'; },
  period(a, b) { return `${a} ~ ${b}`; }
};

export function toast(msg, isError = false) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.add('show');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 3600);
}

export function requireAuth() {
  if (!store.token) { location.href = '/login.html'; return false; }
  return true;
}
export function requireAdmin() {
  if (!requireAuth()) return false;
  if (!store.user || store.user.role !== 'admin') { toast('需要管理员权限', true); return false; }
  return true;
}
