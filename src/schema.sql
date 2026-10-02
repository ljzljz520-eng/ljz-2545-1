-- 云栖茶园认养平台 · 空间版本化数据库
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- 农户
CREATE TABLE IF NOT EXISTS farmers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  bio TEXT NOT NULL DEFAULT '',
  phone_last4 TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 地块（逻辑实体，跨版本保持同一 id 与血缘）
CREATE TABLE IF NOT EXISTS plots (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  slope_zone TEXT,                  -- 山腰分区：云坞/青峰/栖霞
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 地块版本（空间数据库：每一次拆分/合并/纠偏都生成不可变新版本）
CREATE TABLE IF NOT EXISTS plot_versions (
  id INTEGER PRIMARY KEY,
  plot_id INTEGER NOT NULL REFERENCES plots(id),
  version_no INTEGER NOT NULL,
  parent_version_ids TEXT,         -- JSON 数组：本版本来源版本（拆分=1，合并=n，纠偏=1）
  event TEXT NOT NULL CHECK (event IN ('create','split','merge','correct')),
  geometry TEXT NOT NULL,          -- GeoJSON Polygon，茶园平面坐标（米）
  area_m2 REAL NOT NULL,
  valid_from TEXT NOT NULL,        -- 本边界生效日 YYYY-MM-DD
  valid_to TEXT,                   -- 失效日；NULL 表示当前边界
  note TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (plot_id, version_no)
);
CREATE INDEX IF NOT EXISTS idx_pv_plot ON plot_versions(plot_id);
CREATE INDEX IF NOT EXISTS idx_pv_validity ON plot_versions(valid_from, valid_to);

-- 拆分/合并/纠偏事件审计
CREATE TABLE IF NOT EXISTS plot_events (
  id INTEGER PRIMARY KEY,
  event TEXT NOT NULL,
  source_plot_ids TEXT NOT NULL,   -- JSON
  target_plot_ids TEXT NOT NULL,   -- JSON
  event_date TEXT NOT NULL,
  details TEXT DEFAULT '{}'
);

-- 认养（后台管理区间：日期段、份额策略、私有价格、认养人——不进入公开/送礼接口）
CREATE TABLE IF NOT EXISTS adoptions (
  id INTEGER PRIMARY KEY,
  plot_id INTEGER NOT NULL REFERENCES plots(id),
  version_id INTEGER NOT NULL REFERENCES plot_versions(id), -- 认养锚定的边界版本
  adopter_name TEXT NOT NULL,
  contact TEXT,
  period_start TEXT NOT NULL,
  period_end TEXT NOT NULL,
  area_m2 REAL NOT NULL,                       -- 认养面积（<= 当时边界面积）
  share_policy TEXT NOT NULL DEFAULT 'fixed'
      CHECK (share_policy IN ('fixed','redistribute')),
  price_amount INTEGER,                        -- 私有：人民币分
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','migrated')),
  note TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_ad_plot_period ON adoptions(plot_id, period_start, period_end);

-- 面积对应：拆分/合并后旧认养（原边界）与新版本之间的映射与未决差异
CREATE TABLE IF NOT EXISTS area_correspondences (
  id INTEGER PRIMARY KEY,
  event_id INTEGER NOT NULL REFERENCES plot_events(id),
  adoption_id INTEGER NOT NULL REFERENCES adoptions(id),
  old_version_id INTEGER NOT NULL REFERENCES plot_versions(id),
  new_version_id INTEGER NOT NULL REFERENCES plot_versions(id),
  policy TEXT NOT NULL CHECK (policy IN ('fixed','redistribute')),
  old_area_m2 REAL NOT NULL,
  mapped_area_m2 REAL NOT NULL,                -- 几何交集落在新边界内的面积
  pending_area_m2 REAL NOT NULL DEFAULT 0,     -- 未决差异（未对应到新边界的面积）
  status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending','resolved')),
  resolution_note TEXT DEFAULT '',
  resolved_by INTEGER REFERENCES users(id),
  resolved_at TEXT
);

-- 生长日记（离线客户端可带 client_uuid 幂等上送）
CREATE TABLE IF NOT EXISTS diaries (
  id INTEGER PRIMARY KEY,
  plot_id INTEGER NOT NULL REFERENCES plots(id),
  farmer_id INTEGER REFERENCES farmers(id),
  entry_date TEXT NOT NULL,
  body TEXT NOT NULL,
  weather TEXT,
  client_uuid TEXT UNIQUE,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_diary_plot_date ON diaries(plot_id, entry_date);

-- 采摘批次
CREATE TABLE IF NOT EXISTS picking_batches (
  id INTEGER PRIMARY KEY,
  plot_id INTEGER NOT NULL REFERENCES plots(id),
  code TEXT NOT NULL UNIQUE,
  picked_on TEXT NOT NULL,
  leaf_qty_kg REAL,
  grade TEXT,
  note TEXT DEFAULT ''
);

-- 采样批：只代表“声明范围”。绝不暗示整园。
CREATE TABLE IF NOT EXISTS sampling_batches (
  id INTEGER PRIMARY KEY,
  picking_batch_id INTEGER NOT NULL REFERENCES picking_batches(id),
  plot_id INTEGER NOT NULL REFERENCES plots(id),
  version_id INTEGER NOT NULL REFERENCES plot_versions(id), -- 采样时锚定的边界版本
  code TEXT NOT NULL UNIQUE,
  sampled_on TEXT NOT NULL,
  scope_claim TEXT NOT NULL,            -- 声明范围（如“P-07 2026-06-01 边界内采样点 3 处”）
  scope_geometry TEXT,                  -- GeoJSON：实际采样点/子范围
  lab TEXT,
  result_summary TEXT,
  result_at TEXT
);

-- 检测附件：对象层归档。文件在 data/objects，元数据在库；可撤回（逻辑+物理删除）。
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY,
  object_key TEXT NOT NULL UNIQUE,
  filename TEXT NOT NULL,
  mime TEXT,
  bytes INTEGER,
  kind TEXT NOT NULL DEFAULT 'test_report'
      CHECK (kind IN ('test_report','diary_photo','other')),
  sampling_batch_id INTEGER REFERENCES sampling_batches(id),
  diary_id INTEGER REFERENCES diaries(id),
  status TEXT NOT NULL DEFAULT 'archived' CHECK (status IN ('archived','withdrawn')),
  withdrawn_reason TEXT,
  withdrawn_by INTEGER REFERENCES users(id),
  withdrawn_at TEXT,
  uploaded_by INTEGER REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 送礼分享：独立权限（gift token），与登录会话分离；可过期；视图字段在服务端裁剪
CREATE TABLE IF NOT EXISTS share_links (
  id INTEGER PRIMARY KEY,
  token TEXT NOT NULL UNIQUE,
  plot_id INTEGER NOT NULL REFERENCES plots(id),
  gift_message TEXT DEFAULT '',
  created_by INTEGER REFERENCES users(id),
  expires_at TEXT NOT NULL,            -- ISO 时间
  revoked INTEGER NOT NULL DEFAULT 0,
  max_views INTEGER,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 用户/会话
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  username TEXT NOT NULL UNIQUE,
  password TEXT NOT NULL,              -- demo：本地口令（非生产强度）
  role TEXT NOT NULL DEFAULT 'staff' CHECK (role IN ('admin','staff')),
  display_name TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 编辑占用锁（并发占用冲突：进入编辑即租约锁定该版本）
CREATE TABLE IF NOT EXISTS edit_locks (
  version_id INTEGER PRIMARY KEY REFERENCES plot_versions(id),
  user_id INTEGER NOT NULL REFERENCES users(id),
  lease_until TEXT NOT NULL
);
