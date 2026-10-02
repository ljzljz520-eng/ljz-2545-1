'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DB_PATH = process.env.TEA_DB || path.join(__dirname, '..', 'data', 'app.db');

let _db;
function getDb() {
  if (_db) return _db;
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  _db = db;
  return db;
}

function resetDb(db = getDb()) {
  // 子表先删、父表后删，避免外键约束；最稳妥是临时关闭 FK 检查
  db.pragma('foreign_keys = OFF');
  db.exec(`
    DELETE FROM edit_locks; DELETE FROM sessions; DELETE FROM attachments;
    DELETE FROM sampling_batches; DELETE FROM area_correspondences; DELETE FROM share_links;
    DELETE FROM picking_batches; DELETE FROM diaries; DELETE FROM adoptions;
    DELETE FROM plot_events; DELETE FROM plot_versions; DELETE FROM plots;
    DELETE FROM farmers; DELETE FROM users;
  `);
  try { db.exec('DELETE FROM sqlite_sequence;'); } catch { /* 无 AUTOINCREMENT 表时该表不存在 */ }
  db.pragma('foreign_keys = ON');
}

module.exports = { getDb, resetDb, DB_PATH };
