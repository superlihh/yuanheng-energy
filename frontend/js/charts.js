(function () {
  'use strict';

  const NS = 'http://www.w3.org/2000/svg';
  const MONO = "'IBM Plex Mono', Consolas, monospace";
  const SANS = "'Noto Sans SC','Microsoft YaHei',sans-serif";
  const C = {
    amber: '#f2b04a',
    lime: '#bcd47c',
    red: '#e2675b',
    steel: '#86b6c0',
    text: '#ece5d4',
    muted: '#8a8779',
    dim: '#5f5d52',
    grid: 'rgba(236,229,212,.055)',
    line: 'rgba(236,229,212,.09)'
  };

  function make(tag, attrs, text) {
    const n = document.createElementNS(NS, tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (attrs[k] !== null && attrs[k] !== undefined) n.setAttribute(k, attrs[k]);
    });
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }
  function add(parent, tag, attrs, text) {
    const n = make(tag, attrs, text);
    parent.appendChild(n);
    return n;
  }
  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function fmtTime(i) {
    const h = Math.floor(i / 4), m = (i % 4) * 15;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }
  function range(i) {
    const e = i + 1, h = Math.floor(e / 4), m = (e % 4) * 15;
    return fmtTime(i) + '–' + (h === 24 ? '24:00' : String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0'));
  }
  function smooth(points) {
    if (points.length < 2) return '';
    let d = 'M ' + points[0][0].toFixed(2) + ',' + points[0][1].toFixed(2);
    for (let i = 0; i < points.length - 1; i++) {
      const p0 = points[i - 1] || points[i];
      const p1 = points[i];
      const p2 = points[i + 1];
      const p3 = points[i + 2] || p2;
      const c1x = p1[0] + (p2[0] - p0[0]) / 6;
      const c1y = p1[1] + (p2[1] - p0[1]) / 6;
      const c2x = p2[0] - (p3[0] - p1[0]) / 6;
      const c2y = p2[1] - (p3[1] - p1[1]) / 6;
      d += ' C ' + c1x.toFixed(2) + ',' + c1y.toFixed(2) + ' ' + c2x.toFixed(2) + ',' + c2y.toFixed(2) + ' ' + p2[0].toFixed(2) + ',' + p2[1].toFixed(2);
    }
    return d;
  }
  function errPct(v, i) {
    const evening = i >= 72 && i <= 84;
    const base = 0.06 + 0.16 * Math.pow(v / 1000, 2);
    return base * (evening ? 1.9 : 1);
  }
  function heat(v) {
    if (v < 280) return 'rgba(188,212,124,.50)';
    if (v < 430) return 'rgba(188,212,124,.28)';
    if (v < 600) return 'rgba(242,176,74,.34)';
    if (v < 760) return 'rgba(242,176,74,.62)';
    return 'rgba(226,103,91,.86)';
  }

  /* =========================================================
     PRICE × LOAD CHART
     ========================================================= */
  function priceChart(container, D, layers) {
    const W = 1120, H = 362, l = 54, r = 60, t = 34, b = 38;
    const pw = W - l - r, ph = H - t - b;
    const px = i => l + pw * (i + 0.5) / 96;
    const py = v => t + ph * (1 - v / 1000);
    const ly = v => t + ph * (1 - v / 80);

    container.querySelectorAll('svg').forEach(s => s.remove());
    const svg = make('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': '96 时段日前价格与负荷预测曲线' });

    const defs = add(svg, 'defs');
    const grad = add(defs, 'linearGradient', { id: 'priceFill', x1: '0', y1: '0', x2: '0', y2: '1' });
    add(grad, 'stop', { offset: '0%', 'stop-color': C.amber, 'stop-opacity': '.20' });
    add(grad, 'stop', { offset: '55%', 'stop-color': C.amber, 'stop-opacity': '.055' });
    add(grad, 'stop', { offset: '100%', 'stop-color': C.amber, 'stop-opacity': '0' });
    const gradL = add(defs, 'linearGradient', { id: 'loadFill', x1: '0', y1: '0', x2: '0', y2: '1' });
    add(gradL, 'stop', { offset: '0%', 'stop-color': C.steel, 'stop-opacity': '.13' });
    add(gradL, 'stop', { offset: '100%', 'stop-color': C.steel, 'stop-opacity': '0' });

    if (layers.windows) {
      const w1 = add(svg, 'rect', { x: l + pw * 48 / 96, y: t, width: pw * 18 / 96, height: ph, fill: 'rgba(188,212,124,.045)' });
      const w2 = add(svg, 'rect', { x: l + pw * 72 / 96, y: t, width: pw * 12 / 96, height: ph, fill: 'rgba(226,103,91,.045)' });
      add(svg, 'line', { x1: l + pw * 48 / 96, y1: t, x2: l + pw * 48 / 96, y2: t + ph, stroke: 'rgba(188,212,124,.16)', 'stroke-width': .7 });
      add(svg, 'line', { x1: l + pw * 72 / 96, y1: t, x2: l + pw * 72 / 96, y2: t + ph, stroke: 'rgba(226,103,91,.2)', 'stroke-width': .7 });
      w1.setAttribute('rx', 0); w2.setAttribute('rx', 0);
    }

    for (let v = 0; v <= 1000; v += 250) {
      add(svg, 'line', { x1: l, y1: py(v), x2: W - r, y2: py(v), stroke: C.grid, 'stroke-width': 1 });
      add(svg, 'text', { x: l - 10, y: py(v) + 3, 'text-anchor': 'end', fill: C.muted, 'font-size': 8, 'font-family': MONO, 'letter-spacing': '.04em' }, v === 0 ? '0' : String(v));
      const lv = v / 1000 * 80;
      add(svg, 'text', { x: W - r + 10, y: ly(lv) + 3, fill: C.dim, 'font-size': 8, 'font-family': MONO }, String(Math.round(lv)));
    }

    for (let h = 0; h <= 24; h += 3) {
      const x = l + pw * h / 24;
      add(svg, 'line', { x1: x, y1: t, x2: x, y2: t + ph, stroke: C.grid, 'stroke-width': 1 });
      add(svg, 'text', { x: x, y: H - 14, 'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle', fill: C.muted, 'font-size': 8, 'font-family': MONO, 'letter-spacing': '.05em' }, String(h).padStart(2, '0') + ':00');
    }
    for (let h = 0; h <= 24; h++) {
      const x = l + pw * h / 24;
      add(svg, 'line', { x1: x, y1: t + ph, x2: x, y2: t + ph + 4, stroke: 'rgba(236,229,212,.16)', 'stroke-width': 1 });
    }

    if (layers.windows) {
      add(svg, 'text', { x: l + pw * 57 / 96, y: 20, 'text-anchor': 'middle', fill: C.lime, 'font-size': 8, 'font-family': MONO, 'letter-spacing': '.13em' }, '移峰 / 充电窗口');
      add(svg, 'text', { x: l + pw * 78 / 96, y: 20, 'text-anchor': 'middle', fill: C.red, 'font-size': 8, 'font-family': MONO, 'letter-spacing': '.13em' }, '晚峰风险');
    }

    if (layers.band) {
      const up = [], low = [];
      for (let i = 0; i < 96; i++) {
        const e = errPct(D.price[i], i);
        up.push([px(i), py(Math.min(1000, D.price[i] * (1 + e)))]);
        low.push([px(i), py(Math.max(0, D.price[i] * (1 - e)))]);
      }
      const d = smooth(up) + ' ' + smooth(low.slice().reverse()).replace(/^M/, 'L') + ' Z';
      add(svg, 'path', { d: d, fill: 'rgba(242,176,74,.07)', stroke: 'rgba(242,176,74,.12)', 'stroke-width': .6 });
    }

    if (layers.price) {
      const pts = D.price.map((v, i) => [px(i), py(v)]);
      const area = smooth(pts) + ' L ' + (W - r) + ',' + (t + ph) + ' L ' + l + ',' + (t + ph) + ' Z';
      add(svg, 'path', { d: area, fill: 'url(#priceFill)' });
      const line = add(svg, 'path', {
        d: smooth(pts), fill: 'none', stroke: C.amber, 'stroke-width': 1.9,
        'stroke-linejoin': 'round', 'stroke-linecap': 'round',
        class: 'trace-line', style: 'stroke-dasharray:2600;animation:draw 1.5s cubic-bezier(.2,.7,.2,1) both;filter:drop-shadow(0 0 5px rgba(242,176,74,.3))'
      });
      line.setAttribute('style', line.getAttribute('style'));
    }

    if (layers.load) {
      const pts = D.load.map((v, i) => [px(i), ly(v)]);
      add(svg, 'path', { d: smooth(pts) + ' L ' + (W - r) + ',' + (t + ph) + ' L ' + l + ',' + (t + ph) + ' Z', fill: 'url(#loadFill)' });
      add(svg, 'path', { d: smooth(pts), fill: 'none', stroke: C.steel, 'stroke-width': 1.45, 'stroke-opacity': 1, 'stroke-linejoin': 'round' });
    }

    const mx = px(D.maxIdx), my = py(D.maxPrice), mn = px(D.minIdx), mny = py(D.minPrice);
    add(svg, 'circle', { cx: mx, cy: my, r: 3.2, fill: C.bg || '#090a08', stroke: C.amber, 'stroke-width': 1.2 });
    add(svg, 'text', { x: clamp(mx, l + 24, W - r - 12), y: my - 11, 'text-anchor': 'middle', fill: C.amber, 'font-size': 8.5, 'font-family': MONO }, '¥' + Math.round(D.maxPrice));
    add(svg, 'circle', { cx: mn, cy: mny, r: 3, fill: '#090a08', stroke: C.lime, 'stroke-width': 1.1 });
    add(svg, 'text', { x: clamp(mn, l + 20, W - r - 10), y: mny + 15, 'text-anchor': 'middle', fill: C.lime, 'font-size': 8.5, 'font-family': MONO }, '¥' + Math.round(D.minPrice));

    add(svg, 'text', { x: l - 10, y: t - 12, 'text-anchor': 'end', fill: C.dim, 'font-size': 7.5, 'font-family': MONO, 'letter-spacing': '.1em' }, '¥ / MWh');
    add(svg, 'text', { x: W - r + 10, y: t - 12, fill: C.dim, 'font-size': 7.5, 'font-family': MONO, 'letter-spacing': '.1em' }, 'MW');

    const cross = add(svg, 'line', { x1: 0, y1: t, x2: 0, y2: t + ph, stroke: 'rgba(236,229,212,.24)', 'stroke-width': .8, 'stroke-dasharray': '2 3', opacity: 0 });
    const dot = add(svg, 'circle', { cx: 0, cy: 0, r: 3.4, fill: C.amber, stroke: '#090a08', 'stroke-width': 1.4, opacity: 0 });
    const overlay = add(svg, 'rect', { x: l, y: t, width: pw, height: ph, fill: 'transparent', style: 'cursor:crosshair' });

    container.appendChild(svg);

    const tip = container.querySelector('.chart-tip');
    function move(ev) {
      const rect = svg.getBoundingClientRect();
      const xv = (ev.clientX - rect.left) / rect.width * W;
      const idx = clamp(Math.floor((xv - l) / pw * 96), 0, 95);
      const cx = px(idx);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('opacity', 1);
      dot.setAttribute('cx', cx); dot.setAttribute('cy', py(D.price[idx])); dot.setAttribute('opacity', 1);
      const e = errPct(D.price[idx], idx);
      let action = '无储能动作';
      if (D.bessPower[idx] > 0) action = '充电 ' + D.bessPower[idx].toFixed(1) + ' MW';
      else if (D.bessPower[idx] < 0) action = '放电 ' + Math.abs(D.bessPower[idx]).toFixed(1) + ' MW';
      let win = '';
      if (idx >= 48 && idx < 66) win = '移峰 / 充电窗口';
      else if (idx >= 72 && idx < 84) win = '晚峰风险窗口';
      tip.innerHTML =
        '<div class="tip-time">' + range(idx) + '<span>' + D.meta.batch + '</span></div>' +
        '<div class="tip-row"><i>日前预测</i><b>¥' + D.price[idx].toFixed(1) + '</b></div>' +
        '<div class="tip-row"><i>误差带</i><b>±' + Math.round(e * 100) + '%</b></div>' +
        '<div class="tip-row"><i>预测负荷</i><b>' + D.load[idx].toFixed(1) + ' MW</b></div>' +
        '<div class="tip-row"><i>储能</i><b>' + action + '</b></div>' +
        (win ? '<div class="tip-note">S4 · <em>' + win + '</em></div>' : '<div class="tip-note">数据性质：预测值 · 非结算价</div>');
      tip.hidden = false;
      const wrapRect = container.getBoundingClientRect();
      let left = ev.clientX - wrapRect.left + 16;
      if (left + 220 > wrapRect.width) left = ev.clientX - wrapRect.left - 226;
      tip.style.left = Math.max(8, left) + 'px';
      tip.style.top = '26px';
    }
    function leave() {
      cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0);
      tip.hidden = true;
    }
    overlay.addEventListener('mousemove', move);
    overlay.addEventListener('mouseleave', leave);
    svg.addEventListener('mouseleave', leave);
  }

  /* =========================================================
     SCHEDULE CHART
     ========================================================= */
  function scheduleChart(container, D, onSlot) {
    const W = 1120, H = 452, l = 58, r = 64, t = 20, b = 34;
    const pw = W - l - r;
    const px = i => l + pw * (i + 0.5) / 96;
    const hx = h => l + pw * h / 24;
    container.querySelectorAll('svg').forEach(s => s.remove());
    const svg = make('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': '价格、负荷、储能与 SOC 的 96 时段排程图' });

    const L = { price: [26, 50], load: [86, 218], bess: [252, 330], soc: [362, 424] };

    for (let h = 0; h <= 24; h += 3) {
      const x = hx(h);
      add(svg, 'line', { x1: x, y1: 18, x2: x, y2: 428, stroke: C.grid, 'stroke-width': 1 });
      add(svg, 'text', { x: x, y: 444, 'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle', fill: C.muted, 'font-size': 7.5, 'font-family': MONO }, String(h).padStart(2, '0') + ':00');
    }

    add(svg, 'text', { x: l, y: 18, fill: C.dim, 'font-size': 7.5, 'font-family': MONO, 'letter-spacing': '.1em' }, '日前价格');
    const cellW = pw / 96;
    for (let i = 0; i < 96; i++) {
      add(svg, 'rect', { x: px(i) - cellW / 2 + 0.3, y: L.price[0], width: Math.max(cellW - 0.6, 1), height: L.price[1] - L.price[0], fill: heat(D.price[i]) });
    }
    add(svg, 'text', { x: W - r + 8, y: L.price[0] + 10, fill: C.dim, 'font-size': 7, 'font-family': MONO }, '高');
    add(svg, 'text', { x: W - r + 8, y: L.price[1] - 2, fill: C.dim, 'font-size': 7, 'font-family': MONO }, '低');

    /* load lane — zoomed 50–76 MW so the curve reads clearly */
    const loadMin = 50, loadMax = 76;
    add(svg, 'text', { x: l, y: L.load[0] - 7, fill: C.text, 'font-size': 8.5, 'font-family': MONO, 'letter-spacing': '.08em', opacity: .75 }, '负荷 / 并网 · MW');
    [50, 60, 70].forEach(function (v) {
      const y = L.load[1] - (L.load[1] - L.load[0]) * (v - loadMin) / (loadMax - loadMin);
      add(svg, 'line', { x1: l, y1: y, x2: W - r, y2: y, stroke: 'rgba(236,229,212,.06)', 'stroke-width': 1 });
      add(svg, 'text', { x: l - 9, y: y + 3, 'text-anchor': 'end', fill: C.muted, 'font-size': 8, 'font-family': MONO }, String(v));
    });
    const vy = v => L.load[1] - (L.load[1] - L.load[0]) * (v - loadMin) / (loadMax - loadMin);
    const loadPts = D.load.map((v, i) => [px(i), vy(v)]);
    add(svg, 'path', { d: smooth(loadPts) + ' L ' + (W - r) + ',' + L.load[1] + ' L ' + l + ',' + L.load[1] + ' Z', fill: 'rgba(134,182,192,.11)' });
    add(svg, 'path', { d: smooth(loadPts), fill: 'none', stroke: C.steel, 'stroke-width': 1.7, 'stroke-opacity': 1 });
    const limit = D.gridLimit || 74;
    add(svg, 'line', { x1: l, y1: vy(limit), x2: W - r, y2: vy(limit), stroke: 'rgba(226,103,91,.62)', 'stroke-width': 1, 'stroke-dasharray': '4 4' });
    add(svg, 'text', { x: W - r + 8, y: vy(limit) + 3, fill: C.red, 'font-size': 8, 'font-family': MONO }, '上限 ' + limit);

    /* bess lane */
    add(svg, 'text', { x: l, y: L.bess[0] - 7, fill: C.text, 'font-size': 8.5, 'font-family': MONO, 'letter-spacing': '.08em', opacity: .75 }, '储能功率 · MW（上放 / 下充）');
    const mid = (L.bess[0] + L.bess[1]) / 2;
    add(svg, 'line', { x1: l, y1: mid, x2: W - r, y2: mid, stroke: 'rgba(236,229,212,.12)', 'stroke-width': .8 });
    for (let i = 0; i < 96; i++) {
      const p = D.bessPower[i];
      if (!p) continue;
      const bw = Math.max(cellW * 0.62, 2);
      const hgt = Math.abs(p) / 10 * (L.bess[1] - L.bess[0]) / 2;
      add(svg, 'rect', {
        x: px(i) - bw / 2,
        y: p > 0 ? mid : mid - hgt,
        width: bw,
        height: Math.max(hgt, 1.2),
        fill: p > 0 ? 'rgba(188,212,124,.62)' : 'rgba(242,176,74,.72)'
      });
    }
    add(svg, 'text', { x: W - r + 8, y: L.bess[0] + 8, fill: C.muted, 'font-size': 7.5, 'font-family': MONO }, '+10');
    add(svg, 'text', { x: W - r + 8, y: mid + 3, fill: C.muted, 'font-size': 7.5, 'font-family': MONO }, '0');
    add(svg, 'text', { x: W - r + 8, y: L.bess[1] - 1, fill: C.muted, 'font-size': 7.5, 'font-family': MONO }, '−10');

    /* soc lane — step-safe polyline */
    add(svg, 'text', { x: l, y: L.soc[0] - 7, fill: C.text, 'font-size': 8.5, 'font-family': MONO, 'letter-spacing': '.08em', opacity: .75 }, 'SOC · %');
    const sy = v => L.soc[1] - (L.soc[1] - L.soc[0]) * v / 100;
    add(svg, 'rect', { x: l, y: sy(90), width: pw, height: sy(20) - sy(90), fill: 'rgba(188,212,124,.035)' });
    [20, 90].forEach(function (v) {
      add(svg, 'line', { x1: l, y1: sy(v), x2: W - r, y2: sy(v), stroke: 'rgba(188,212,124,.25)', 'stroke-width': .7, 'stroke-dasharray': '3 4' });
      if (v === 90) add(svg, 'text', { x: W - r + 8, y: sy(v) + 3, fill: C.dim, 'font-size': 7.5, 'font-family': MONO }, v + '%');
      add(svg, 'text', { x: l - 9, y: sy(v) + 3, 'text-anchor': 'end', fill: C.muted, 'font-size': 8, 'font-family': MONO }, v + '%');
    });
    const socPts = D.soc.map((v, i) => [px(i), sy(v)]);
    const socLine = socPts.map((p, i) => (i === 0 ? 'M ' : 'L ') + p[0].toFixed(2) + ',' + p[1].toFixed(2)).join(' ');
    add(svg, 'path', { d: socLine + ' L ' + (W - r) + ',' + L.soc[1] + ' L ' + l + ',' + L.soc[1] + ' Z', fill: 'rgba(188,212,124,.07)' });
    add(svg, 'path', { d: socLine, fill: 'none', stroke: C.lime, 'stroke-width': 1.7, 'stroke-linejoin': 'round' });
    add(svg, 'circle', { cx: px(95), cy: sy(D.soc[95]), r: 2.8, fill: C.lime });
    add(svg, 'text', { x: W - r + 8, y: sy(D.soc[95]) + 3, fill: C.lime, 'font-size': 8, 'font-family': MONO }, D.soc[95].toFixed(1) + '%');

    const cross = add(svg, 'line', { x1: 0, y1: 18, x2: 0, y2: 430, stroke: 'rgba(236,229,212,.35)', 'stroke-width': .8, 'stroke-dasharray': '2 3' });
    const hi = add(svg, 'rect', { x: 0, y: L.price[0], width: cellW, height: L.price[1] - L.price[0], fill: 'none', stroke: C.text, 'stroke-width': 1 });
    const dotLoad = add(svg, 'circle', { cx: 0, cy: 0, r: 3, fill: C.steel, stroke: '#090a08', 'stroke-width': 1.3 });
    const dotSoc = add(svg, 'circle', { cx: 0, cy: 0, r: 3, fill: C.lime, stroke: '#090a08', 'stroke-width': 1.3 });
    const overlay = add(svg, 'rect', { x: l, y: 16, width: pw, height: 416, fill: 'transparent', style: 'cursor:crosshair' });

    container.appendChild(svg);

    function highlight(i) {
      i = clamp(i, 0, 95);
      const x = px(i);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x);
      hi.setAttribute('x', Math.max(l, x - cellW / 2)); hi.setAttribute('width', Math.min(cellW, W - r - Math.max(l, x - cellW / 2)));
      dotLoad.setAttribute('cx', x); dotLoad.setAttribute('cy', vy(D.load[i]));
      dotSoc.setAttribute('cx', x); dotSoc.setAttribute('cy', sy(D.soc[i]));
    }
    let last = 76;
    highlight(last);
    function move(ev) {
      const rect = svg.getBoundingClientRect();
      const xv = (ev.clientX - rect.left) / rect.width * W;
      const idx = clamp(Math.floor((xv - l) / pw * 96), 0, 95);
      if (idx === last) return;
      last = idx;
      highlight(idx);
      if (onSlot) onSlot(idx);
    }
    overlay.addEventListener('mousemove', move);
    if (onSlot) onSlot(last);
    return { highlight: highlight };
  }

  /* =========================================================
     GANTT
     ========================================================= */
  function gantt(container, D, showGhost) {
    const W = 1120, H = 244, l = 96, r = 22, t = 26, b = 30;
    const pw = W - l - r;
    const hx = h => l + pw * h / 24;
    container.querySelectorAll('svg').forEach(s => s.remove());
    const svg = make('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': '可调工序与原计划甘特对照' });

    for (let h = 0; h <= 24; h += 3) {
      const x = hx(h);
      add(svg, 'line', { x1: x, y1: t, x2: x, y2: H - b, stroke: C.grid, 'stroke-width': 1 });
      add(svg, 'text', { x: x, y: H - 11, 'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle', fill: C.muted, 'font-size': 7.5, 'font-family': MONO }, String(h).padStart(2, '0') + ':00');
    }
    add(svg, 'rect', { x: hx(12.5), y: t, width: hx(16.5) - hx(12.5), height: H - b - t, fill: 'rgba(188,212,124,.04)' });
    add(svg, 'line', { x1: hx(12.5), y1: t, x2: hx(12.5), y2: H - b, stroke: 'rgba(188,212,124,.16)', 'stroke-width': .7 });
    add(svg, 'line', { x1: hx(16.5), y1: t, x2: hx(16.5), y2: H - b, stroke: 'rgba(188,212,124,.16)', 'stroke-width': .7 });

    const lanes = [
      { name: '1# 烧结', sub: '连续运行', y: 54 },
      { name: '2# 轧机', sub: '可调工序', y: 100 },
      { name: '3# 加热炉', sub: '连续运行', y: 146 },
      { name: '4# 公辅', sub: '连续运行', y: 192 }
    ];
    lanes.forEach(function (lane) {
      add(svg, 'text', { x: l - 12, y: lane.y + 10, 'text-anchor': 'end', fill: C.text, 'font-size': 9.5, 'font-family': SANS }, lane.name);
      add(svg, 'text', { x: l - 12, y: lane.y + 22, 'text-anchor': 'end', fill: C.dim, 'font-size': 7, 'font-family': MONO, 'letter-spacing': '.08em' }, lane.sub);
      add(svg, 'line', { x1: l, y1: lane.y + 24, x2: W - r, y2: lane.y + 24, stroke: 'rgba(236,229,212,.05)', 'stroke-width': 1 });
    });

    function bar(x1, x2, y, h, fill, stroke, dash, text, textFill) {
      const g = add(svg, 'g');
      add(g, 'rect', { x: hx(x1), y: y, width: Math.max(hx(x2) - hx(x1), 2), height: h, fill: fill, stroke: stroke || 'none', 'stroke-width': .8, 'stroke-dasharray': dash || null, rx: 1 });
      if (text) {
        add(g, 'text', { x: hx(x1) + 8, y: y + h / 2 + 3, fill: textFill || C.text, 'font-size': 7.5, 'font-family': MONO, 'letter-spacing': '.04em' }, text);
      }
      return g;
    }

    bar(0, 24, 54, 18, 'rgba(134,182,192,.16)', null, null, '00:00–24:00 连续', 'rgba(236,229,212,.7)');
    bar(0, 24, 146, 18, 'rgba(134,182,192,.12)', null, null, '00:00–24:00 连续', 'rgba(236,229,212,.6)');
    bar(0, 24, 192, 18, 'rgba(134,182,192,.1)', null, null, '00:00–24:00 连续', 'rgba(236,229,212,.55)');

    if (showGhost) {
      bar(18.5, 22.5, 100, 18, 'rgba(226,103,91,.06)', 'rgba(226,103,91,.5)', '4 4', '原窗口 18:30–22:30', 'rgba(226,103,91,.85)');
      const x1 = hx(20.5), x2 = hx(14.5), y = 95;
      add(svg, 'path', { d: 'M ' + x1 + ',' + y + ' C ' + (x1 - 70) + ',' + (y - 32) + ' ' + (x2 + 70) + ',' + (y - 32) + ' ' + x2 + ',' + y, fill: 'none', stroke: 'rgba(236,229,212,.24)', 'stroke-width': .8, 'stroke-dasharray': '3 3' });
      add(svg, 'circle', { cx: x2, cy: y, r: 2, fill: C.dim });
      add(svg, 'text', { x: (x1 + x2) / 2, y: y - 22, 'text-anchor': 'middle', fill: C.dim, 'font-size': 7, 'font-family': MONO, 'letter-spacing': '.08em' }, '位移 −6.0h');
    }
    bar(12.5, 16.5, 100, 18, 'rgba(188,212,124,.24)', 'rgba(188,212,124,.7)', null, '新窗口 12:30–16:30 · 3.2 MW', 'rgba(236,245,210,.95)');

    add(svg, 'text', { x: l, y: 16, fill: C.dim, 'font-size': 7.5, 'font-family': MONO, 'letter-spacing': '.09em' }, 'PROCESS LANES · 硬约束校验通过 6 / 6');
    container.appendChild(svg);
  }

  /* =========================================================
     LONG-TERM COVERAGE CORRIDOR
     ========================================================= */
  function longTerm(container, D) {
    const LT = D.longTerm;
    const W = 1120, H = 372, l = 54, r = 60, t = 34, b = 52;
    const pw = W - l - r, ph = H - t - b;
    const px = i => l + pw * (i + 0.5) / 12;
    const y = v => t + ph * (1 - v / 100);

    container.querySelectorAll('svg').forEach(s => s.remove());
    const svg = make('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': '年度合同覆盖走廊与现货敞口' });
    const tip = container.querySelector('.chart-tip');

    [0, 25, 50, 75, 100].forEach(function (v) {
      add(svg, 'line', { x1: l, y1: y(v), x2: W - r, y2: y(v), stroke: C.grid, 'stroke-width': 1 });
      add(svg, 'text', { x: l - 10, y: y(v) + 3, 'text-anchor': 'end', fill: C.muted, 'font-size': 8, 'font-family': MONO }, v + '%');
    });

    add(svg, 'rect', { x: l, y: y(LT.corridor[1]), width: pw, height: y(LT.corridor[0]) - y(LT.corridor[1]), fill: 'rgba(188,212,124,.045)' });
    add(svg, 'line', { x1: l, y1: y(LT.corridor[0]), x2: W - r, y2: y(LT.corridor[0]), stroke: 'rgba(188,212,124,.16)', 'stroke-width': .7, 'stroke-dasharray': '3 4' });
    add(svg, 'line', { x1: l, y1: y(LT.corridor[1]), x2: W - r, y2: y(LT.corridor[1]), stroke: 'rgba(188,212,124,.16)', 'stroke-width': .7, 'stroke-dasharray': '3 4' });
    add(svg, 'line', { x1: l, y1: y(LT.target), x2: W - r, y2: y(LT.target), stroke: 'rgba(188,212,124,.55)', 'stroke-width': 1, 'stroke-dasharray': '6 4' });
    add(svg, 'text', { x: W - r + 8, y: y(LT.target) + 3, fill: C.lime, 'font-size': 8, 'font-family': MONO }, '目标 ' + LT.target + '%');

    for (let q = 1; q <= 3; q++) {
      const x = l + pw * q / 4;
      add(svg, 'line', { x1: x, y1: t, x2: x, y2: H - b, stroke: 'rgba(236,229,212,.075)', 'stroke-width': 1 });
    }
    ['Q1', 'Q2', 'Q3', 'Q4'].forEach(function (q, i) {
      add(svg, 'text', { x: l + pw * (i + 0.5) / 4, y: t - 10, 'text-anchor': 'middle', fill: C.muted, 'font-size': 8, 'font-family': MONO, 'letter-spacing': '.14em' }, q);
    });

    const bw = Math.min(46, pw / 12 * 0.5);
    const baseY = t + ph;
    LT.coverage.forEach(function (cov, i) {
      const cx = px(i);
      const spot = 100 - cov;
      add(svg, 'rect', { x: cx - bw / 2, y: t, width: bw, height: y(cov) - t, fill: 'rgba(242,176,74,' + (0.06 + spot / 100 * 0.12).toFixed(3) + ')' });
      add(svg, 'rect', { x: cx - bw / 2, y: y(cov), width: bw, height: baseY - y(cov), fill: cov >= LT.target ? 'rgba(134,182,192,.42)' : 'rgba(134,182,192,.26)' });
      add(svg, 'line', { x1: cx - bw / 2, y1: y(cov), x2: cx + bw / 2, y2: y(cov), stroke: cov >= LT.target ? C.lime : C.amber, 'stroke-width': 1.6 });
      add(svg, 'text', { x: cx, y: y(cov) - 7, 'text-anchor': 'middle', fill: cov >= LT.target ? C.lime : C.amber, 'font-size': 8, 'font-family': MONO }, cov + '%');
      add(svg, 'text', { x: cx, y: H - 30, 'text-anchor': 'middle', fill: C.muted, 'font-size': 8, 'font-family': MONO }, LT.months[i] + ' 月');
      add(svg, 'text', { x: cx, y: H - 15, 'text-anchor': 'middle', fill: C.dim, 'font-size': 7.5, 'font-family': MONO }, LT.budgets[i]);
    });
    add(svg, 'text', { x: l - 10, y: t - 25, 'text-anchor': 'end', fill: C.dim, 'font-size': 7.5, 'font-family': MONO, 'letter-spacing': '.08em' }, 'COVERAGE');
    add(svg, 'text', { x: W - r + 8, y: H - 15, fill: C.dim, 'font-size': 7, 'font-family': MONO }, '预算 / 万');

    const cross = add(svg, 'line', { x1: 0, y1: t, x2: 0, y2: H - b, stroke: 'rgba(236,229,212,.3)', 'stroke-width': .8, 'stroke-dasharray': '2 3', opacity: 0 });
    const highlight = add(svg, 'rect', { x: 0, y: t, width: bw, height: ph, fill: 'none', stroke: 'rgba(236,229,212,.45)', 'stroke-width': 1, opacity: 0 });
    const overlay = add(svg, 'rect', { x: l, y: t, width: pw, height: ph, fill: 'transparent', style: 'cursor:crosshair' });
    container.appendChild(svg);

    function move(ev) {
      const rect = svg.getBoundingClientRect();
      const xv = (ev.clientX - rect.left) / rect.width * W;
      const idx = clamp(Math.floor((xv - l) / pw * 12), 0, 11);
      const cx = px(idx);
      cross.setAttribute('x1', cx); cross.setAttribute('x2', cx); cross.setAttribute('opacity', 1);
      highlight.setAttribute('x', cx - bw / 2); highlight.setAttribute('opacity', 1);
      const cov = LT.coverage[idx];
      tip.innerHTML =
        '<div class="tip-time">2026-' + LT.months[idx] + '<span>FY2026</span></div>' +
        '<div class="tip-row"><i>合同覆盖</i><b>' + cov + '%</b></div>' +
        '<div class="tip-row"><i>现货敞口</i><b>' + (100 - cov) + '%</b></div>' +
        '<div class="tip-row"><i>月度预算</i><b>' + LT.budgets[idx] + ' 万元</b></div>' +
        '<div class="tip-row"><i>峰值需量</i><b>' + LT.peak[idx] + ' MW</b></div>' +
        '<div class="tip-note">' + (cov >= LT.target
          ? '覆盖率达到目标 · <em>现货敞口低于 30%</em>'
          : '低于目标 ' + (LT.target - cov) + ' pp · <span style="color:var(--amber)">建议合同增签</span>') + '</div>';
      tip.hidden = false;
      const wrapRect = container.getBoundingClientRect();
      let left = ev.clientX - wrapRect.left + 16;
      if (left + 220 > wrapRect.width) left = ev.clientX - wrapRect.left - 226;
      tip.style.left = Math.max(8, left) + 'px';
      tip.style.top = '30px';
    }
    function leave() {
      cross.setAttribute('opacity', 0); highlight.setAttribute('opacity', 0);
      if (tip) tip.hidden = true;
    }
    overlay.addEventListener('mousemove', move);
    overlay.addEventListener('mouseleave', leave);
    svg.addEventListener('mouseleave', leave);
  }

  /* =========================================================
     FORECAST TERMINAL (main + sub)
     ========================================================= */
  function terminal(mainEl, subEl, D, opts) {
    opts = opts || {};
    const mode = opts.mode || 'line';
    const overlay = opts.overlay || 'load';
    const overlayMain = !!opts.overlayMain;
    const defaultSlot = clamp(opts.slot == null ? 76 : opts.slot, 0, 95);
    const onHover = typeof opts.onHover === 'function' ? opts.onHover : function () {};
    const UP = '#ff5d5d', DOWN = '#3ecf8e', GOLD = '#f2b04a', STEEL = '#86b6c0', LIME = '#bcd47c';

    const W = 1000, H = 620, l = 50, r = 68, t = 30, b = 32;
    const pw = W - l - r, ph = H - t - b;
    const px = i => l + pw * (i + 0.5) / 96;
    const py = v => t + ph * (1 - v / 1000);

    mainEl.querySelectorAll('svg').forEach(s => s.remove());
    subEl.querySelectorAll('svg').forEach(s => s.remove());
    const svg = make('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': '日前价格预测行情主图' });

    const defs = add(svg, 'defs');
    const grad = add(defs, 'linearGradient', { id: 'termPriceFill', x1: '0', y1: '0', x2: '0', y2: '1' });
    add(grad, 'stop', { offset: '0%', 'stop-color': GOLD, 'stop-opacity': '.20' });
    add(grad, 'stop', { offset: '60%', 'stop-color': GOLD, 'stop-opacity': '.05' });
    add(grad, 'stop', { offset: '100%', 'stop-color': GOLD, 'stop-opacity': '0' });

    /* windows */
    add(svg, 'rect', { x: l + pw * 48 / 96, y: t, width: pw * 18 / 96, height: ph, fill: 'rgba(188,212,124,.038)' });
    add(svg, 'rect', { x: l + pw * 72 / 96, y: t, width: pw * 12 / 96, height: ph, fill: 'rgba(255,93,93,.035)' });
    add(svg, 'line', { x1: l + pw * 48 / 96, y1: t, x2: l + pw * 48 / 96, y2: t + ph, stroke: 'rgba(188,212,124,.14)', 'stroke-width': .7 });
    add(svg, 'line', { x1: l + pw * 72 / 96, y1: t, x2: l + pw * 72 / 96, y2: t + ph, stroke: 'rgba(255,93,93,.17)', 'stroke-width': .7 });
    add(svg, 'text', { x: l + pw * 57 / 96, y: t - 9, 'text-anchor': 'middle', fill: 'rgba(188,212,124,.8)', 'font-size': 8.5, 'font-family': MONO, 'letter-spacing': '.1em' }, '低价 / 充电');
    add(svg, 'text', { x: l + pw * 78 / 96, y: t - 9, 'text-anchor': 'middle', fill: 'rgba(255,93,93,.8)', 'font-size': 8.5, 'font-family': MONO, 'letter-spacing': '.1em' }, '晚峰');

    /* grid + axis */
    for (let v = 0; v <= 1000; v += 200) {
      add(svg, 'line', { x1: l, y1: py(v), x2: W - r, y2: py(v), stroke: 'rgba(236,229,212,.055)', 'stroke-width': 1 });
      add(svg, 'text', { x: l - 9, y: py(v) + 3, 'text-anchor': 'end', fill: C.muted, 'font-size': 9, 'font-family': MONO }, v);
    }
    for (let h = 0; h <= 24; h += 3) {
      const x = l + pw * h / 24;
      add(svg, 'line', { x1: x, y1: t, x2: x, y2: t + ph, stroke: 'rgba(236,229,212,.055)', 'stroke-width': 1 });
      add(svg, 'text', { x: x, y: H - 12, 'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle', fill: C.muted, 'font-size': 9, 'font-family': MONO }, String(h).padStart(2, '0') + ':00');
    }
    for (let h = 0; h <= 24; h++) {
      add(svg, 'line', { x1: l + pw * h / 24, y1: t + ph, x2: l + pw * h / 24, y2: t + ph + 4, stroke: 'rgba(236,229,212,.14)', 'stroke-width': 1 });
    }

    /* average line */
    add(svg, 'line', { x1: l, y1: py(D.avgPrice), x2: W - r, y2: py(D.avgPrice), stroke: 'rgba(134,182,192,.35)', 'stroke-width': .7, 'stroke-dasharray': '4 5' });
    add(svg, 'text', { x: W - r - 4, y: py(D.avgPrice) - 6, 'text-anchor': 'end', fill: 'rgba(134,182,192,.7)', 'font-size': 8, 'font-family': MONO }, '日均 ' + Math.round(D.avgPrice));

    /* optional overlay on main */
    function overlayValue(i) {
      if (overlay === 'load') return D.load[i];
      if (overlay === 'spread') return D.price[i] - D.avgPrice;
      if (overlay === 'soc') return D.soc[i];
      return D.gridLimit - D.netLoad[i];
    }
    const OV = {
      load: { label: '负荷', unit: 'MW', min: 45, max: 76, color: STEEL },
      spread: { label: '价差', unit: '元/MWh', min: -520, max: 520, color: GOLD },
      soc: { label: 'SOC', unit: '%', min: 0, max: 100, color: LIME },
      margin: { label: '余量', unit: 'MW', min: 0, max: 20, color: STEEL }
    };
    const ov = OV[overlay];
    if (overlayMain) {
      const bandTop = t + ph * .72, bandBot = t + ph * .97;
      const oy = v => bandBot - clamp((v - ov.min) / (ov.max - ov.min), 0, 1) * (bandBot - bandTop);
      const pts = Array.from({ length: 96 }, (_, i) => [px(i), oy(overlayValue(i))]);
      add(svg, 'path', { d: smooth(pts), fill: 'none', stroke: ov.color, 'stroke-width': 1.1, 'stroke-opacity': .38 });
      add(svg, 'text', { x: W - r - 4, y: t + 12, 'text-anchor': 'end', fill: ov.color, 'font-size': 8, 'font-family': MONO, 'letter-spacing': '.05em', opacity: .8 }, '叠加 · ' + ov.label + ' / ' + ov.unit);
    }

    /* main price series */
    if (mode === 'candle') {
      const bw = Math.max(2.4, pw / 96 * .52);
      for (let i = 0; i < 96; i++) {
        const close = D.price[i];
        const open = i ? D.price[i - 1] : D.price[i];
        const err = errPct(close, i) * close * .25;
        const high = Math.min(1000, Math.max(open, close) + err);
        const low = Math.max(0, Math.min(open, close) - err);
        const up = close >= open;
        const col = up ? UP : DOWN;
        add(svg, 'line', { x1: px(i), y1: py(high), x2: px(i), y2: py(low), stroke: col, 'stroke-width': .8, opacity: .68 });
        const yo = py(open), yc = py(close);
        const top = Math.min(yo, yc), hgt = Math.max(1.6, Math.abs(yo - yc));
        add(svg, 'rect', { x: px(i) - bw / 2, y: top, width: bw, height: hgt, fill: col, opacity: .9 });
      }
      const ma = [];
      for (let i = 0; i < 96; i++) {
        let s = 0, c = 0;
        for (let k = Math.max(0, i - 11); k <= i; k++) { s += D.price[k]; c++; }
        ma.push([px(i), py(s / c)]);
      }
      add(svg, 'path', { d: smooth(ma), fill: 'none', stroke: GOLD, 'stroke-width': 1, 'stroke-opacity': .6, 'stroke-dasharray': '4 4' });
      add(svg, 'text', { x: l + 4, y: t + 13, fill: GOLD, 'font-size': 8, 'font-family': MONO, 'letter-spacing': '.05em', opacity: .8 }, '时段K · O/C=前/当前预测 · H/L=误差带25%');
    } else if (mode === 'band') {
      const up = [], low = [];
      for (let i = 0; i < 96; i++) {
        const e = errPct(D.price[i], i);
        up.push([px(i), py(Math.min(1000, D.price[i] * (1 + e)))]);
        low.push([px(i), py(Math.max(0, D.price[i] * (1 - e)))]);
      }
      const d = smooth(up) + ' ' + smooth(low.slice().reverse()).replace(/^M/, 'L') + ' Z';
      add(svg, 'path', { d: d, fill: 'rgba(242,176,74,.10)', stroke: 'rgba(242,176,74,.2)', 'stroke-width': .8 });
      const pts = D.price.map((v, i) => [px(i), py(v)]);
      add(svg, 'path', { d: smooth(pts), fill: 'none', stroke: GOLD, 'stroke-width': 1.7, 'stroke-linejoin': 'round' });
      add(svg, 'text', { x: l + 4, y: t + 13, fill: GOLD, 'font-size': 8, 'font-family': MONO, 'letter-spacing': '.05em', opacity: .8 }, '误差带 · 晚峰放大 1.9×');
    } else if (mode === 'backtest') {
      const pts = D.price.map((v, i) => [px(i), py(v)]);
      const act = D.actualPrice.map((v, i) => [px(i), py(v)]);
      add(svg, 'path', { d: smooth(pts) + ' ' + smooth(act.slice().reverse()).replace(/^M/, 'L') + ' Z', fill: 'rgba(255,93,93,.028)' });
      add(svg, 'path', { d: smooth(act), fill: 'none', stroke: STEEL, 'stroke-width': 1.2, 'stroke-dasharray': '5 4', 'stroke-opacity': .8 });
      add(svg, 'path', { d: smooth(pts), fill: 'none', stroke: GOLD, 'stroke-width': 1.7, 'stroke-linejoin': 'round' });
      let maxI = 72;
      for (let i = 72; i <= 84; i++) if (Math.abs(D.actualPrice[i] - D.price[i]) > Math.abs(D.actualPrice[maxI] - D.price[maxI])) maxI = i;
      add(svg, 'circle', { cx: px(maxI), cy: py(D.actualPrice[maxI]), r: 2.8, fill: STEEL, stroke: '#0d100c', 'stroke-width': 1 });
      add(svg, 'text', { x: px(maxI) + 7, y: py(D.actualPrice[maxI]) - 7, fill: STEEL, 'font-size': 7.5, 'font-family': MONO }, '最大偏差 ' + D.meta.timeOf(maxI));
      add(svg, 'text', { x: l + 4, y: t + 13, fill: STEEL, 'font-size': 8, 'font-family': MONO, 'letter-spacing': '.05em', opacity: .85 }, '回测 · 昨日实际 vs 今日预测 · MAPE ' + D.forecastStats.mape + '%');
    } else {
      const pts = D.price.map((v, i) => [px(i), py(v)]);
      const area = smooth(pts) + ' L ' + (W - r) + ',' + (t + ph) + ' L ' + l + ',' + (t + ph) + ' Z';
      add(svg, 'path', { d: area, fill: 'url(#termPriceFill)' });
      add(svg, 'path', { d: smooth(pts), fill: 'none', stroke: GOLD, 'stroke-width': 1.7, 'stroke-linejoin': 'round', 'stroke-linecap': 'round', style: 'filter:drop-shadow(0 0 5px rgba(242,176,74,.28))' });
    }

    /* high / low */
    add(svg, 'circle', { cx: px(D.maxIdx), cy: py(D.maxPrice), r: 3, fill: '#0d100c', stroke: GOLD, 'stroke-width': 1.1 });
    add(svg, 'text', { x: clamp(px(D.maxIdx), l + 20, W - r - 20), y: py(D.maxPrice) - 9, 'text-anchor': 'middle', fill: GOLD, 'font-size': 8.5, 'font-family': MONO }, '¥' + Math.round(D.maxPrice));
    add(svg, 'circle', { cx: px(D.minIdx), cy: py(D.minPrice), r: 3, fill: '#0d100c', stroke: STEEL, 'stroke-width': 1.1 });
    add(svg, 'text', { x: clamp(px(D.minIdx), l + 20, W - r - 20), y: py(D.minPrice) + 14, 'text-anchor': 'middle', fill: STEEL, 'font-size': 8.5, 'font-family': MONO }, '¥' + Math.round(D.minPrice));

    /* last price marker */
    const lastX = px(defaultSlot);
    add(svg, 'line', { x1: lastX, y1: t, x2: lastX, y2: t + ph, stroke: 'rgba(242,176,74,.35)', 'stroke-width': .8, 'stroke-dasharray': '2 3' });
    add(svg, 'text', { x: clamp(lastX, l + 18, W - r - 18), y: t - 9 + 22, 'text-anchor': 'middle', fill: GOLD, 'font-size': 7.5, 'font-family': MONO, 'letter-spacing': '.08em', opacity: .85 }, '最新');
    const lastY = py(D.price[defaultSlot]);
    add(svg, 'line', { x1: l, y1: lastY, x2: W - r, y2: lastY, stroke: 'rgba(242,176,74,.22)', 'stroke-width': .8, 'stroke-dasharray': '3 4' });
    add(svg, 'rect', { x: W - r + 4, y: lastY - 9, width: 56, height: 18, fill: GOLD, opacity: .92 });
    add(svg, 'text', { x: W - r + 32, y: lastY + 4, 'text-anchor': 'middle', fill: '#121207', 'font-size': 9, 'font-family': MONO, 'font-weight': 500 }, String(Math.round(D.price[defaultSlot])));

    /* right price axis label */
    add(svg, 'text', { x: W - r + 8, y: t - 12, fill: C.dim, 'font-size': 7.5, 'font-family': MONO, 'letter-spacing': '.08em' }, '¥/MWh');

    /* crosshair */
    const cross = add(svg, 'line', { x1: 0, y1: t, x2: 0, y2: t + ph, stroke: 'rgba(236,229,212,.4)', 'stroke-width': .8, 'stroke-dasharray': '2 3', opacity: 0 });
    const dot = add(svg, 'circle', { cx: 0, cy: 0, r: 3.2, fill: GOLD, stroke: '#0d100c', 'stroke-width': 1.3, opacity: 0 });
    const overlayRect = add(svg, 'rect', { x: l, y: t, width: pw, height: ph, fill: 'transparent', style: 'cursor:crosshair' });
    mainEl.appendChild(svg);

    /* ================= sub chart ================= */
    const SW = 1000, SH = 160, sl = 50, sr = 68, st = 16, sb = 26;
    const spw = SW - sl - sr, sph = SH - st - sb;
    const sx = i => sl + spw * (i + 0.5) / 96;
    const sub = make('svg', { viewBox: '0 0 ' + SW + ' ' + SH, role: 'img', 'aria-label': '预测副图指标' });
    const subDefs = add(sub, 'defs');
    const gSub = add(subDefs, 'linearGradient', { id: 'termSubFill', x1: '0', y1: '0', x2: '0', y2: '1' });
    add(gSub, 'stop', { offset: '0%', 'stop-color': ov.color, 'stop-opacity': '.16' });
    add(gSub, 'stop', { offset: '100%', 'stop-color': ov.color, 'stop-opacity': '0' });

    for (let h = 0; h <= 24; h += 3) {
      const x = sl + spw * h / 24;
      add(sub, 'line', { x1: x, y1: st, x2: x, y2: SH - sb, stroke: 'rgba(236,229,212,.045)', 'stroke-width': 1 });
      add(sub, 'text', { x: x, y: SH - 9, 'text-anchor': h === 0 ? 'start' : h === 24 ? 'end' : 'middle', fill: C.dim, 'font-size': 8, 'font-family': MONO }, String(h).padStart(2, '0'));
    }

    add(sub, 'text', { x: sl, y: 10, fill: C.muted, 'font-size': 8, 'font-family': MONO, 'letter-spacing': '.08em' }, 'SUB · ' + ov.label + ' / ' + ov.unit);

    if (overlay === 'spread') {
      let maxAbs = 0;
      for (let i = 0; i < 96; i++) maxAbs = Math.max(maxAbs, Math.abs(overlayValue(i)));
      maxAbs = Math.max(200, Math.ceil(maxAbs / 100) * 100);
      const zy = v => st + sph * (1 - (v + maxAbs) / (maxAbs * 2));
      add(sub, 'line', { x1: sl, y1: zy(0), x2: SW - sr, y2: zy(0), stroke: 'rgba(236,229,212,.18)', 'stroke-width': .8 });
      add(sub, 'text', { x: sl - 8, y: zy(maxAbs) + 3, 'text-anchor': 'end', fill: C.muted, 'font-size': 8, 'font-family': MONO }, '+' + maxAbs);
      add(sub, 'text', { x: sl - 8, y: zy(0) + 3, 'text-anchor': 'end', fill: C.muted, 'font-size': 8, 'font-family': MONO }, '0');
      add(sub, 'text', { x: sl - 8, y: zy(-maxAbs) + 3, 'text-anchor': 'end', fill: C.muted, 'font-size': 8, 'font-family': MONO }, '-' + maxAbs);
      const bw = Math.max(2, spw / 96 * .55);
      for (let i = 0; i < 96; i++) {
        const v = overlayValue(i);
        const y0 = zy(0), y1 = zy(v);
        add(sub, 'rect', { x: sx(i) - bw / 2, y: Math.min(y0, y1), width: bw, height: Math.max(1, Math.abs(y0 - y1)), fill: v >= 0 ? UP : DOWN, opacity: .55 });
      }
      add(sub, 'text', { x: SW - sr + 8, y: zy(0) + 3, fill: C.dim, 'font-size': 7.5, 'font-family': MONO }, '0');
    } else if (overlay === 'soc') {
      const zy = v => st + sph * (1 - v / 100);
      add(sub, 'rect', { x: sl, y: zy(90), width: spw, height: zy(20) - zy(90), fill: 'rgba(188,212,124,.04)' });
      [20, 50, 90].forEach(v => {
        add(sub, 'line', { x1: sl, y1: zy(v), x2: SW - sr, y2: zy(v), stroke: 'rgba(236,229,212,.06)', 'stroke-width': .8 });
        add(sub, 'text', { x: sl - 8, y: zy(v) + 3, 'text-anchor': 'end', fill: C.muted, 'font-size': 8, 'font-family': MONO }, v + '%');
      });
      const pts = D.soc.map((v, i) => [sx(i), zy(v)]);
      add(sub, 'path', { d: pts.map((p, i) => (i ? 'L ' : 'M ') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + ' L ' + (SW - sr) + ',' + (st + sph) + ' L ' + sl + ',' + (st + sph) + ' Z', fill: 'url(#termSubFill)' });
      add(sub, 'path', { d: pts.map((p, i) => (i ? 'L ' : 'M ') + p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' '), fill: 'none', stroke: LIME, 'stroke-width': 1.5 });
      add(sub, 'text', { x: SW - sr + 8, y: zy(D.soc[defaultSlot]) + 3, fill: LIME, 'font-size': 8, 'font-family': MONO }, D.soc[defaultSlot].toFixed(1) + '%');
    } else if (overlay === 'margin') {
      const vals = D.netLoad.map((v, i) => D.gridLimit - v);
      const max = Math.max(12, Math.ceil(Math.max.apply(null, vals) / 2) * 2);
      const zy = v => st + sph * (1 - v / max);
      [0, 4, max].forEach(v => {
        add(sub, 'line', { x1: sl, y1: zy(v), x2: SW - sr, y2: zy(v), stroke: v === 4 ? 'rgba(255,93,93,.35)' : 'rgba(236,229,212,.06)', 'stroke-width': v === 4 ? 1 : .8, 'stroke-dasharray': v === 4 ? '4 4' : null });
        add(sub, 'text', { x: sl - 8, y: zy(v) + 3, 'text-anchor': 'end', fill: v === 4 ? '#ff8a8a' : C.muted, 'font-size': 8, 'font-family': MONO }, v + (v === 4 ? '⚠' : ''));
      });
      const bw = Math.max(2, spw / 96 * .55);
      for (let i = 0; i < 96; i++) {
        const v = vals[i];
        const col = v < 4 ? UP : v < 9 ? GOLD : LIME;
        add(sub, 'rect', { x: sx(i) - bw / 2, y: zy(v), width: bw, height: Math.max(1, st + sph - zy(v)), fill: col, opacity: .5 });
      }
      add(sub, 'text', { x: SW - sr + 8, y: zy(vals[defaultSlot]) + 3, fill: vals[defaultSlot] < 4 ? UP : LIME, 'font-size': 8, 'font-family': MONO }, vals[defaultSlot].toFixed(1) + ' MW');
    } else {
      const zy = v => st + sph * (1 - (v - 45) / 31);
      [50, 60, 70].forEach(v => {
        add(sub, 'line', { x1: sl, y1: zy(v), x2: SW - sr, y2: zy(v), stroke: 'rgba(236,229,212,.06)', 'stroke-width': .8 });
        add(sub, 'text', { x: sl - 8, y: zy(v) + 3, 'text-anchor': 'end', fill: C.muted, 'font-size': 8, 'font-family': MONO }, v);
      });
      const pts = D.load.map((v, i) => [sx(i), zy(v)]);
      add(sub, 'path', { d: smooth(pts) + ' L ' + (SW - sr) + ',' + (st + sph) + ' L ' + sl + ',' + (st + sph) + ' Z', fill: 'url(#termSubFill)' });
      add(sub, 'path', { d: smooth(pts), fill: 'none', stroke: STEEL, 'stroke-width': 1.4 });
      add(sub, 'text', { x: SW - sr + 8, y: zy(D.load[defaultSlot]) + 3, fill: STEEL, 'font-size': 8, 'font-family': MONO }, D.load[defaultSlot].toFixed(1) + ' MW');
    }

    const subCross = add(sub, 'line', { x1: 0, y1: st, x2: 0, y2: st + sph, stroke: 'rgba(236,229,212,.4)', 'stroke-width': .8, 'stroke-dasharray': '2 3', opacity: 0 });
    const subDot = add(sub, 'circle', { cx: 0, cy: 0, r: 2.8, fill: ov.color, stroke: '#0d100c', 'stroke-width': 1.2, opacity: 0 });
    const subOverlay = add(sub, 'rect', { x: sl, y: st, width: spw, height: sph, fill: 'transparent', style: 'cursor:crosshair' });
    subEl.appendChild(sub);

    const tip = mainEl.querySelector('.chart-tip');

    function formatOverlay(i) {
      const v = overlayValue(i);
      if (overlay === 'spread') return (v >= 0 ? '+' : '') + v.toFixed(1) + ' 元/MWh';
      if (overlay === 'soc') return v.toFixed(1) + ' %';
      if (overlay === 'margin') return v.toFixed(1) + ' MW';
      return v.toFixed(1) + ' MW';
    }

    function showTip(i, clientX) {
      const p = D.price[i], prev = i ? D.price[i - 1] : p;
      const chg = p - prev, pct = prev ? chg / prev * 100 : 0;
      const up = chg >= 0;
      const e = errPct(p, i);
      let html = '<div class="tip-time">' + range(i) + '<span>D+1 · 预测值</span></div>' +
        '<div class="tip-row"><i>预测价</i><b class="' + (up ? 't-up' : 't-down') + '">¥' + p.toFixed(1) + '</b></div>' +
        '<div class="tip-row"><i>较上一时段</i><b class="' + (up ? 't-up' : 't-down') + '">' + (up ? '+' : '') + chg.toFixed(1) + ' (' + (up ? '+' : '') + pct.toFixed(1) + '%)</b></div>';
      if (mode === 'candle') {
        const open = i ? D.price[i - 1] : D.price[i];
        const err = errPct(p, i) * p * .25;
        html += '<div class="tip-row"><i>开 / 高</i><b>' + open.toFixed(1) + ' / ' + Math.min(1000, Math.max(open, p) + err).toFixed(1) + '</b></div>' +
          '<div class="tip-row"><i>低 / 收</i><b>' + Math.max(0, Math.min(open, p) - err).toFixed(1) + ' / ' + p.toFixed(1) + '</b></div>';
      }
      if (mode === 'backtest') {
        const a = D.actualPrice[i];
        const errPctV = (p - a) / a * 100;
        html += '<div class="tip-row"><i>昨日实际</i><b>¥' + a.toFixed(1) + '</b></div>' +
          '<div class="tip-row"><i>偏差</i><b class="' + (errPctV >= 0 ? 't-up' : 't-down') + '">' + (errPctV >= 0 ? '+' : '') + errPctV.toFixed(1) + '%</b></div>';
      }
      html += '<div class="tip-row"><i>负荷 / SOC</i><b>' + D.load[i].toFixed(1) + ' MW / ' + D.soc[i].toFixed(1) + '%</b></div>' +
        '<div class="tip-row"><i>' + ov.label + '</i><b>' + formatOverlay(i) + '</b></div>' +
        '<div class="tip-note">误差带 <em>±' + Math.round(e * 100) + '%</em> · 预测值，非结算价</div>';
      tip.innerHTML = html;
      tip.hidden = false;
      const mainRect = mainEl.getBoundingClientRect();
      const anchor = clientX == null ? (mainRect.left + mainRect.width * (px(i) / W)) : clientX;
      let left = anchor - mainRect.left + 16;
      if (left + 220 > mainRect.width) left = anchor - mainRect.left - 226;
      tip.style.left = Math.max(8, left) + 'px';
      tip.style.top = '24px';
    }

    function paint(i, ev, withTip) {
      i = clamp(i, 0, 95);
      const x = px(i);
      cross.setAttribute('x1', x); cross.setAttribute('x2', x); cross.setAttribute('opacity', 1);
      dot.setAttribute('cx', x); dot.setAttribute('cy', py(D.price[i])); dot.setAttribute('opacity', 1);
      subCross.setAttribute('x1', sx(i)); subCross.setAttribute('x2', sx(i)); subCross.setAttribute('opacity', 1);
      subDot.setAttribute('cx', sx(i)); subDot.setAttribute('opacity', 1);
      if (overlay === 'load') subDot.setAttribute('cy', st + sph * (1 - (D.load[i] - 45) / 31));
      else if (overlay === 'soc') subDot.setAttribute('cy', st + sph * (1 - D.soc[i] / 100));
      else if (overlay === 'spread') {
        let maxAbs = 0;
        for (let k = 0; k < 96; k++) maxAbs = Math.max(maxAbs, Math.abs(overlayValue(k)));
        maxAbs = Math.max(200, Math.ceil(maxAbs / 100) * 100);
        subDot.setAttribute('cy', st + sph * (1 - (overlayValue(i) + maxAbs) / (maxAbs * 2)));
      } else {
        const vals = D.netLoad.map((v, k) => D.gridLimit - v);
        const max = Math.max(12, Math.ceil(Math.max.apply(null, vals) / 2) * 2);
        subDot.setAttribute('cy', st + sph * (1 - (overlayValue(i) / max)));
      }
      if (withTip) showTip(i, ev ? ev.clientX : null);
      onHover(i);
    }

    function hideHover() {
      cross.setAttribute('opacity', 0); dot.setAttribute('opacity', 0);
      subCross.setAttribute('opacity', 0); subDot.setAttribute('opacity', 0);
      tip.hidden = true;
      onHover(-1);
    }

    function idxFrom(ev, svgEl, x0, width) {
      const rect = svgEl.getBoundingClientRect();
      const xv = (ev.clientX - rect.left) / rect.width * (svgEl === svg ? W : SW);
      return clamp(Math.floor((xv - x0) / width * 96), 0, 95);
    }

    overlayRect.addEventListener('mousemove', function (ev) {
      paint(idxFrom(ev, svg, l, pw), ev, true);
    });
    overlayRect.addEventListener('mouseleave', hideHover);
    subOverlay.addEventListener('mousemove', function (ev) {
      paint(idxFrom(ev, sub, sl, spw), ev, true);
    });
    subOverlay.addEventListener('mouseleave', hideHover);

    return {
      highlight: function (i) { paint(i, null, false); },
      slot: defaultSlot
    };
  }

  window.Charts = { price: priceChart, schedule: scheduleChart, gantt: gantt, longTerm: longTerm, terminal: terminal, colors: C, heat: heat };
})();
