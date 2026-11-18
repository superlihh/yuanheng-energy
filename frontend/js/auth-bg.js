(function () {
  'use strict';

  // 登录墙背景：点阵网格 + 慢速扫描带 + 稀疏信号点（电网蓝色主题）
  // 整体低透明度，不干扰登录卡片阅读。

  const canvas = document.getElementById('auth-bg-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  let w = 0, h = 0, rafId = null;
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // 固定位置的信号点（相对坐标），缓慢呼吸
  const BLIPS = [[0.14, 0.22], [0.82, 0.30], [0.46, 0.66], [0.88, 0.58], [0.22, 0.84]];

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = canvas.clientWidth; h = canvas.clientHeight;
    canvas.width = Math.max(1, Math.round(w * dpr));
    canvas.height = Math.max(1, Math.round(h * dpr));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function draw(now) {
    const t = now * 0.001;
    ctx.clearRect(0, 0, w, h);

    // 点阵网格
    ctx.fillStyle = 'rgba(124,202,236,.075)';
    for (let x = 13; x < w; x += 26) {
      for (let y = 13; y < h; y += 26) ctx.fillRect(x, y, 1, 1);
    }

    // 慢速扫描带（约 22 秒扫过一遍）
    const band = Math.max(90, h * 0.12);
    const span = h + band * 2;
    const y = ((t * 0.045) % 1) * span - band;
    const g = ctx.createLinearGradient(0, y, 0, y + band);
    g.addColorStop(0, 'rgba(81,177,225,0)');
    g.addColorStop(0.5, 'rgba(81,177,225,.06)');
    g.addColorStop(1, 'rgba(81,177,225,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, y, w, band);
    ctx.fillStyle = 'rgba(133,220,255,.18)';
    ctx.fillRect(0, y, w, 1);

    // 信号点呼吸
    for (let i = 0; i < BLIPS.length; i++) {
      const bx = BLIPS[i][0] * w, by = BLIPS[i][1] * h;
      const a = 0.10 + 0.16 * (0.5 + 0.5 * Math.sin(t * (0.7 + i * 0.23) + i * 2.1));
      const glow = ctx.createRadialGradient(bx, by, 0, bx, by, 10);
      glow.addColorStop(0, 'rgba(122,220,255,' + a.toFixed(3) + ')');
      glow.addColorStop(1, 'rgba(122,220,255,0)');
      ctx.fillStyle = glow;
      ctx.beginPath(); ctx.arc(bx, by, 10, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(186,241,255,' + Math.min(0.62, a + 0.24).toFixed(3) + ')';
      ctx.fillRect(bx - 1, by - 1, 2, 2);
    }

    if (!reduceMotion) rafId = requestAnimationFrame(draw);
  }

  function start() {
    resize();
    if (reduceMotion) { draw(0); return; }
    rafId = requestAnimationFrame(draw);
  }

  // 登录页使用项目内置的省级 GeoJSON，避免使用可能失真的简化轮廓。
  function drawChinaGeoJson() {
    const layer = document.getElementById('auth-geo-map');
    if (!layer || !window.fetch) return;
    const project = (point) => {
      const lon = Number(point[0]);
      const lat = Number(point[1]);
      const x = 58 + ((lon - 73) / 62) * 640;
      const y = 44 + ((54 - lat) / 36) * 430;
      return [x.toFixed(1), y.toFixed(1)];
    };
    const ringPath = (ring) => {
      if (!Array.isArray(ring) || ring.length < 3) return '';
      const points = ring.filter(point => Array.isArray(point) && point.length >= 2).map(project);
      return points.length >= 3 ? 'M' + points.map(point => point.join(' ')).join('L') + 'Z' : '';
    };
    const geometryPath = (geometry) => {
      if (!geometry || !geometry.coordinates) return '';
      if (geometry.type === 'Polygon') return geometry.coordinates.map(ringPath).filter(Boolean).join('');
      if (geometry.type === 'MultiPolygon') return geometry.coordinates.flatMap(polygon => polygon.map(ringPath)).filter(Boolean).join('');
      return '';
    };
    fetch('data/china.json', { cache: 'force-cache' })
      .then(response => response.ok ? response.json() : Promise.reject(new Error('map data unavailable')))
      .then(data => {
        const features = Array.isArray(data.features) ? data.features : [];
        const fragment = document.createDocumentFragment();
        features.forEach(feature => {
          const pathData = geometryPath(feature.geometry);
          if (!pathData) return;
          const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
          path.setAttribute('class', 'auth-geo-province');
          path.setAttribute('d', pathData);
          fragment.appendChild(path);
        });
        if (fragment.childNodes.length) layer.appendChild(fragment);
      })
      .catch(() => {});
  }

  window.addEventListener('resize', resize);
  drawChinaGeoJson();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})();
