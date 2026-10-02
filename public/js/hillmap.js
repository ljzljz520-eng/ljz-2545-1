// 坡地地图：SVG 渲染 GeoJSON 多边形，支持平移/缩放、时间轴回放、地块点击
export class HillMap {
  constructor(svg, { onPick } = {}) {
    this.svg = svg;
    this.onPick = onPick || (() => {});
    this.view = { x: 0, y: 0, k: 1 };
    this.features = [];
    this.adopted = {}; // plot_id -> [{start,end}]
    this._bind();
  }

  setFeatures(features) {
    this.features = features;
    if (!this._fitted) { this.fit(features); this._fitted = true; }
    this.render();
  }
  setAdopted(map) { this.adopted = map || {}; this.render(); }

  fit(features) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const f of features) for (const [x, y] of f.geometry.coordinates[0]) {
      if (x < minX) minX = x; if (y < minY) minY = y;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y;
    }
    if (!isFinite(minX)) { minX = -60; minY = 0; maxX = 260; maxY = 200; }
    const w = this.svg.clientWidth || 1000, h = this.svg.clientHeight || 560;
    const pad = 50;
    const k = Math.min((w - pad * 2) / (maxX - minX), (h - pad * 2) / (maxY - minY));
    this.view = { k, x: (w - k * (minX + maxX)) / 2, y: (h - k * (minY + maxY)) / 2 };
  }

  project([x, y]) {
    return [x * this.view.k + this.view.x, y * this.view.k + this.view.y];
  }
  unproject([sx, sy]) {
    return [(sx - this.view.x) / this.view.k, (sy - this.view.y) / this.view.k];
  }

  _color(f) {
    const zones = { '云坞': '#cfe3bd', '青峰': '#bcd8a0', '栖霞': '#e2c9a3' };
    return zones[f.slope_zone] || '#cdddb9';
  }

  render() {
    const ns = 'http://www.w3.org/2000/svg';
    this.svg.innerHTML = '';
    const root = document.createElementNS(ns, 'g');
    root.setAttribute('transform', `translate(${this.view.x},${this.view.y}) scale(${this.view.k})`);
    // 坡面等高线装饰
    this._decor(root, ns);
    for (const f of this.features) {
      const pts = f.geometry.coordinates[0].map(p => p.join(',')).join(' ');
      const poly = document.createElementNS(ns, 'polygon');
      poly.setAttribute('points', pts);
      poly.setAttribute('class', 'plot' + (f.plot_status === 'superseded' ? ' superseded' : ''));
      poly.setAttribute('fill', this._color(f));
      poly.addEventListener('click', () => this.onPick(f));
      poly.addEventListener('title', () => {});
      const title = document.createElementNS(ns, 'title');
      title.textContent = `${f.plot_name}（${f.code}）· v${f.version_no} · ${f.area_m2}㎡`;
      poly.appendChild(title);
      root.appendChild(poly);
      // 名称标签放形心
      const c = this._centroid(f.geometry.coordinates[0]);
      const t = document.createElementNS(ns, 'text');
      t.setAttribute('x', c[0]); t.setAttribute('y', c[1]);
      t.setAttribute('class', 'plot-label');
      t.textContent = `${f.code} ${f.plot_name}`;
      root.appendChild(t);
      const t2 = document.createElementNS(ns, 'text');
      t2.setAttribute('x', c[0]); t2.setAttribute('y', c[1] + 13);
      t2.setAttribute('class', 'plot-label');
      t2.textContent = `v${f.version_no} · ${(f.area_m2 / 666.67).toFixed(1)}亩`;
      root.appendChild(t2);
    }
    this.svg.appendChild(root);
  }

  _decor(root, ns) {
    // 山坡纹理：几条横向弧状等高线（随地块外框范围）
    let minX = -60, maxX = 260, minY = 0, maxY = 200;
    for (const f of this.features) for (const [x, y] of f.geometry.coordinates[0]) {
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    for (let i = 1; i < 6; i++) {
      const y = minY + (maxY - minY) * i / 6;
      const path = document.createElementNS(ns, 'path');
      path.setAttribute('d', `M ${minX} ${y} Q ${(minX + maxX) / 2} ${y - 6} ${maxX} ${y}`);
      path.setAttribute('stroke', 'rgba(80,110,70,.18)'); path.setAttribute('stroke-width', '1.2');
      path.setAttribute('fill', 'none');
      root.appendChild(path);
    }
  }

  _centroid(ring) {
    let x = 0, y = 0;
    const r = ring.slice(0, -1);
    for (const p of r) { x += p[0]; y += p[1]; }
    return [x / r.length, y / r.length];
  }

  _bind() {
    let drag = null;
    this.svg.addEventListener('pointerdown', e => {
      drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y };
      this.svg.setPointerCapture(e.pointerId);
    });
    this.svg.addEventListener('pointermove', e => {
      if (!drag) return;
      this.view.x = drag.vx + e.clientX - drag.x;
      this.view.y = drag.vy + e.clientY - drag.y;
      this.render();
    });
    const end = () => { drag = null; };
    this.svg.addEventListener('pointerup', end);
    this.svg.addEventListener('pointerleave', end);
    this.svg.addEventListener('wheel', e => {
      e.preventDefault();
      const rect = this.svg.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const f = e.deltaY < 0 ? 1.12 : 0.89;
      const k2 = Math.min(40, Math.max(0.2, this.view.k * f));
      this.view.x = mx - (mx - this.view.x) * (k2 / this.view.k);
      this.view.y = my - (my - this.view.y) * (k2 / this.view.k);
      this.view.k = k2;
      this.render();
    }, { passive: false });
  }
}
