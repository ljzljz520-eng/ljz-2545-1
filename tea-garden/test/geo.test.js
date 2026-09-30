'use strict';
const test = require('node:test');
const assert = require('node:assert');
const geo = require('../src/geo');
const { rect } = require('./helpers');

test('多边形面积与拆分面积守恒', () => {
  const sq = rect(0, 0, 100, 100);
  assert.equal(geo.areaOf(sq), 10000);
  const [l, r] = geo.splitByLine(sq, { x: 40, y: 0 }, { x: 40, y: 100 });
  assert.equal(geo.areaOf(l), 4000);
  assert.equal(geo.areaOf(r), 6000);
  assert.equal(geo.intersectionArea(l, r), 0);
});

test('相邻凸地块合并还原，重叠/分离被拒', () => {
  const sq = rect(0, 0, 100, 100);
  const [l, r] = geo.splitByLine(sq, { x: 40, y: 0 }, { x: 40, y: 100 });
  assert.equal(geo.areaOf(geo.mergeConvex(l, r)), 10000);
  const overlap = rect(30, 0, 120, 100);
  assert.throws(() => geo.mergeConvex(l, overlap), /重叠/);
  const far = rect(200, 0, 240, 100);
  assert.throws(() => geo.mergeConvex(l, far), /缝隙|非凸/);
});

test('日期半开区间：结束当天不与新区间重叠', () => {
  assert.equal(geo.datesOverlap('2024-01-01', '2024-06-01', '2024-06-01', null), false);
  assert.equal(geo.datesOverlap('2024-01-01', '2024-06-02', '2024-06-01', null), true);
  assert.equal(geo.datesOverlap('2025-01-01', null, '2020-01-01', '2021-01-01'), false);
});

test('坏切割线被拒（未贯穿）', () => {
  const sq = rect(0, 0, 100, 100);
  assert.throws(() => geo.splitByLine(sq, { x: 40, y: 10 }, { x: 40, y: 90 }), /BAD_CUT/);
});
