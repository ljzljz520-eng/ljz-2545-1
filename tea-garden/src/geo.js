'use strict';
// 茶园局部米制坐标系下的平面几何工具（无需 PostGIS，几何算法自持）。
// 约定：所有多边形为简单多边形，外环逆时针/顺时针均可；裁剪窗口为凸多边形。

const EPS = 1e-9;
const FUTURE = '9999-12-31';

function parse(geom) {
  if (typeof geom === 'string') geom = JSON.parse(geom);
  if (!geom || geom.type !== 'Polygon' || !Array.isArray(geom.coordinates)) {
    throw new Error('BAD_GEOMETRY: 需要 GeoJSON Polygon');
  }
  const ring = geom.coordinates[0];
  if (!ring || ring.length < 4) throw new Error('BAD_GEOMETRY: 外环至少 3 个点');
  // 规范化：去掉闭合重复点
  const pts = ring.slice(0, -1).map(([x, y]) => ({ x: +x, y: +y }));
  if (pts.length < 3) throw new Error('BAD_GEOMETRY: 有效点数不足');
  return pts;
}
function geojson(pts) {
  const ring = pts.map(p => [round(p.x), round(p.y)]);
  ring.push([round(pts[0].x), round(pts[0].y)]);
  return { type: 'Polygon', coordinates: [ring] };
}
const round = v => Math.round(v * 1000) / 1000;

function signedArea(pts) {
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    s += a.x * b.y - b.x * a.y;
  }
  return s / 2;
}
function area(pts) { return Math.abs(signedArea(pts)); }
function areaOf(geom) { return area(parse(geom)); }

function centroid(pts) {
  let a = 0, cx = 0, cy = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const cross = p.x * q.y - q.x * p.y;
    a += cross; cx += (p.x + q.x) * cross; cy += (p.y + q.y) * cross;
  }
  a /= 2;
  if (Math.abs(a) < EPS) {
    const m = pts.reduce((o, p) => ({ x: o.x + p.x, y: o.y + p.y }), { x: 0, y: 0 });
    return { x: m.x / pts.length, y: m.y / pts.length };
  }
  return { x: cx / (6 * a), y: cy / (6 * a) };
}

function bbox(pts) {
  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}
function bboxesOverlap(a, b) {
  return !(a.maxX <= b.minX || b.maxX <= a.minX || a.maxY <= b.minY || b.maxY <= a.minY);
}

function pointInPoly(p, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const a = pts[i], b = pts[j];
    if (((a.y > p.y) !== (b.y > p.y)) &&
        (p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y + EPS) + a.x)) inside = !inside;
  }
  return inside;
}

// 线段交点
function segIntersect(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < EPS) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  const u = ((p3.x - p1.x) * (p2.y - p1.y) - (p3.y - p1.y) * (p2.x - p1.x)) / d;
  if (t < -EPS || t > 1 + EPS || u < -EPS || u > 1 + EPS) return null;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y), t, u };
}

// ---- Sutherland–Hodgman：用凸裁剪多边形逐边裁剪主体 ----
function clipEdge(subject, a, b) {
  // 保留位于有向边 a->b 左侧（含线上）的点
  const inside = p => cross(a, b, p) >= -EPS;
  const out = [];
  for (let i = 0; i < subject.length; i++) {
    const cur = subject[i], prev = subject[(i + subject.length - 1) % subject.length];
    const cin = inside(cur), pin = inside(prev);
    if (cin) {
      if (!pin) {
        const inter = lineIntersection(prev, cur, a, b);
        if (inter) out.push(inter);
      }
      out.push(cur);
    } else if (pin) {
      const inter = lineIntersection(prev, cur, a, b);
      if (inter) out.push(inter);
    }
  }
  return dedup(out);
}
function cross(a, b, p) {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}
function lineIntersection(p1, p2, p3, p4) {
  const d = (p2.x - p1.x) * (p4.y - p3.y) - (p2.y - p1.y) * (p4.x - p3.x);
  if (Math.abs(d) < EPS) return null;
  const t = ((p3.x - p1.x) * (p4.y - p3.y) - (p3.y - p1.y) * (p4.x - p3.x)) / d;
  return { x: p1.x + t * (p2.x - p1.x), y: p1.y + t * (p2.y - p1.y) };
}
function dedup(pts) {
  const out = [];
  for (const p of pts) {
    const q = out[out.length - 1];
    if (!q || Math.hypot(p.x - q.x, p.y - q.y) > 1e-6) out.push(p);
  }
  if (out.length > 1) {
    const a = out[0], z = out[out.length - 1];
    if (Math.hypot(a.x - z.x, a.y - z.y) < 1e-6) out.pop();
  }
  return out;
}

// 两多边形交集面积（clip 需凸；本系统地块均为凸四边形）
function intersectionArea(geomA, geomB) {
  const a = parse(geomA), b = parse(geomB);
  if (!bboxesOverlap(bbox(a), bbox(b))) return 0;
  let subj = a;
  const win = signedArea(b) > 0 ? b : b.slice().reverse(); // SH 要求窗口逆时针
  for (let i = 0; i < win.length; i++) {
    subj = clipEdge(subj, win[i], win[(i + 1) % win.length]);
    if (subj.length < 3) return 0;
  }
  return area(subj);
}

// 按有向直线 p1->p2 拆分多边形，返回 [左侧, 右侧]
function splitByLine(geom, p1, p2) {
  const pts = parse(geom);
  // 先校验切割【线段】确实贯穿多边形：与边界环有两个落在切割线段内的交点
  let crossings = 0;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const hit = segIntersect(p1, p2, a, b);
    if (hit && hit.t > 1e-9 && hit.t < 1 - 1e-9) crossings++;
    else if (hit) { crossings = 2; break; } // 端点接触按贯穿处理
  }
  if (crossings < 2) throw new Error('BAD_CUT: 切割线必须贯穿地块（切割线段与边界交于两点）');
  const left = clipEdge(pts, p1, p2);
  const right = clipEdge(pts, p2, p1);
  if (left.length < 3 || right.length < 3) {
    throw new Error('BAD_CUT: 切割线必须贯穿地块，且两侧均有面积');
  }
  if (Math.abs(area(left) + area(right) - area(pts)) > 0.05) {
    throw new Error('BAD_CUT: 拆分面积与原地块不一致');
  }
  return [geojson(left), geojson(right)];
}

// 凸包（Andrew monotone chain）
function convexHull(points) {
  const p = dedup(points.slice()).sort((a, b) => a.x - b.x || a.y - b.y);
  if (p.length <= 1) return p;
  const lower = [];
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= EPS) lower.pop();
    lower.push(q);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const q = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= EPS) upper.pop();
    upper.push(q);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

// 合并：仅当两块不重叠且其并集为凸（凸包面积≈面积和）才允许，避免吞缝或自交
function mergeConvex(geomA, geomB) {
  const a = parse(geomA), b = parse(geomB);
  const inter = intersectionArea(geomA, geomB);
  const sum = area(a) + area(b);
  if (inter > 0.5) throw new Error('BAD_MERGE: 地块存在重叠，不能合并');
  const hull = convexHull(a.concat(b));
  if (hull.length < 3) throw new Error('BAD_MERGE: 合并后多边形无效');
  const hullArea = area(hull);
  if (hullArea - sum > 0.5) {
    throw new Error('BAD_MERGE: 两地块不相邻或并集非凸（凸包含缝隙），拒绝合并');
  }
  return geojson(hull);
}

// ---- 日期半开区间 [start,end)：end=null 视为远期 ----
function datesOverlap(s1, e1, s2, e2) {
  const end1 = e1 || FUTURE, end2 = e2 || FUTURE;
  return s1 < end2 && s2 < end1;
}
function overlapDays(s1, e1, s2, e2) {
  const lo = s1 < s2 ? s2 : s1;
  const hi = (e1 || FUTURE) < (e2 || FUTURE) ? (e1 || FUTURE) : (e2 || FUTURE);
  return lo < hi ? Math.round((Date.parse(hi) - Date.parse(lo)) / 86400000) : 0;
}

module.exports = {
  EPS, FUTURE, parse, geojson, signedArea, area, areaOf, centroid, bbox,
  pointInPoly, segIntersect, intersectionArea, splitByLine, convexHull,
  mergeConvex, datesOverlap, overlapDays,
};
