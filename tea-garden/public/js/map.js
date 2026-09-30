'use strict';
// 自研 SVG 山坡地图：米制坐标 -> 屏幕坐标，带等高线、指北针、比例尺、认养占用条纹。
const TeaMap = (() => {
  const W = 880, H = 620, PAD = 70;
  const FILLS = ['#bcd49b', '#a8c79e', '#d4c08a', '#9ec3b0', '#c9b699', '#b7c77f'];

  function project(parcels) {
    const all = parcels.flatMap(p => p.geometry.coordinates[0]);
    const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const s = Math.min((W - 2 * PAD) / (maxX - minX), (H - 2 * PAD) / (maxY - minY));
    return { tx: x => PAD + (x - minX) * s, ty: y => PAD + (y - minY) * s, s, minX, minY };
  }

  function ringPath(geom, P) {
    const pts = geom.coordinates[0];
    return pts.map(([x, y], i) => (i ? 'L' : 'M') + P.tx(x).toFixed(1) + ' ' + P.ty(y).toFixed(1)).join(' ') + ' Z';
  }
  function labelPos(geom, P) {
    // 简单质心
    const pts = geom.coordinates[0].slice(0, -1);
    let a = 0, cx = 0, cy = 0;
    for (let i = 0; i < pts.length; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[(i + 1) % pts.length];
      const c = x0 * y1 - x1 * y0; a += c; cx += (x0 + x1) * c; cy += (y0 + y1) * c;
    }
    a /= 2;
    return { x: P.tx(cx / (6 * a || 1)), y: P.ty(cy / (6 * a || 1)) };
  }

  // 装饰性等高线（不参与计算，只表达山坡地貌）
  function contours(P) {
    const lines = [];
    for (let i = 0; i < 7; i++) {
      const y = 40 + i * 82;
      let d = `M ${PAD - 30} ${P.ty(y)}`;
      for (let x = 80; x <= 760; x += 60) d += ` Q ${P.tx(x)} ${P.ty(y - 26 - (i % 2) * 10)}, ${P.tx(x + 60)} ${P.ty(y)}`;
      lines.push(`<path class="contour" d="${d}"/>`);
    }
    return lines.join('');
  }

  function occupancyBar(p) {
    const ratio = Math.min(1, (p.used || 0) / p.area);
    const w = 74, x = -w / 2;
    const color = p.used > p.area ? '#b04a3a' : '#3d6b43';
    return `<rect x="${x}" y="12" width="${w}" height="6" rx="3" fill="#ffffff" stroke="#b8c3a8"/>
      <rect x="${x}" y="12" width="${(w * ratio).toFixed(1)}" height="6" rx="3" fill="${color}"/>`;
  }

  function render(container, { date, parcels, selectedId, onSelect }) {
    const P = project(parcels);
    const svg = [`<svg viewBox="0 0 ${W} ${H}" width="100%" role="img" aria-label="山坡地块地图，当前时段 ${esc(date)}">`];
    svg.push(contours(P));
    parcels.forEach((p, i) => {
      const d = ringPath(p.geometry, P);
      const c = labelPos(p.geometry, P);
      const over = p.used > p.area + 1e-6;
      const fill = over ? '#e3b7ae' : FILLS[i % FILLS.length];
      svg.push(`<g class="parcel ${selectedId === p.parcelId ? 'selected' : ''}" data-id="${p.parcelId}">`);
      svg.push(`<path d="${d}" fill="${fill}" fill-opacity=".9" stroke="#38552f" stroke-width="2"/>`);
      // 已认养面积用斜纹叠加表示占比
      if (p.used > 0) {
        const ratio = Math.min(1, p.used / p.area);
        svg.push(`<clipPath id="clip-${p.parcelId}"><path d="${d}"/></clipPath>`);
        svg.push(`<g clip-path="url(#clip-${p.parcelId})" opacity=".28">
          <rect x="0" y="0" width="${W * ratio}" height="${H}" fill="url(#hatch)"/></g>`);
      }
      svg.push(`<text class="parcel-label" x="${c.x}" y="${c.y - 6}">${esc(p.code)} · ${esc(p.name)}</text>`);
      svg.push(`<text class="parcel-sub" x="${c.x}" y="${c.y + 10}">v${p.version}｜${p.area.toLocaleString()}㎡｜已认 ${p.used.toLocaleString()}㎡</text>`);
      svg.push(`<g transform="translate(${c.x},${c.y})">${occupancyBar(p)}</g>`);
      svg.push(`</g>`);
    });
    // 指北针
    svg.push(`<g transform="translate(44,56)"><path d="M0,-18 L7,12 L0,5 L-7,12 Z" fill="#3d6b43"/>
      <text class="compass" y="-24">N</text></g>`);
    // 比例尺（50m）
    const sb = 50 * P.s;
    svg.push(`<g transform="translate(${W - PAD - sb},${H - 34})">
      <line x1="0" y1="0" x2="${sb}" y2="0" stroke="#5f7057" stroke-width="3"/>
      <line x1="0" y1="-5" x2="0" y2="5" stroke="#5f7057" stroke-width="2"/>
      <line x1="${sb}" y1="-5" x2="${sb}" y2="5" stroke="#5f7057" stroke-width="2"/>
      <text class="scalebar" x="${sb / 2}" y="-8" text-anchor="middle">50 米（局部米制坐标，非地理投影）</text></g>`);
    // 斜纹 pattern
    svg.push(`<defs><pattern id="hatch" width="10" height="10" patternTransform="rotate(45)" patternUnits="userSpaceOnUse">
      <rect width="10" height="10" fill="#3d6b43"/><line x1="0" y1="0" x2="0" y2="10" stroke="#2c4f30" stroke-width="4"/>
      </pattern></defs>`);
    svg.push(`</svg>`);
    container.innerHTML = svg.join('');
    container.querySelectorAll('.parcel').forEach(g => {
      g.addEventListener('click', () => onSelect(+g.dataset.id));
    });
    return P;
  }
  return { render };
})();
