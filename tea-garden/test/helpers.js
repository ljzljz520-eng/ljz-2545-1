'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { openDb, initSchema } = require('../src/db');
const store = require('../src/store');

const SQ = (...pts) => ({ type: 'Polygon', coordinates: [[...pts, pts[0]]] });
const rect = (x0, y0, x1, y1) => SQ([x0, y0], [x1, y0], [x1, y1], [x0, y1]);

function freshEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tea-test-'));
  const dbFile = path.join(dir, 't.db');
  process.env.TEA_DB_FILE = dbFile;
  process.env.TEA_DATA_DIR = dir;
  const db = openDb(dbFile);
  initSchema(db);
  return { db, dir };
}

// 基础世界：A = 100x100 矩形（2023-01-01），2024-03-01 沿 x=40 竖切为 A1(40 宽)/A2(60 宽)
function buildWorld(db, { adoptBefore = null } = {}) {
  store.createParcel(db, { code: 'A', name: 'old', geometry: rect(0, 0, 100, 100), validFrom: '2023-01-01' });
  if (adoptBefore) {
    store.createAdoption(db, { parcelId: 1, expectedVersion: 1, label: adoptBefore.label, mode: adoptBefore.mode,
      area: adoptBefore.area, startDate: '2023-05-01', endDate: adoptBefore.endDate || null });
  }
  store.splitParcel(db, { parcelId: 1, expectedVersion: 1,
    cut: { p1: { x: 40, y: 0 }, p2: { x: 40, y: 100 } },
    children: [{ code: 'A1', name: 'west' }, { code: 'A2', name: 'east' }],
    validFrom: '2024-03-01' });
  return db;
}

module.exports = { freshEnv, buildWorld, rect, SQ, store };
