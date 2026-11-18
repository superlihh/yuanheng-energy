(function () {
  'use strict';

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.prototype.slice.call((root || document).querySelectorAll(selector));
  const esc = value => String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const state = { region: '全国', time: 'today', device: 'all', metric: 'load', query: '', zoom: 1, panX: 0, panY: 0, features: [], polling: null };
  const topology = {
    nodes: [
      { id: 'N-001', name: '晋北能源基地', lon: 112.6, lat: 39.6, status: 'normal', value: '风光出力 18.6 GW' },
      { id: 'N-002', name: '蒙西送端', lon: 111.7, lat: 40.8, status: 'normal', value: '送出负荷 12.4 GW' },
      { id: 'N-003', name: '京津负荷中心', lon: 116.7, lat: 39.4, status: 'warn', value: '线路负载率 82%' },
      { id: 'N-004', name: '华东负荷中心', lon: 121.2, lat: 31.2, status: 'normal', value: '负荷 62.1 GW' },
      { id: 'N-005', name: '川渝清洁能源', lon: 104.2, lat: 30.6, status: 'normal', value: '清洁能源 71%' },
      { id: 'N-006', name: '华中枢纽', lon: 114.3, lat: 30.6, status: 'warn', value: '备用率 11.8%' },
      { id: 'N-007', name: '珠三角负荷中心', lon: 113.4, lat: 23.1, status: 'danger', value: '负荷突增预警' },
      { id: 'N-008', name: '西北新能源基地', lon: 97.4, lat: 38.4, status: 'normal', value: '新能源出力 21.2 GW' }
    ],
    lines: [
      ['N-008', 'N-001', 63], ['N-001', 'N-002', 71], ['N-001', 'N-003', 82], ['N-003', 'N-004', 76],
      ['N-001', 'N-006', 58], ['N-006', 'N-004', 69], ['N-005', 'N-006', 54], ['N-006', 'N-007', 88], ['N-004', 'N-007', 72]
    ]
  };

  function data() { return (window.YUANHENG && window.YUANHENG.data) || {}; }
  function alerts() { return Array.isArray(data().alerts) ? data().alerts : []; }
  function notify(title, message) {
    const wrap = $('#toast-wrap');
    if (!wrap) return;
    const el = document.createElement('div'); el.className = 'toast ok';
    el.innerHTML = '<div><strong>' + esc(title) + '</strong><span>' + esc(message || '') + '</span></div><button class="close" aria-label="关闭">✕</button>';
    wrap.appendChild(el);
    const close = () => { el.style.opacity = '0'; setTimeout(() => el.remove(), 220); };
    el.querySelector('.close').addEventListener('click', close); setTimeout(close, 3600);
  }
  function fmtTime() { return new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }); }
  function openDetail(kicker, title, body) {
    const drawer = $('#drawer');
    if (!drawer) return;
    $('#drawer-kicker').textContent = kicker;
    $('#drawer-title').textContent = title;
    $('#drawer-body').innerHTML = body;
    drawer.classList.add('open'); drawer.setAttribute('aria-hidden', 'false');
    const scrim = $('#scrim'); if (scrim) { scrim.hidden = false; requestAnimationFrame(() => scrim.classList.add('show')); }
  }
  function project(lon, lat) { return [((lon - 73) / 62) * 1000, ((54 - lat) / 36) * 520]; }
  function pathForGeometry(geometry) {
    if (!geometry) return '';
    const poly = points => points.map((p, i) => { const xy = project(p[0], p[1]); return (i ? 'L' : 'M') + xy[0].toFixed(2) + ' ' + xy[1].toFixed(2); }).join(' ') + ' Z';
    const polygon = coords => coords.map(poly).join(' ');
    if (geometry.type === 'Polygon') return polygon(geometry.coordinates);
    if (geometry.type === 'MultiPolygon') return geometry.coordinates.map(polygon).join(' ');
    return '';
  }
  function renderMap() {
    const root = $('#ops-map'); if (!root) return;
    const features = state.features.filter(f => f.properties && f.properties.level === 'province');
    const names = features.length ? features : state.features.slice(0, 34);
    const paths = names.map((feature, index) => '<path class="ops-region" data-region="' + esc(feature.properties.name || ('区域 ' + (index + 1))) + '" d="' + pathForGeometry(feature.geometry) + '"></path>').join('');
    const coords = {}; topology.nodes.forEach(node => { coords[node.id] = project(node.lon, node.lat); });
    const lines = topology.lines.map(line => { const a = coords[line[0]], b = coords[line[1]]; return '<line class="ops-line ' + (line[2] >= 80 ? 'hot' : '') + '" data-flow="' + line[2] + '" x1="' + a[0] + '" y1="' + a[1] + '" x2="' + b[0] + '" y2="' + b[1] + '"></line>'; }).join('');
    const nodes = topology.nodes.map(node => { const p = coords[node.id]; return '<g class="ops-node ' + node.status + '" data-node="' + node.id + '" tabindex="0" role="button" aria-label="' + esc(node.name) + '"><circle class="node-halo" cx="' + p[0] + '" cy="' + p[1] + '" r="14"></circle><circle class="node-dot" cx="' + p[0] + '" cy="' + p[1] + '" r="5"></circle><text x="' + (p[0] + 10) + '" y="' + (p[1] - 8) + '">' + esc(node.name) + '</text></g>'; }).join('');
    root.innerHTML = '<svg class="ops-map-svg" viewBox="0 0 1000 520" aria-hidden="true"><g class="ops-map-world" transform="translate(' + state.panX + ' ' + state.panY + ') scale(' + state.zoom + ')">' + paths + '<g class="ops-lines">' + lines + '</g><g class="ops-nodes">' + nodes + '</g></g></svg>';
  }
  function updateMapText() { const scope = $('#ops-map-scope'); if (scope) scope.textContent = state.region + ' · ' + ({ today: '运行总览', day: '近 24 小时', week: '近 7 天', month: '近 30 天' }[state.time] || '运行总览'); }
  function metricValues() {
    const D = data();
    const load = Number(D.peakLoad || 64.6);
    const current = Number((D.load && D.load[0]) || load * .91);
    const high = topology.lines.filter(line => line[2] >= 80).length;
    const active = alerts().filter(item => ['待处理', '待确认', '处理中'].indexOf(item.status) !== -1).length;
    return { current: current.toFixed(1), balance: Math.max(8.4, 18 - active * .8).toFixed(1), high, active, renewable: '31.8%' };
  }
  function renderKpis() {
    const m = metricValues();
    $('#ops-kpi-load').textContent = m.current; $('#ops-kpi-balance').textContent = m.balance + '%'; $('#ops-kpi-lines').textContent = String(m.high); $('#ops-kpi-alerts').textContent = String(m.active); $('#ops-kpi-renewable').textContent = m.renewable;
    $('#ops-kpi-load-trend').textContent = '较前一时段 +2.6%'; $('#ops-kpi-alert-status').textContent = m.active ? '存在待处理项' : '无待处理项';
  }
  function renderAI() {
    const m = metricValues(); const D = data(); const avg = Number(D.avgPrice || 402.8).toFixed(1);
    const demoNotice = '当前拓扑与线路指标为演示数据，';
    $('#ops-ai-conclusion').textContent = demoNotice + state.region + '当前负荷约 ' + m.current + ' GW，备用率 ' + m.balance + '%；线路高负载 ' + m.high + ' 条，市场参考均价 ' + avg + ' 元/MWh。整体可运行，但需优先关注华中至珠三角方向的输电通道。';
    $('#ops-ai-confidence').textContent = demoNotice ? '演示数据 · 置信度 —' : '置信度 86%'; $('#ops-ai-scope').textContent = state.region + ' / ' + ({ today: '今日', day: '近 24 小时', week: '近 7 天', month: '近 30 天' }[state.time] || '今日'); $('#ops-ai-fresh').textContent = fmtTime();
    $('#ops-ai-recommendation').textContent = '建议先核验高负载线路的实时遥测与备用容量，再将可转移负荷安排到低价和低拥塞时段；所有动作进入人工审核。';
    const list = $('#ops-risk-list'); list.innerHTML = '<li><i class="risk-dot danger"></i>珠三角负荷中心出现负荷突增，需确认生产侧是否存在集中启动。</li><li><i class="risk-dot warn"></i>晋北至京津通道负载率约 82%，建议保留备用断面。</li><li><i class="risk-dot normal"></i>新能源出力波动处于可预测区间，暂不触发弃电风险。</li>';
  }
  function renderTimeline() {
    const D = data(); const rows = alerts().slice(0, 5); const timeline = $('#ops-timeline');
    timeline.innerHTML = (rows.length ? rows : [{ id: 'SYS-001', title: '平台完成运行数据同步', status: '已完成', meta: '当前批次已更新' }]).map((item, index) => '<div class="ops-time-item"><span class="ops-time-mark ' + (index === 0 ? 'active' : '') + '"></span><div><time>' + esc(item.due || ('刚刚 · ' + fmtTime())) + '</time><strong>' + esc(item.title || '运行事件') + '</strong><p>' + esc(item.desc || item.meta || '已写入运行事件时间轴') + '</p></div></div>').join('');
  }
  function renderEvents() {
    const list = $('#ops-event-list'); const rows = alerts().filter(item => ['已解决', '已忽略'].indexOf(item.status) === -1).slice(0, 5);
    $('#ops-event-count').textContent = rows.length + ' 项';
    list.innerHTML = rows.length ? rows.map(item => '<button class="ops-event-row" data-event-id="' + esc(item.id) + '" type="button"><span class="tag ' + (item.levelKey === 'danger' || item.level === '阻断' ? 'tag-danger' : 'tag-warn') + '">' + esc(item.level || '提示') + '</span><span><strong>' + esc(item.title) + '</strong><small>' + esc(item.status || '待处理') + ' · ' + esc(item.meta || '等待处置') + '</small></span><b>›</b></button>').join('') : '<div class="ops-empty">当前没有开放事件。</div>';
  }
  function renderEvidence() {
    const D = data(); const rows = [
      ['实时负荷', (Number(D.peakLoad || 64.6) * .91).toFixed(1) + ' GW', 'dashboard.forecast.load'],
      ['日前均价', Number(D.avgPrice || 402.8).toFixed(1) + ' 元/MWh', 'market.day_ahead_price'],
      ['数据批次', D.meta && D.meta.batch || '待冻结', 'workflow.datasets'],
      ['更新时间', fmtTime(), '平台同步日志']
    ];
    $('#ops-evidence').innerHTML = rows.map(row => '<div class="ops-evidence-row"><span>' + esc(row[0]) + '</span><strong>' + esc(row[1]) + '</strong><small>' + esc(row[2]) + '</small></div>').join('');
  }
  function renderGovernance() {
    const D = data(); const batches = Array.isArray(D.batches) ? D.batches : []; const assets = Math.max(8, batches.length + 4); const metrics = 24; const quality = batches.length ? Math.round(batches.reduce((sum, item) => sum + Number(item.completeness || 86), 0) / batches.length) : 92;
    $('#gov-assets').textContent = assets; $('#gov-metrics').textContent = metrics; $('#gov-quality').textContent = quality + ' / 100'; $('#gov-interfaces').textContent = '98.6%'; $('#gov-tickets').textContent = alerts().filter(item => item.status !== '已解决').length;
    const catalog = [['现货市场价格', 'DWD', '15 分钟', '能源交易中心', '可用'], ['企业负荷与电表', 'ODS', '15 分钟', '企业计量系统', '可用'], ['新能源出力', 'DWD', '15 分钟', '风光功率预测', '可用'], ['设备遥测', 'DWD', '实时', 'SCADA / IoT', '待接入'], ['碳排放核算', 'ADS', '日', '能源管理台账', '可计算']];
    $('#gov-catalog-table').innerHTML = '<thead><tr><th>数据资产</th><th>分层</th><th>更新频率</th><th>来源系统</th><th>状态</th></tr></thead><tbody>' + catalog.map(row => '<tr><td>' + row[0] + '</td><td><span class="tag tag-info">' + row[1] + '</span></td><td>' + row[2] + '</td><td>' + row[3] + '</td><td><span class="tag ' + (row[4] === '可用' || row[4] === '可计算' ? 'tag-ok' : 'tag-warn') + '">' + row[4] + '</span></td></tr>').join('') + '</tbody>';
    const metricsRows = [['实时总负荷', 'MW', '负荷曲线 / 实时'], ['线路负载率', '%', '潮流 / 线路'], ['供需平衡度', '%', '供给 ÷ 需求'], ['单位产品电耗', 'kWh/万瓶', '企业产量 / 电量'], ['预测准确率', '%', '模型回测']];
    $('#gov-metric-grid').innerHTML = metricsRows.map(row => '<div class="gov-metric"><strong>' + row[0] + '</strong><span>' + row[1] + '</span><small>' + row[2] + '</small><button type="button" data-gov-action="metric-detail">查看口径</button></div>').join('');
    $('#gov-health-grid').innerHTML = [['价格接口', '正常', '延迟 1.2 s'], ['负荷接口', '正常', '延迟 2.4 s'], ['设备遥测', '需接入', '等待 SCADA'], ['报表服务', '正常', '成功率 99.8%']].map(row => '<div class="gov-health"><span>' + row[0] + '</span><strong class="' + (row[1] === '正常' ? 'ok' : 'warn') + '">' + row[1] + '</strong><small>' + row[2] + '</small></div>').join('');
    $('#gov-quality-table').innerHTML = '<thead><tr><th>监测项</th><th>评分</th><th>最近异常</th><th>责任人</th><th>处理</th></tr></thead><tbody>' + [['时间完整性', '99.2', '无', '数据管理员', '—'], ['字段一致性', '96.8', '单位映射 2 条', '数据管理员', '查看工单'], ['接口及时性', '98.6', '延迟 1 次', '平台运维', '已恢复']].map(row => '<tr><td>' + row[0] + '</td><td>' + row[1] + '</td><td>' + row[2] + '</td><td>' + row[3] + '</td><td><span class="tag tag-' + (row[4] === '—' ? 'ok' : 'warn') + '">' + row[4] + '</span></td></tr>').join('') + '</tbody>';
    $('#gov-security-grid').innerHTML = [['最小权限', '已启用', '按组织 / 区域 / 设备授权'], ['访问留痕', '已启用', '保留 180 天'], ['敏感字段脱敏', '已启用', '账号、联系方式'], ['备份与恢复', '已配置', '每日快照 / 异地备份'], ['二次确认', '已启用', '审核、导出、删除']].map(row => '<div class="gov-security"><span>' + row[0] + '</span><strong>' + row[1] + '</strong><small>' + row[2] + '</small></div>').join('');
    $('#gov-audit-list').innerHTML = ['管理员查看了数据质量评分', '接口监控完成一次健康检查', '分析员保存了“全国 / 今日 / 负荷”查询条件', '审核负责人导出运行态势报告'].map((item, i) => '<div><time>' + (i + 1) + ' 分钟前</time><span>' + item + '</span><b>已留痕</b></div>').join('');
  }
  function applyFilters() { state.region = ($('#ops-region') || {}).value || '全国'; state.time = ($('#ops-time') || {}).value || 'today'; state.device = ($('#ops-device') || {}).value || 'all'; state.metric = ($('#ops-metric') || {}).value || 'load'; state.query = (($('#ops-search') || {}).value || '').trim(); updateMapText(); renderAI(); renderTimeline(); renderEvents(); renderEvidence(); notify('筛选已应用', state.region + ' · ' + ($('#ops-metric option:checked') || {}).textContent); }
  function refresh() { renderKpis(); renderAI(); renderTimeline(); renderEvents(); renderEvidence(); renderGovernance(); const fresh = $('#ops-freshness'); if (fresh) fresh.textContent = '已更新 · ' + fmtTime(); const updated = $('#ops-map-updated'); if (updated) updated.textContent = '更新时间 ' + fmtTime(); }
  function startPolling() { if (state.polling) clearInterval(state.polling); state.polling = $('#ops-polling') && $('#ops-polling').checked ? setInterval(refresh, 30000) : null; }
  function handleAction(action) {
    if (action === 'risk') openDetail('AI RISK · EVIDENCE', '风险依据', '<div class="drawer-section"><h4>数据依据</h4><div class="evidence-fields"><div><span>负荷预测</span><strong>dashboard.forecast.load · 当前批次</strong></div><div><span>线路负载率</span><strong>topology.line_loading · 82%</strong></div><div><span>事件来源</span><strong>实时告警 / 设备遥测 / 市场价格</strong></div></div></div><p class="drawer-note">AI 只做分析与排序，不直接改变调度指令；建议进入审核流程后执行。</p>');
    if (action === 'create-task') { notify('待办建议已生成', '已保留“核验高负载通道”的处理意图，尚未分派或执行。'); }
    if (action === 'favorite') { localStorage.setItem('yuanheng_ops_favorite', JSON.stringify({ region: state.region, time: state.time, device: state.device, metric: state.metric, savedAt: new Date().toISOString() })); notify('分析条件已暂存', '仅保存于当前浏览器，尚未写入企业工作台。'); }
    if (action === 'save-query') { localStorage.setItem('yuanheng_ops_query', JSON.stringify({ region: state.region, time: state.time, device: state.device, metric: state.metric })); notify('查询条件已保存', '下次进入运行态势可继续使用。'); }
    if (action === 'export') { const content = ['源能运行态势报告', '范围：' + state.region, '更新时间：' + fmtTime(), '结论：' + ($('#ops-ai-conclusion') || {}).textContent, '建议：' + ($('#ops-ai-recommendation') || {}).textContent].join('\n'); const blob = new Blob([content], { type: 'text/plain;charset=utf-8' }); const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = '源能_运行态势报告.txt'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000); notify('报告已导出', '已生成当前筛选范围的简版报告。'); }
  }
  function bind() {
    const map = $('#ops-map');
    if ($('#ops-apply')) $('#ops-apply').addEventListener('click', applyFilters);
    if ($('#ops-refresh')) $('#ops-refresh').addEventListener('click', () => { refresh(); notify('态势已刷新', '已读取当前页面数据和告警状态。'); });
    if ($('#ops-polling')) $('#ops-polling').addEventListener('change', startPolling);
    if ($('#ops-map-zoom-in')) $('#ops-map-zoom-in').addEventListener('click', () => { state.zoom = Math.min(2.4, state.zoom + .18); renderMap(); });
    if ($('#ops-map-zoom-out')) $('#ops-map-zoom-out').addEventListener('click', () => { state.zoom = Math.max(.72, state.zoom - .18); renderMap(); });
    if ($('#ops-map-reset')) $('#ops-map-reset').addEventListener('click', () => { state.zoom = 1; state.panX = 0; state.panY = 0; renderMap(); });
    if (map) {
      map.addEventListener('click', event => { const node = event.target.closest('[data-node]'); if (node) { const item = topology.nodes.find(n => n.id === node.dataset.node); openDetail('NODE · ' + item.id, item.name, '<div class="drawer-section"><h4>节点详情</h4><div class="evidence-fields"><div><span>运行状态</span><strong>' + (item.status === 'normal' ? '正常' : item.status === 'warn' ? '需关注' : '告警') + '</strong></div><div><span>当前指标</span><strong>' + item.value + '</strong></div><div><span>关联权限</span><strong>区域调度 / 运维只读</strong></div></div></div><p class="drawer-note">节点为态势演示拓扑。接入企业 GIS、SCADA 或 IoT 后，可替换为真实设备坐标。</p>'); return; } const line = event.target.closest('[data-flow]'); if (line) { openDetail('LINE · FLOW', '输电通道详情', '<div class="drawer-section"><h4>线路运行信息</h4><div class="evidence-fields"><div><span>当前负载率</span><strong>' + line.dataset.flow + '%</strong></div><div><span>数据来源</span><strong>线路遥测 / 潮流分析</strong></div><div><span>风险等级</span><strong>' + (Number(line.dataset.flow) >= 80 ? '需关注' : '正常') + '</strong></div></div></div><p class="drawer-note">线路详情可接入真实 GIS、SCADA 和调度断面数据；当前拓扑为演示数据。</p>'); return; } const region = event.target.closest('[data-region]'); if (region) { state.region = region.dataset.region; if ($('#ops-region')) $('#ops-region').value = state.region; updateMapText(); renderAI(); notify('已下钻区域', region.dataset.region + ' 的态势指标已刷新。'); } });
      let dragging = false, lastX = 0, lastY = 0;
      map.addEventListener('pointerdown', event => { if (event.target.closest('[data-node],[data-flow],[data-region]')) return; dragging = true; lastX = event.clientX; lastY = event.clientY; map.setPointerCapture(event.pointerId); map.classList.add('dragging'); });
      map.addEventListener('pointermove', event => { if (!dragging) return; state.panX += (event.clientX - lastX) * 1.15; state.panY += (event.clientY - lastY) * 1.15; lastX = event.clientX; lastY = event.clientY; renderMap(); });
      map.addEventListener('pointerup', event => { dragging = false; map.releasePointerCapture(event.pointerId); map.classList.remove('dragging'); });
      map.addEventListener('pointercancel', () => { dragging = false; map.classList.remove('dragging'); });
      map.addEventListener('wheel', event => { event.preventDefault(); state.zoom = Math.max(.72, Math.min(2.4, state.zoom + (event.deltaY < 0 ? .08 : -.08))); renderMap(); }, { passive: false });
    }
    document.addEventListener('click', event => { const action = event.target.closest('[data-ops-action]'); if (action) { event.preventDefault(); handleAction(action.dataset.opsAction); } const eventRow = event.target.closest('[data-event-id]'); if (eventRow) { const item = alerts().find(a => a.id === eventRow.dataset.eventId); if (item) openDetail('ALERT · ' + item.id, item.title, '<div class="drawer-section"><h4>告警详情</h4><p>' + esc(item.desc || '请根据当前告警规则核验现场数据。') + '</p><div class="evidence-fields"><div><span>状态</span><strong>' + esc(item.status || '待处理') + '</strong></div><div><span>处置建议</span><strong>创建任务并提交审核</strong></div></div></div>'); } const tab = event.target.closest('[data-gov-tab]'); if (tab) { $$('.gov-tabs button').forEach(btn => btn.classList.toggle('active', btn === tab)); $$('[data-gov-pane]').forEach(pane => { pane.hidden = pane.dataset.govPane !== tab.dataset.govTab; }); } const gov = event.target.closest('[data-gov-action]'); if (gov) notify('治理操作已记录', '已写入审计日志，等待管理员继续处理。'); });
    const search = $('#gov-search'); if (search) search.addEventListener('input', () => { const q = search.value.trim().toLowerCase(); $$('.gov-metric').forEach(item => { item.hidden = q && item.textContent.toLowerCase().indexOf(q) === -1; }); });
    updateMapText(); startPolling();
  }
  async function loadMap() { try { const response = await fetch('data/china.json'); const payload = await response.json(); state.features = Array.isArray(payload.features) ? payload.features : []; renderMap(); } catch (_) { renderMap(); } }
  function init() { bind(); loadMap(); refresh(); }
  window.YUANHENG_OPERATIONS = { refresh: refresh, renderMap: renderMap };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true }); else init();
})();
