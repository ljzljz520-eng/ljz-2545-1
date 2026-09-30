'use strict';
// 离线日记：写入本地 outbox；上线后带 clientId 同步（服务端按 client_id 幂等去重）。
const Offline = (() => {
  const KEY = 'tea_diary_outbox_v1';
  const listeners = new Set();
  function load() { try { return JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { return []; } }
  function save(list) { localStorage.setItem(KEY, JSON.stringify(list)); listeners.forEach(fn => fn(status())); }
  function uuid() { return 'c-' + crypto.randomUUID(); }

  function enqueue(entry) {
    const list = load();
    const item = { clientId: entry.clientId || uuid(), createdAt: new Date().toISOString(), tried: 0, entry };
    list.push(item); save(list); return item;
  }
  function remove(clientId) { save(load().filter(i => i.clientId !== clientId)); }

  async function sync() {
    if (!navigator.onLine || !Api.getToken()) return { synced: 0, skipped: load().length };
    let synced = 0;
    for (const item of load()) {
      try {
        const r = await Api.post('/api/diaries', { ...item.entry, clientId: item.clientId });
        remove(item.clientId);
        synced++;
        if (!r.deduplicated) document.dispatchEvent(new CustomEvent('diary-synced', { detail: r }));
      } catch (e) {
        if (e.status === 401) break; // 未登录，等待
        item.tried++; save(load());
        throw e;
      }
    }
    return { synced };
  }

  function status() {
    return { online: navigator.onLine, pending: load().length };
  }
  function onChange(fn) { listeners.push(fn); fn(status()); }
  window.addEventListener('online', () => sync().catch(() => {}));
  window.addEventListener('offline', () => listeners.forEach(fn => fn(status())));

  return { enqueue, sync, status, onChange, list: load };
})();

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
