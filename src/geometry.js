'use strict';
// 轻量平面几何：面积 / 点在环内 / 耳切法三角化 / Sutherland-Hodgman 裁剪 /
// 多边形相交面积 / 按裁剪线拆分 / 共边合并。
// 坐标约定：ring = [[x,y], ...]（开环，首尾不重复）；本系统统一 CCW（逆时针为正）。

const EPS = 1e-9;

function cross(ax, ay, bx, by) { return ax * by - ay * bx; }

function signedArea(ring) {
  let s = 0;
  for (let i = 0; i < ring.length; i++) {
    const [x1, y1] = ring[i];
    const [x2, y2] = ring[(i + 1) % ring.length];
    s += cross(x1, y1, x2, y2);
  }
  return s / 2;
}
const area = (ring) => Math.abs(signedArea(ring));

function ensureCCW(ring) {
  return signedArea(ring) < 0 ? ring.slice().reverse() : ring;
}
function ensureCW(ring) {
  return signedArea(ring) > 0 ? ring.slice().reverse() : ring;
}

function pointInRing(p, ring) {
  const [x, y] = p;
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    const hit = ((yi > y) !== (yj > y)) &&
      (x < (xj - xi) * (y - yi) / ((yj - yi) || EPS) + xi);
    if (hit) inside = !inside;
  }
  return inside;
}

// ---- 耳切法（无洞多边形，足够本系统小顶点数）----
function triangulate(ring) {
  const poly = ensureCCW(ring.map(p => [p[0], p[1]]));
  const n = poly.length;
  if (n < 3) return [];
  if (n === 3) return [poly];
  const indices = poly.map((_, i) => i);
  const triangles = [];
  let guard = n * n * 2;
  while (indices.length > 3 && guard-- > 0) {
    let earFound = false;
    for (let k = 0; k < indices.length; k++) {
      const i0 = indices[(k - 1 + indices.length) % indices.length];
      const i1 = indices[k];
      const i2 = indices[(k + 1) % indices.length];
      const a = poly[i0], b = poly[i1], c = poly[i2];
      if (cross(b[0] - a[0], b[1] - a[1], c[0] - a[0], c[1] - a[1]) <= EPS) continue;
      let hasPointInside = false;
      for (const idx of indices) {
        if (idx === i0 || idx === i1 || idx === i2) continue;
        if (pointInTri(poly[idx], a, b, c)) { hasPointInside = true; break; }
      }
      if (hasPointInside) continue;
      triangles.push([a, b, c]);
      indices.splice(k, 1);
      earFound = true;
      break;
    }
    if (!earFound) break; // 退化保护
  }
  if (indices.length === 3) {
    triangles.push(indices.map(i => poly[i]));
  }
  return triangles;
}

function pointInTri(p, a, b, c) {
  const d1 = sign(p, a, b), d2 = sign(p, b, c), d3 = sign(p, c, a);
  const hasNeg = d1 < -EPS || d2 < -EPS || d3 < -EPS;
  const hasPos = d1 > EPS || d2 > EPS || d3 > EPS;
  return !(hasNeg && hasPos);
}
function sign(p, a, b) {
  return (p[0] - b[0]) * (a[1] - b[1]) - (a[0] - b[0]) * (p[1] - b[1]);
}

// ---- Sutherland-Hodgman：subject 环 被 clip 环（CCW）裁剪 ----
function clipRing(subject, clip) {
  const cp = ensureCCW(clip);
  let output = subject.slice();
  for (let i = 0; i < cp.length; i++) {
    if (output.length === 0) break;
    const a = cp[i];
    const b = cp[(i + 1) % cp.length];
    const input = output;
    output = [];
    const edge = [b[0] - a[0], b[1] - a[1]];
    for (let j = 0; j < input.length; j++) {
      const S = input[(j - 1 + input.length) % input.length];
      const E = input[j];
      const insideS = cross(edge[0], edge[1], S[0] - a[0], S[1] - a[1]) >= -EPS;
      const insideE = cross(edge[0], edge[1], E[0] - a[0], E[1] - a[1]) >= -EPS;
      if (insideE) {
        if (!insideS) output.push(segIntersect(S, E, a, b));
        output.push(E);
      } else if (insideS) {
        output.push(segIntersect(S, E, a, b));
      }
    }
  }
  return dedup(output);
}

function segIntersect(p1, p2, p3, p4) {
  const x1 = p1[0], y1 = p1[1], x2 = p2[0], y2 = p2[1];
  const x3 = p3[0], y3 = p3[1], x4 = p4[0], y4 = p4[1];
  const d = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4);
  const t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / (d || EPS);
  return [x1 + t * (x2 - x1), y1 + t * (y2 - y1)];
}

function dedup(ring) {
  const out = [];
  for (const p of ring) {
    const q = out[out.length - 1];
    if (!q || Math.abs(q[0] - p[0]) > EPS || Math.abs(q[1] - p[1]) > EPS) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0], z = out[out.length - 1];
    if (Math.abs(a[0] - z[0]) <= EPS && Math.abs(a[1] - z[1]) <= EPS) out.pop();
  }
  return out;
}

// 两多边形相交面积：A 三角化后逐三角形裁入 B
function intersectionArea(ringA, ringB) {
  const tris = triangulate(ringA);
  let sum = 0;
  for (const t of tris) {
    const piece = clipRing(t, ensureCCW(ringB));
    if (piece.length >= 3) sum += area(piece);
  }
  return sum;
}

// 按直线 p->q 拆分：返回 [left, right]，均 CCW。直接对半平面做单边裁剪。
function splitByLine(subject, p, q) {
  const edge = [q[0] - p[0], q[1] - p[1]];
  const half = (keepLeft) => {
    const inside = (pt) => {
      const c = cross(edge[0], edge[1], pt[0] - p[0], pt[1] - p[1]);
      return keepLeft ? c >= -EPS : c <= EPS;
    };
    const input = ensureCCW(subject).slice();
    const output = [];
    for (let j = 0; j < input.length; j++) {
      const S = input[(j - 1 + input.length) % input.length];
      const E = input[j];
      const iS = inside(S), iE = inside(E);
      if (iE) {
        if (!iS) output.push(segIntersect(S, E, p, q));
        output.push(E);
      } else if (iS) {
        output.push(segIntersect(S, E, p, q));
      }
    }
    return ensureCCW(dedup(output));
  };
  return [half(true), half(false)].map((ring) => snapToLine(ring, p, q));
}

// 把几乎落在切线上的顶点吸附到切线（进/出两条邻边算出的交点可能有 ~1e-10 抖动），
// 保证拆分两侧的缝边逐点相同，才能精确合并还原。
function snapToLine(ring, p, q) {
  const dx = q[0] - p[0], dy = q[1] - p[1];
  const len2 = dx * dx + dy * dy || 1;
  return ring.map(pt => {
    const t = ((pt[0] - p[0]) * dx + (pt[1] - p[1]) * dy) / len2;
    const projX = p[0] + t * dx, projY = p[1] + t * dy;
    const d = Math.hypot(pt[0] - projX, pt[1] - projY);
    // 仅吸附裁剪生成的交点（浮点抖动 ~1e-10），原多边形顶点距离切线远大于此
    return d < 1e-7 ? [projX, projY] : pt;
  });
}

// 共边合并：两 CCW 环沿方向相反的重合边缝合。返回新环或 null。
function mergeRings(ringA, ringB) {
  const a = ensureCCW(ringA), b = ensureCCW(ringB);
  const same = (u, v) => Math.abs(u[0] - v[0]) <= 1e-6 && Math.abs(u[1] - v[1]) <= 1e-6;
  // 找反向重合的边缝
  let ia = -1, ib = -1;
  for (let i = 0; i < a.length && ia < 0; i++) {
    for (let j = 0; j < b.length; j++) {
      if (same(a[i], b[(j + 1) % b.length]) && same(a[(i + 1) % a.length], b[j])) {
        ia = i; ib = j; break;
      }
    }
  }
  if (ia < 0) return null;
  // A: u=a[ia] -> v=a[ia+1]；B: v=b[ib] -> u=b[ib+1]
  // 路径从 v 出发，沿 A 走到 u，再沿 B 从 u 的下一个点走回 v
  const out = [a[(ia + 1) % a.length]]; // v
  for (let k = (ia + 2) % a.length; k !== ia; k = (k + 1) % a.length) out.push(a[k]);
  out.push(a[ia]); // u
  for (let k = (ib + 2) % b.length; k !== ib; k = (k + 1) % b.length) out.push(b[k]);
  return ensureCCW(dedup(out));
}

function validateRing(ring) {
  if (!Array.isArray(ring) || ring.length < 3) throw new Error('多边形至少需要 3 个顶点');
  for (const p of ring) {
    if (!Array.isArray(p) || p.length !== 2 || p.some(n => typeof n !== 'number' || !isFinite(n))) {
      throw new Error('顶点必须为 [x, y] 数值对');
    }
  }
  if (area(ring) < 1) throw new Error('多边形面积过小（至少 1 平方米）');
}

module.exports = {
  area, signedArea, ensureCCW, ensureCW, pointInRing,
  triangulate, clipRing, intersectionArea, splitByLine,
  mergeRings, validateRing, dedup
};
