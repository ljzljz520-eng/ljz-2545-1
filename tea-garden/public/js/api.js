'use strict';
// 极简 API 封装。鉴权令牌只存内存 + sessionStorage；送礼令牌来自 URL。
const Api = (() => {
  const TOKEN_KEY = 'tea_token';
  const getToken = () => sessionStorage.getItem(TOKEN_KEY);
  const setToken = t => t ? sessionStorage.setItem(TOKEN_KEY, t) : sessionStorage.removeItem(TOKEN_KEY);

  async function request(method, url, body, { raw = false, headers = {} } = {}) {
    const opt = { method, headers: { ...headers } };
    const tok = getToken();
    if (tok) opt.headers['Authorization'] = 'Bearer ' + tok;
    if (body && !(body instanceof FormData)) {
      opt.headers['Content-Type'] = 'application/json';
      opt.body = JSON.stringify(body);
    } else if (body instanceof FormData) opt.body = body;
    const res = await fetch(url, opt);
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('application/json') ? await res.json() : await res.text();
    if (!res.ok) {
      const err = new Error((data && data.message) || ('HTTP ' + res.status));
      err.status = res.status; err.code = data && data.error; err.details = data && data.details;
      err.data = data;
      throw err;
    }
    return raw ? { res, data } : data;
  }
  return {
    get: u => request('GET', u),
    post: (u, b) => request('POST', u, b),
    upload: (u, form) => request('POST', u, form),
    getToken, setToken,
    get giftToken() { return new URLSearchParams(location.search).get('token'); },
  };
})();

function toast(msg, isErr = false, ms = 3200) {
  let el = document.querySelector('.toast');
  if (!el) { el = document.createElement('div'); el.className = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.className = 'toast', ms);
}
function fmtYuan(cents) { return cents == null ? '—' : '¥' + (cents / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2 }); }
function esc(s) { return String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
function today() { return new Date().toISOString().slice(0, 10); }
