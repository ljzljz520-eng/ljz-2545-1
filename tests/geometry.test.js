'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const g = require('../src/geometry');

test('多边形面积（矩形与三角形）', () => {
  assert.equal(g.area([[0, 0], [10, 0], [10, 10], [0, 10]]), 100);
  assert.equal(g.area([[0, 0], [10, 0], [0, 10]]), 50);
});

test('ensureCCW 统一方向', () => {
  const cw = [[0, 0], [0, 10], [10, 10], [10, 0]];
  assert.ok(g.signedArea(g.ensureCCW(cw)) > 0);
});

test('相交面积：重叠一半与不相交', () => {
  const A = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const B = [[5, 0], [15, 0], [15, 10], [5, 10]];
  assert.equal(g.intersectionArea(A, B), 50);
  const C = [[20, 20], [30, 20], [30, 30], [20, 30]];
  assert.equal(g.intersectionArea(A, C), 0);
});

test('拆分面积守恒，且可缝合还原', () => {
  const A = [[0, 0], [120, 0], [120, 90], [0, 90]];
  const [l, r] = g.splitByLine(A, [60, -10], [60, 110]);
  assert.equal(Math.round(g.area(l)), 5400);
  assert.equal(Math.round(g.area(r)), 5400);
  const back = g.mergeRings(l, r);
  assert.ok(back);
  assert.equal(Math.round(g.area(back)), 10800);
});

test('拆分两侧缝边逐点一致（吸附后）', () => {
  const A = [[0, 0], [120, 0], [120, 90], [0, 90]];
  const [l, r] = g.splitByLine(A, [60, -10], [60, 110]);
  // 西坡东边与东坡西边应能精确配对
  assert.ok(g.mergeRings(l, r), '缝边必须可合并');
});

test('无共边的两个多边形不能合并', () => {
  const A = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const B = [[50, 50], [60, 50], [60, 60], [50, 60]];
  assert.equal(g.mergeRings(A, B), null);
});

test('裁剪凸多边形得到正确子区域', () => {
  const A = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const B = [[5, -5], [15, -5], [15, 15], [5, 15]];
  assert.equal(Math.round(g.intersectionArea(A, B)), 50);
});

test('validateRing 拒绝非法输入', () => {
  assert.throws(() => g.validateRing([[0, 0], [1, 1]]), /多边形至少需要 3 个顶点/);
  assert.throws(() => g.validateRing([[0, 0], ['x', 1], [1, 1]]), /数值对/);
});
