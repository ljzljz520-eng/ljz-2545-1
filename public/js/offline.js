// IndexedDB 离线日记队列（幂等键 client_uuid）
const DB_NAME = 'tea-offline', STORE = 'diary-outbox';
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'client_uuid' });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
export const outbox = {
  async add(item) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).put(item);
      tx.onsuccess = () => res(); tx.onerror = () => rej(tx.error);
    });
  },
  async all() {
    const db = await openDB();
    return new Promise((res, rej) => {
      const r = db.transaction(STORE).objectStore(STORE).getAll();
      r.onsuccess = () => res(r.result || []); r.onerror = () => rej(r.error);
    });
  },
  async remove(uuid) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(STORE, 'readwrite').objectStore(STORE).delete(uuid);
      tx.onsuccess = () => res(); tx.onerror = () => rej(tx.error);
    });
  }
};
export function uuid() {
  return 'cli-' + crypto.randomUUID();
}
