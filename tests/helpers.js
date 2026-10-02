'use strict';
// 每个测试文件独立内存库，避免相互污染
process.env.TEA_DB = ':memory:';
const { getDb, resetDb } = require('../src/db');
const auth = require('../src/auth');
const plotSvc = require('../src/plotService');
const adoptSvc = require('../src/adoptionService');
const farmSvc = require('../src/farmService');
const geo = require('../src/geometry');

function setup() {
  const db = getDb();
  resetDb(db);
  const adminId = db.prepare("INSERT INTO users(username,password,role,display_name) VALUES('admin',?,'admin','管理员')")
    .run(auth.hashPassword('pw')).lastInsertRowid;
  const staffId = db.prepare("INSERT INTO users(username,password,role,display_name) VALUES('staff',?,'staff','运营')")
    .run(auth.hashPassword('pw')).lastInsertRowid;
  return { db, admin: { id: adminId, role: 'admin' }, staff: { id: staffId, role: 'staff' } };
}
const RECT = (x0, y0, x1, y1) => ({ type: 'Polygon', coordinates: [[[x0, y0], [x1, y0], [x1, y1], [x0, y1]]] });

module.exports = { setup, getDb, auth, plotSvc, adoptSvc, farmSvc, geo, RECT };
