'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DEFAULT_DATA_DIR = path.join(__dirname, '..', 'data');
const getDataDir = () => process.env.TEA_DATA_DIR || DEFAULT_DATA_DIR;
const getDbFile = () => process.env.TEA_DB_FILE || path.join(getDataDir(), 'tea.db');
const getObjectsDir = () => path.join(getDataDir(), 'objects');

function openDb(file = getDbFile()) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.mkdirSync(getObjectsDir(), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

function initSchema(db) {
  db.exec(`
  -- 农户
  CREATE TABLE IF NOT EXISTS farmers (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    bio  TEXT NOT NULL DEFAULT '',
    photo TEXT
  );

  -- 地块（逻辑实体，边界变化不换 id；编码唯一性仅在「当前仍生效」地块间保证）
  CREATE TABLE IF NOT EXISTS parcels (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    slope_angle REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 地块边界版本（空间版本库核心；半开区间 [valid_from, valid_to)，to=NULL 为当前版本）
  CREATE TABLE IF NOT EXISTS parcel_versions (
    id INTEGER PRIMARY KEY,
    parcel_id INTEGER NOT NULL REFERENCES parcels(id),
    version INTEGER NOT NULL,
    code_snapshot TEXT NOT NULL,      -- 该版本生效时地块编码/名称的快照（改名不污染历史）
    name_snapshot TEXT NOT NULL,
    geometry TEXT NOT NULL,          -- GeoJSON Polygon，茶园局部米制坐标
    area REAL NOT NULL,             -- 平方米
    valid_from TEXT NOT NULL,       -- YYYY-MM-DD
    valid_to TEXT,
    change_note TEXT NOT NULL DEFAULT '',
    created_by INTEGER REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(parcel_id, version)
  );
  CREATE INDEX IF NOT EXISTS idx_pv_time ON parcel_versions(valid_from, valid_to);

  -- 版本演化谱系（split / merge / correct / create）
  CREATE TABLE IF NOT EXISTS version_lineage (
    id INTEGER PRIMARY KEY,
    op TEXT NOT NULL CHECK(op IN ('create','split','merge','correct')),
    from_version_id INTEGER REFERENCES parcel_versions(id),
    to_version_id   INTEGER NOT NULL REFERENCES parcel_versions(id),
    weight REAL,                     -- 子块占父块交集面积比例
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 认养（固定面积份额 fixed / 随边界重分配 boundary）
  CREATE TABLE IF NOT EXISTS adoptions (
    id INTEGER PRIMARY KEY,
    label TEXT NOT NULL,            -- 认养人姓名或送礼署名
    mode TEXT NOT NULL CHECK(mode IN ('fixed','boundary')),
    area REAL NOT NULL,             -- 认养面积（平方米）
    start_date TEXT NOT NULL,
    end_date TEXT,                  -- NULL = 长期/未终止
    gift BOOLEAN NOT NULL DEFAULT 0,
    price_cents INTEGER,            -- 私有：金额，仅送礼权限/管理员可见
    contact TEXT,                   -- 私有：联系方式
    created_version_id INTEGER NOT NULL REFERENCES parcel_versions(id),
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','terminated')),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 认养在各地块版本上的面积分配（confirmed=已落实；pending=边界演化产生的未决差异）
  CREATE TABLE IF NOT EXISTS allocations (
    id INTEGER PRIMARY KEY,
    adoption_id INTEGER NOT NULL REFERENCES adoptions(id),
    parcel_version_id INTEGER NOT NULL REFERENCES parcel_versions(id),
    area REAL NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('confirmed','pending')),
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_alloc_pv ON allocations(parcel_version_id);
  CREATE INDEX IF NOT EXISTS idx_alloc_ad ON allocations(adoption_id);

  -- 生长日记
  CREATE TABLE IF NOT EXISTS diaries (
    id INTEGER PRIMARY KEY,
    parcel_id INTEGER NOT NULL REFERENCES parcels(id),
    farmer_id INTEGER NOT NULL REFERENCES farmers(id),
    entry_date TEXT NOT NULL,
    weather TEXT,
    body TEXT NOT NULL,
    client_id TEXT UNIQUE,          -- 离线幂等键
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_diary_parcel ON diaries(parcel_id, entry_date);

  -- 采摘批次（检测只代表声明范围）
  CREATE TABLE IF NOT EXISTS batches (
    id INTEGER PRIMARY KEY,
    code TEXT NOT NULL UNIQUE,
    parcel_id INTEGER NOT NULL REFERENCES parcels(id),
    parcel_version_id INTEGER NOT NULL REFERENCES parcel_versions(id), -- 声明时边界版本
    picked_on TEXT NOT NULL,
    scope_note TEXT NOT NULL DEFAULT '',
    leaf_kind TEXT,
    yield_kg REAL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 检测报告（对象层：文件本体入对象库，此处仅元数据；withdrawn 软撤回，不物理删除）
  CREATE TABLE IF NOT EXISTS lab_reports (
    id INTEGER PRIMARY KEY,
    batch_id INTEGER NOT NULL REFERENCES batches(id),
    title TEXT NOT NULL,
    lab_name TEXT,
    issued_on TEXT NOT NULL,
    summary TEXT NOT NULL,
    attachment_id INTEGER,
    withdrawn INTEGER NOT NULL DEFAULT 0,
    withdrawn_reason TEXT NOT NULL DEFAULT '',
    withdrawn_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 附件（对象层归档；文件存入 data/objects，DB 仅保存指针/哈希/状态）
  CREATE TABLE IF NOT EXISTS attachments (
    id INTEGER PRIMARY KEY,
    object_key TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    sha256 TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','archived')),
    archived_reason TEXT NOT NULL DEFAULT '',
    archived_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 送礼分享链接（独立权限令牌，服务端鉴权，绝不靠前端隐藏）
  CREATE TABLE IF NOT EXISTS gift_shares (
    token TEXT PRIMARY KEY,
    adoption_id INTEGER NOT NULL REFERENCES adoptions(id),
    issued_by INTEGER REFERENCES users(id),
    scope TEXT NOT NULL DEFAULT 'gift' CHECK(scope IN ('gift','admin')),
    expires_at TEXT,                -- NULL = 不过期
    revoked INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 用户（后台/农户登录会话）
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('admin','farmer')),
    password TEXT NOT NULL,
    farmer_id INTEGER REFERENCES farmers(id)  -- 农户账号绑定的管护农户
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id),
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  -- 边界演化/提交冲突审计日志（并发占用冲突留痕）
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY,
    actor TEXT,
    action TEXT NOT NULL,
    detail TEXT NOT NULL DEFAULT '',
    http_status INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  `);
}

module.exports = { openDb, initSchema,
  get DATA_DIR() { return getDataDir(); },
  get OBJECTS_DIR() { return getObjectsDir(); },
  get DB_FILE() { return getDbFile(); },
  getDataDir, getObjectsDir, getDbFile };
