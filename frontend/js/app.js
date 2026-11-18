(function () {
  'use strict';

  const D = window.DATA;
  const C = window.Charts;
  const $ = function (s, r) { return (r || document).querySelector(s); };
  const $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  const nf = new Intl.NumberFormat('zh-CN');
  const validNumber = n => n !== null && n !== undefined && Number.isFinite(Number(n));
  const fmtInt = n => validNumber(n) ? nf.format(Math.round(Number(n))) : '—';
  const fmtCost = n => validNumber(n) ? '¥' + fmtInt(n) : '—';
  const fmtDiff = n => !validNumber(n) ? '—' : (n > 0 ? '+' : n < 0 ? '−' : '') + '¥' + fmtInt(Math.abs(n));
  const esc = s => String(s).replace(/[&<>"']/g, m => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m]));
  const pad = n => String(n).padStart(2, '0');

  const state = {
    view: 'overview',
    layers: { price: true, load: true, band: true, windows: true },
    selectedScheme: 'S4',
    sensMode: 'fixed',
    ghost: true,
    alertLevel: 'all',
    alertType: 'all',
    alertStatus: 'all',
    alertQuery: '',
    dataTab: 'catalog',
    reviewStatus: '审核中',
    decisionMode: 'cost',
    termMode: 'line',
    termOverlay: 'load',
    termOverlayMain: false,
    termSlot: 76,
    recalcDone: false
  };
  let termApi = null;

  const VIEWS = ['operations', 'assistant', 'overview', 'terminal', 'compare', 'schedule', 'devices', 'longterm', 'alerts', 'data', 'explain', 'review', 'governance'];
  const OPEN_STATES = ['待处理', '待确认', '处理中'];

  /* ---------------------------------------------------------
     shell / routing
     --------------------------------------------------------- */
  function go(view, push) {
    if (VIEWS.indexOf(view) === -1) view = 'overview';
    const advanced = ['terminal', 'schedule', 'alerts', 'longterm', 'explain'];
    const advancedMenu = $('.nav-more-tools');
    if (advancedMenu && advanced.indexOf(view) !== -1) advancedMenu.open = true;
    if (!$('#modal').hidden) closeModal();
    if ($('#drawer').classList.contains('open')) closeDrawer();
    if (!$('#palette').hidden) closePalette();
    state.view = view;
    $$('.view').forEach(v => v.classList.remove('active'));
    $('.nav a[data-view="' + view + '"]').classList.add('active');
    const target = $('#view-' + view);
    target.classList.add('active');
    $$('.nav a').forEach(a => a.classList.toggle('active', a.dataset.view === view));
    $$('.reveal', target).forEach((el, i) => {
      el.style.animation = 'none';
      void el.offsetHeight;
      el.style.animation = '';
      el.style.animationDelay = (i * 55) + 'ms';
    });
    window.scrollTo(0, 0);
    if (push !== false && ('#' + view) !== location.hash) {
      history.pushState(null, '', '#' + view);
    }
    document.title = '源能 · ' + ({
      operations: '运行态势', assistant: '能源智能问答', overview: '调度总览', terminal: '价格预测', compare: '五方案比较', schedule: '时序排程', devices: '设备与产线', longterm: '长期规划',
      alerts: '预警中心', data: '数据与账单', explain: '策略解释', review: '版本审核', governance: '数据治理'
    })[view];
  }

  /* ---------------------------------------------------------
     toast / drawer / modal
     --------------------------------------------------------- */
  function toast(title, msg, kind) {
    const wrap = $('#toast-wrap');
    const el = document.createElement('div');
    el.className = 'toast ' + (kind || '');
    el.innerHTML = '<div><strong>' + esc(title) + '</strong>' + (msg ? '<span>' + esc(msg) + '</span>' : '') + '</div><button class="close" aria-label="关闭">✕</button>';
    wrap.appendChild(el);
    const kill = () => { el.style.opacity = '0'; el.style.transform = 'translateY(6px)'; setTimeout(() => el.remove(), 220); };
    el.querySelector('.close').addEventListener('click', kill);
    setTimeout(kill, 4200);
  }

  function syncLock() {
    const locked = $('#drawer').classList.contains('open') || !$('#modal').hidden || !$('#palette').hidden;
    document.body.style.overflow = locked ? 'hidden' : '';
  }

  function openDrawer(kicker, title, body) {
    $('#drawer-kicker').textContent = kicker;
    $('#drawer-title').textContent = title;
    $('#drawer-body').innerHTML = body;
    $('#drawer').classList.add('open');
    $('#drawer').setAttribute('aria-hidden', 'false');
    const scrim = $('#scrim');
    scrim.hidden = false;
    requestAnimationFrame(() => scrim.classList.add('show'));
    syncLock();
    $('#drawer-body').scrollTop = 0;
  }
  function closeDrawer() {
    $('#drawer').classList.remove('open');
    $('#drawer').setAttribute('aria-hidden', 'true');
    const scrim = $('#scrim');
    scrim.classList.remove('show');
    setTimeout(() => { if (!scrim.classList.contains('show')) scrim.hidden = true; }, 320);
    syncLock();
  }

  let modalConfirm = null;
  function openModal(opts) {
    $('#modal-kicker').textContent = opts.kicker || 'ACTION';
    $('#modal-title').textContent = opts.title || '确认操作';
    $('#modal-body').innerHTML = opts.html + (opts.textarea
      ? '<label class="field-label" for="modal-text">审核意见（必填）</label><textarea id="modal-text" placeholder="' + esc(opts.placeholder || '填写审核意见') + '"></textarea><div class="modal-error" id="modal-error"></div>'
      : '');
    $('#modal-foot').innerHTML =
      '<button class="btn btn-ghost btn-sm" data-modal="cancel">取消</button>' +
      '<button class="btn btn-primary btn-sm" data-modal="confirm">' + esc(opts.confirmText || '确认') + '</button>';
    modalConfirm = opts;
    $('#modal').hidden = false;
    syncLock();
    if (opts.textarea) setTimeout(() => { const t = $('#modal-text'); if (t) t.focus(); }, 60);
  }
  function closeModal() {
    $('#modal').hidden = true;
    modalConfirm = null;
    syncLock();
  }

  /* ---------------------------------------------------------
     command console (⌘K)
     --------------------------------------------------------- */
  let palItems = [], palIndex = 0;

  function paletteCommands() {
    const cmds = [];
    [
      ['operations', '运行态势', '全国态势 · AI 分析 · 告警闭环'],
      ['assistant', '能源智能问答', '自然语言查询 · 图表联动 · 证据引用'],
      ['overview', '调度总览', '价格 × 负荷 · 推荐 S4'],
      ['terminal', '价格预测', '分时 / 时段K / 误差带 / 回测'],
      ['compare', '五方案比较', '成本构成 · 敏感性 · 推荐排序'],
      ['schedule', '时序排程', '96 时段 · 储能 · 工序 · 价格分层'],
      ['devices', '设备与产线', '设备台账 · 只读遥测 · 现场接入边界'],
      ['longterm', '长期规划', '合同覆盖走廊 · 投资情景'],
      ['alerts', '预警中心', '阻断 / 重要 / 一般 / 提示'],
      ['data', '数据与账单', '批次质量 · 账单核对 · actualSaving'],
      ['explain', '策略解释', '证据引用 · 重新优化'],
      ['review', '版本审核', 'V-S4-003 · 审批流 · 审计记录'],
      ['governance', '数据治理', '目录 · 质量 · 接口 · 安全审计']
    ].forEach(v => cmds.push({
      group: '视图', label: v[1], sub: v[2], hint: 'GOTO ' + v[0].toUpperCase(),
      action: function () { go(v[0]); }
    }));

    D.schemes.forEach(s => cmds.push({
      group: '五方案', label: s.id + ' · ' + s.name, sub: s.note,
      hint: s.diff ? fmtDiff(s.diff) + ' · ' + s.feasibleText : 'BASE',
      action: function () { selectScheme(s.id); go('compare'); }
    }));

    D.alerts.filter(a => OPEN_STATES.indexOf(a.status) !== -1).slice(0, 4).forEach(a => cmds.push({
      group: '预警', label: a.id + ' · ' + a.title, sub: a.type + ' · ' + a.status,
      hint: a.level,
      action: function () {
        go('alerts');
        setTimeout(function () { openAlert(a.id); }, 160);
      }
    }));

    EV_ORDER.forEach(id => {
      const e = D.evidence[id];
      if (!e) return;
      cmds.push({
        group: '证据', label: id + ' · ' + e.name, sub: '绑定 V-S4-003 / ' + D.meta.calc,
        hint: 'EVIDENCE',
        action: function () { openEvidence(id); }
      });
    });

    D.batches.slice(0, 6).forEach(b => cmds.push({
      group: '数据批次', label: b.id, sub: b.name, hint: b.status,
      action: function () { openBatch(b.id); }
    }));

    cmds.push({ group: '动作', label: '导出决策报告', sub: 'HTML · 可打印 / 另存为 PDF', hint: 'EXPORT', action: exportReport });
    cmds.push({
      group: '动作', label: '进入版本审核', sub: 'V-S4-003 · 审核中 · 提交人不可自批',
      hint: 'REVIEW', action: function () { go('review'); }
    });
    return cmds;
  }

  function renderPalette(query) {
    const q = (query || '').trim().toLowerCase();
    const all = paletteCommands();
    palItems = all.filter(c => {
      if (!q) return true;
      return (c.group + ' ' + c.label + ' ' + (c.sub || '') + ' ' + (c.hint || '')).toLowerCase().indexOf(q) !== -1;
    });
    if (palIndex >= palItems.length) palIndex = 0;
    if (palIndex < 0) palIndex = Math.max(0, palItems.length - 1);

    const results = $('#palette-results');
    if (!palItems.length) {
      results.innerHTML = '<div class="pal-empty">没有匹配的指令 · 尝试“方案”“预警”或“E-0231”</div>';
      return;
    }
    let html = '', lastGroup = '';
    palItems.forEach(function (c, i) {
      if (c.group !== lastGroup) {
        html += '<div class="pal-group">' + esc(c.group) + '</div>';
        lastGroup = c.group;
      }
      html += '<div class="pal-item' + (i === palIndex ? ' active' : '') + '" data-pal-index="' + i + '" role="option" aria-selected="' + (i === palIndex) + '">' +
        '<span class="pal-idx">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="pal-label">' + esc(c.label) + (c.sub ? '<small>' + esc(c.sub) + '</small>' : '') + '</span>' +
        '<span class="pal-hint">' + esc(c.hint || '') + '</span></div>';
    });
    results.innerHTML = html;
    const active = results.querySelector('.pal-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function openPalette() {
    if (!$('#modal').hidden) closeModal();
    if ($('#drawer').classList.contains('open')) closeDrawer();
    $('#palette').hidden = false;
    const input = $('#palette-input');
    input.value = '';
    palIndex = 0;
    renderPalette('');
    syncLock();
    setTimeout(function () { input.focus(); }, 30);
  }

  function closePalette() {
    if ($('#palette').hidden) return;
    $('#palette').hidden = true;
    if ($('#palette-input')) $('#palette-input').blur();
    syncLock();
  }

  function updatePaletteActive() {
    $$('#palette-results .pal-item').forEach(function (el, i) {
      el.classList.toggle('active', i === palIndex);
      el.setAttribute('aria-selected', i === palIndex ? 'true' : 'false');
    });
    const active = $('#palette-results .pal-item.active');
    if (active) active.scrollIntoView({ block: 'nearest' });
  }

  function executePalette(i) {
    const cmd = palItems[i];
    if (!cmd) return;
    closePalette();
    setTimeout(function () { cmd.action(); }, 60);
  }

  /* ---------------------------------------------------------
     overview
     --------------------------------------------------------- */
  function hydrateKpis() {
    $('#kpi-avg-price').textContent = D.avgPrice.toFixed(1);
    $('#kpi-max-price').textContent = fmtInt(D.maxPrice);
    $('#kpi-max-time').textContent = D.meta.timeOf(D.maxIdx);
    $('#kpi-peak-load').textContent = D.peakLoad.toFixed(1);
    $('#kpi-peak-time').textContent = D.meta.timeOf(D.peakIdx);
  }

  function renderPrice() {
    C.price($('#price-chart'), D, state.layers);
  }

  function tagClassForLevel(levelKey) {
    return levelKey === 'block' ? 'tag-danger' : levelKey === 'important' ? 'tag-warn' : levelKey === 'general' ? 'tag-info' : 'tag-neutral';
  }

  function statusTagClass(status) {
    return status === '已解决' ? 'tag-ok' : status === '处理中' ? 'tag-info' : status === '已忽略' ? 'tag-neutral' : status === '待处理' ? 'tag-danger' : 'tag-warn';
  }

  function fieldOf(obj, key) {
    const f = (obj.fields || []).find(x => x[0] === key);
    return f ? f[1] : '—';
  }

  function openAlertsCount() {
    return D.alerts.filter(a => OPEN_STATES.indexOf(a.status) !== -1).length;
  }

  function updateAlertBadges() {
    const open = openAlertsCount();
    $('#nav-alert-count').textContent = open;
    const b = $('#bell .badge-dot');
    if (b) b.textContent = open;
  }

  function renderAlertMini() {
    const open = D.alerts.filter(a => OPEN_STATES.indexOf(a.status) !== -1);
    const blocks = open.filter(a => a.levelKey === 'block').length;
    const list = open.filter(a => a.levelKey === 'block' || a.levelKey === 'important').slice(0, 2);
    $('#alert-mini').innerHTML =
      '<div class="panel-head"><div><div class="micro">ALERTS · OPEN</div><h2>待处理预警</h2></div>' +
      '<div class="mini-count"><strong>' + open.length + '</strong><span class="' + (blocks ? 'red' : '') + '">' + blocks + ' 阻断</span></div></div>' +
      '<div class="alert-mini-list">' +
      list.map(a =>
        '<div class="mini-alert lv-' + a.levelKey + '" data-alert="' + a.id + '" role="button" tabindex="0">' +
        '<span class="bar"></span><div><h4>' + esc(a.title) + '</h4><p>' + a.type + ' · ' + a.id + '</p></div>' +
        '<span class="tag ' + tagClassForLevel(a.levelKey) + '">' + a.level + '</span></div>'
      ).join('') +
      '</div>' +
      '<div class="panel-foot"><span>阻断预警阻止批准与执行</span><button class="link" data-goto="alerts">预警中心 →</button></div>';
  }

  function renderOverviewBatches() {
    const picks = [D.batches[0], D.batches[2], D.batches[4], D.batches[6]].filter(Boolean);
    const names = ['日前价格', '企业计量', '合同曲线 v4', '正式账单'];
    if (!picks.length) {
      $('#overview-batches').innerHTML = '<li><span class="dl-name"><i class="bad-dot"></i>尚无企业数据批次</span><span class="dl-val">待导入</span></li>';
      return;
    }
    $('#overview-batches').innerHTML = picks.map((b, i) => {
      const dot = b.statusKey === 'ok' ? '' : b.statusKey === 'warn' ? 'warn-dot' : 'bad-dot';
      return '<li><span class="dl-name"><i class="' + dot + '"></i>' + names[i] + '</span><span class="dl-val">' +
        (b.completeness === null ? esc(b.status) : b.completeness + '% · ' + esc(b.status)) +
        '</span></li>';
    }).join('');
  }

  function renderSchemeStrip() {
    const max = Math.max.apply(null, D.schemes.map(s => s.diff));
    $('#scheme-strip').innerHTML = D.schemes.map(s => {
      const width = s.diff === 0 ? 2 : Math.max(6, Math.round(s.diff / max * 100));
      const tcls = s.id === 'S4' ? 'tag-amber' : s.id === 'S0' ? 'tag-neutral' : s.natureTag === 'warn' ? 'tag-warn' : 'tag-ok';
      const label = s.id === 'S4' ? '推荐' : s.id === 'S0' ? '基准' : s.natureTag === 'warn' ? '合同量未优化' : '可行';
      return '<div class="scheme-row' + (s.id === 'S0' ? ' is-base' : '') + (s.id === 'S4' ? ' is-s4' : '') + '" data-scheme="' + s.id + '" role="button" tabindex="0">' +
        '<div class="s-id">' + s.id + '</div>' +
        '<div class="s-name">' + esc(s.name) + '<span class="tag ' + tcls + '">' + label + '</span><span class="s-note">' + esc(s.note) + '</span></div>' +
        '<div class="s-bar"><i style="width:' + width + '%"></i></div>' +
        '<div class="s-diff">' + (s.diff ? fmtDiff(s.diff) : '基准') + '</div>' +
        '<div class="s-status"><span class="tag ' + (s.feasible ? 'tag-ok' : 'tag-danger') + '">' + esc(s.feasibleText) + '</span></div>' +
        '<div class="s-go">→</div></div>';
    }).join('');
  }

  /* ---------------------------------------------------------
     compare
     --------------------------------------------------------- */
  function selectedScheme() {
    return D.schemes.find(s => s.id === state.selectedScheme) || D.schemes[4];
  }

  function selectScheme(id) {
    state.selectedScheme = id;
    renderSchemeCards();
    renderComposition();
    renderSchemeDetail();
  }

  function schemeTagMeta(s) {
    if (s.id === 'S0') return ['tag-neutral', '基准'];
    if (s.id === 'S4') return ['tag-amber', '推荐'];
    if (s.natureTag === 'warn') return ['tag-warn', s.tag];
    return ['tag-ok', s.tag];
  }

  function renderSchemeCards() {
    $('#scheme-cards').innerHTML = D.schemes.map(s => {
      const tm = schemeTagMeta(s);
      return '<button class="scheme-card' + (s.id === 'S4' ? ' sc-s4' : '') + (s.id === state.selectedScheme ? ' selected' : '') + '" data-scheme="' + s.id + '" type="button">' +
        '<div class="sc-top"><span class="sc-id">' + s.id + '</span><span class="tag ' + (s.feasible ? tm[0] : 'tag-danger') + '">' + esc(s.feasibleText) + '</span></div>' +
        '<div class="sc-name">' + esc(s.name) + '</div>' +
        '<div class="sc-cost">' + fmtInt(s.cost) + '<small>元</small></div>' +
        '<div class="sc-diff' + (s.diff === 0 ? ' base' : '') + '">' + (s.diff === 0 ? '基准成本' : fmtDiff(s.diff) + ' vs S0') + '</div>' +
        '<div class="sc-foot"><span>' + esc(s.nature) + '</span><span>' + esc(s.id === 'S4' ? '独立求解' : s.note) + '</span></div>' +
        '</button>';
    }).join('');
  }

  function renderComposition() {
    const parts = [
      ['energy', '电能费', 'seg-energy'],
      ['contract', '合同差额', 'seg-contract'],
      ['bess', '储能 / 寿命', 'seg-bess'],
      ['ops', '固定运维', 'seg-ops'],
      ['other', '其他', 'seg-other']
    ];
    const scale = 500000;
    $('#composition').innerHTML =
      '<div class="comp-legend">' + parts.map(p => '<span class="legend-item"><i class="sw" style="background:' +
        ({ energy: '#d99a3c', contract: '#5d8a94', bess: '#93ad57', ops: '#5b5c4c', other: '#393b31' })[p[0]] + '"></i>' + p[1] + '</span>').join('') + '</div>' +
      D.schemes.map(s => {
        const segs = parts.map(p => {
          const v = s.comp[p[0]];
          return '<span class="comp-seg ' + p[2] + '" style="width:' + (v / scale * 100).toFixed(2) + '%" title="' + p[1] + ' ' + fmtCost(v) + '"></span>';
        }).join('');
        return '<div class="comp-row' + (s.id === state.selectedScheme ? ' is-selected' : '') + '" data-scheme="' + s.id + '">' +
          '<span class="cr-id">' + s.id + '</span>' +
          '<div class="cr-track">' + segs + '</div>' +
          '<span class="cr-total">' + fmtInt(s.cost) + '</span></div>';
      }).join('') +
      '<div class="comp-scale"><span>0</span><span>250k</span><span>500k 元</span></div>';
  }

  function renderSchemeDetail() {
    const s = selectedScheme();
    const tm = schemeTagMeta(s);
    $('#detail-name').textContent = s.id + ' · ' + s.name;
    $('#detail-tag').className = 'tag ' + tm[0];
    $('#detail-tag').textContent = tm[1];
    const pct = s.diff / D.schemes[0].cost * 100;
    $('#scheme-detail').innerHTML =
      '<div class="detail-money">' +
      '<div class="dm-main">' + fmtInt(s.cost) + '<small>元 / 模拟成本</small></div>' +
      '<div class="dm-diff">' + (s.diff ? fmtDiff(s.diff) + ' · ' + pct.toFixed(1) + '% vs S0' : '基准方案 · 差额 0') + '</div>' +
      '</div>' +
      '<div class="detail-tags">' +
      '<span class="tag ' + (s.feasible ? 'tag-ok' : 'tag-danger') + '">' + esc(s.feasibleText) + '</span>' +
      '<span class="tag ' + (s.natureTag === 'warn' ? 'tag-warn' : s.natureTag === 'lime' ? 'tag-lime' : 'tag-neutral') + '">' + esc(s.nature) + '</span>' +
      '<span class="tag tag-neutral">' + D.meta.calc + '</span>' +
      '<span class="tag tag-neutral">同一批次 / 同一约束集</span>' +
      '</div>' +
      '<div class="detail-block"><h4>改变了什么</h4><ul>' + s.changes.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' +
      '<div class="detail-block"><h4>保持不变</h4><ul>' + s.keeps.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' +
      '<div class="detail-block"><h4>风险与限制</h4><ul>' + s.risks.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul></div>' +
      (s.id === 'S1' ? '<div class="detail-warn">交易产品资格与交割曲线未齐备 → 合同量优化显示“数据不足”，金额保持为空，不以 0 替代。</div>' : '') +
      (s.id === 'S4' ? '<div class="detail-warn">固定动作 +10% 负荷时，13:45 并网 76.6 MW 超过 74 MW → 该情景不可执行；重新优化另存草案。</div>' : '');
  }

  function renderSensitivity() {
    const mode = D.sensitivity[state.sensMode];
    $('#sens-desc').textContent = mode.desc;
    $$('#sens-mode .seg-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === state.sensMode));
    const cols = ['价格 +50 元/MWh', '价格 −50 元/MWh', '负荷 +10%', '负荷 −10%'];
    $('#sensitivity-table').innerHTML =
      '<thead><tr><th>方案</th><th style="text-align:right">基准差额</th>' + cols.map(c => '<th style="text-align:right">' + c + '</th>').join('') + '</tr></thead><tbody>' +
      mode.rows.map(r => {
        return '<tr><td><span class="sens-row-id">' + r.id + '</span><span class="sens-row-name">' + esc(r.name) + '</span></td>' +
          '<td class="num pos">' + fmtDiff(r.base) + '</td>' +
          r.cells.map(c => {
            return '<td class="num"><div class="sens-cell"><span class="' + (c.ok ? 'num pos' : 'num dim') + '" style="text-align:right">' + fmtDiff(c.v) + '</span>' +
              (!c.ok ? '<span class="sc-status">不可执行</span>' : c.draft ? '<span class="sc-status ok">' + c.draft + '</span>' : '') +
              '</div></td>';
          }).join('') +
          '</tr>';
      }).join('') + '</tbody>';
    const note = $('.sens-mode-note');
    if (note) note.textContent = state.sensMode === 'fixed'
      ? '同一扰动同时作用于 S0 与候选 · 固定动作 · 越限即不可执行'
      : '重新优化结果生成独立草案 · 不覆盖 V-S4-003';
  }

  /* ---------------------------------------------------------
     forecast terminal
     --------------------------------------------------------- */
  const TERM_DEFAULT = 76;

  function termErr(v, i) {
    return (0.06 + 0.16 * Math.pow(v / 1000, 2)) * (i >= 72 && i <= 84 ? 1.9 : 1);
  }

  function updateTermQuote(i, label) {
    const p = D.price[i], prev = i ? D.price[i - 1] : p;
    const chg = p - prev, pct = prev ? chg / prev * 100 : 0;
    const up = chg >= 0;
    const last = $('#term-last'), chgEl = $('#term-chg');
    if (!last) return;
    last.textContent = Math.round(p);
    last.className = up ? 't-up' : 't-down';
    chgEl.textContent = (up ? '+' : '') + pct.toFixed(1) + '%';
    chgEl.className = up ? 't-up' : 't-down';
    $('#term-delta').textContent = (up ? '+' : '') + chg.toFixed(1);
    $('#term-quote-time').textContent = (label || '最新预测') + ' · ' + D.meta.timeOf(i);
  }

  function renderTermWindows() {
    const rows = [
      { time: D.meta.timeOf(D.maxIdx), title: '晚峰最高', meta: '18:00–21:00 · 放电窗口', value: '¥' + Math.round(D.maxPrice), cls: 't-up', note: '预测' },
      { time: D.meta.timeOf(D.minIdx), title: '全日最低', meta: '午间低价 · 充电 / 移峰', value: '¥' + Math.round(D.minPrice), cls: 't-down', note: '预测' },
      { time: D.meta.timeOf(D.netPeakIdx), title: '并网峰值', meta: '上限 ' + D.gridLimit + ' MW · 余量 ' + (D.gridLimit - D.netPeak).toFixed(1) + ' MW', value: D.netPeak.toFixed(1) + ' MW', cls: '', note: '约束' },
      { time: '全日', title: '峰谷价差', meta: '最高 − 最低 · 覆盖储能损耗', value: '¥' + Math.round(D.maxPrice - D.minPrice), cls: 't-up', note: '价差' }
    ];
    $('#term-windows').innerHTML = rows.map(r =>
      '<li><span class="tw-time">' + esc(r.time) + '</span>' +
      '<div class="tw-main"><strong>' + esc(r.title) + '</strong><small>' + esc(r.meta) + '</small></div>' +
      '<span class="tw-val ' + r.cls + '">' + esc(r.value) + '<em>' + esc(r.note) + '</em></span></li>'
    ).join('');
  }

  function renderTermErrors() {
    const f = D.forecastStats;
    const rows = [
      { label: '价格 MAPE', value: f.mape, threshold: 10, hero: true },
      { label: '负荷 MAPE', value: f.loadMape, threshold: 5 },
      { label: '晚峰 MAPE', value: f.highMape, threshold: 15 },
      { label: '数据完整率', value: 99.2, threshold: 95, good: true }
    ];
    $('#term-errors').innerHTML = rows.map(r => {
      const cls = r.good ? 'good' : r.value / r.threshold > .85 ? 'warn' : '';
      return '<div class="teb-metric' + (r.hero ? ' hero' : '') + '">' +
        '<div class="tm-top"><span>' + esc(r.label) + '</span><em>阈值 ' + (r.good ? '≥' : '≤') + r.threshold + '%</em></div>' +
        '<strong>' + r.value.toFixed(1) + '<small>%</small></strong>' +
        '<div class="teb-bar"><i class="' + cls + '" style="width:' + Math.min(100, r.value / r.threshold * 100).toFixed(0) + '%"></i></div></div>';
    }).join('');
  }

  function renderTermTape() {
    const center = state.termSlot;
    const start = Math.max(0, Math.min(D.N - 7, center - 3));
    let html = '<div class="tape-head"><span>时间</span><span>预测</span><span>涨跌</span><span>负荷</span></div>';
    for (let i = start; i < start + 7; i++) {
      const p = D.price[i], prev = i ? D.price[i - 1] : p;
      const pct = prev ? (p - prev) / prev * 100 : 0;
      const up = pct >= 0;
      html += '<div class="tape-row' + (i === center ? ' is-active' : '') + '" data-term-slot="' + i + '">' +
        '<span class="tt-time">' + D.meta.timeOf(i) + '</span>' +
        '<span class="tt-price">' + Math.round(p) + '</span>' +
        '<span class="tt-chg ' + (up ? 't-up' : 't-down') + '">' + (up ? '+' : '') + pct.toFixed(1) + '%</span>' +
        '<span class="tt-load">' + D.load[i].toFixed(1) + '</span></div>';
    }
    $('#term-tape').innerHTML = html;
  }

  function updateTermTabs() {
    $$('#term-modes .term-tab').forEach(b => {
      const on = b.dataset.fmode === state.termMode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    $$('#term-overlays .term-tab').forEach(b => {
      const on = b.dataset.overlay === state.termOverlay;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    const notes = {
      line: '分时：预测价格与日均线；副图可切换负荷、价差、SOC 与并网余量。',
      candle: '时段K：O=前一时段预测，C=当前预测，H/L=误差带的 25%，用于展示不确定性，非成交价。',
      band: '误差带：晚峰按 1.9 倍放大；用于评估报价风险，不构成报价建议。',
      backtest: '回测：上一日实际 vs 今日预测，样本 90 天；MAPE ' + D.forecastStats.mape + '%。'
    };
    $('#term-note').textContent = notes[state.termMode] || notes.line;
  }

  function renderTermChart() {
    const main = $('#term-chart');
    const sub = $('#term-subchart');
    if (!main || !sub) return;
    termApi = C.terminal(main, sub, D, {
      mode: state.termMode,
      overlay: state.termOverlay,
      overlayMain: state.termOverlayMain,
      slot: state.termSlot,
      onHover: termHover
    });
  }

  function focusTermSlot(i) {
    state.termSlot = i;
    if (termApi) termApi.highlight(i);
    updateTermQuote(i, '聚焦');
    $$('#term-tape .tape-row').forEach(r => r.classList.toggle('is-active', Number(r.dataset.termSlot) === i));
  }

  function termHover(i) {
    if (i == null || i < 0) {
      updateTermQuote(TERM_DEFAULT, '最新预测');
      return;
    }
    updateTermQuote(i, '光标');
  }

  function hydrateTerminal() {
    const f = D.forecastStats;
    updateTermQuote(TERM_DEFAULT, '最新预测');
    $('#term-high').textContent = Math.round(D.maxPrice);
    $('#term-high-time').textContent = D.meta.timeOf(D.maxIdx);
    $('#term-low').textContent = Math.round(D.minPrice);
    $('#term-low-time').textContent = D.meta.timeOf(D.minIdx);
    $('#term-avg').textContent = D.avgPrice.toFixed(1);
    $('#term-band').textContent = '±' + Math.round(termErr(D.price[TERM_DEFAULT], TERM_DEFAULT) * 100) + '%';
    $('#term-loadpeak').textContent = D.peakLoad.toFixed(1);
    const om = $('#overview-mape');
    if (om) om.textContent = f.mape.toFixed(1) + '%';
    renderTermWindows();
    renderTermErrors();
    renderTermTape();
    updateTermTabs();
    renderTermChart();
  }

  function exportForecastCSV() {
    const head = ['时间', '日前预测_元每MWh', '上一日实际_元每MWh', '预测负荷_MW', '储能功率_MW', 'SOC_%', '净负荷_MW', '并网余量_MW'];
    const lines = [head.join(',')];
    for (let i = 0; i < D.N; i++) {
      lines.push([
        D.meta.timeOf(i), D.price[i], D.actualPrice[i], D.load[i], D.bessPower[i], D.soc[i], D.netLoad[i], (D.gridLimit - D.netLoad[i]).toFixed(1)
      ].join(','));
    }
    const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '源能_日前价格预测_2026-03-04.csv';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 30000);
    toast('行情已导出', 'CSV · 96 时段 · 含预测与实际回测', 'ok');
  }

  function renderDecision() {
    const cfg = D.decision;
    const mode = cfg.modes.find(m => m.key === state.decisionMode) || cfg.modes[0];
    $('#decision-mode').innerHTML = cfg.modes.map(m =>
      '<button class="seg-btn' + (m.key === mode.key ? ' active' : '') + '" data-decision="' + m.key + '" type="button">' + m.label + '</button>'
    ).join('');
    $('#decision-desc').textContent = mode.desc;

    const rows = cfg.schemes.map(s => {
      const score = cfg.dims.reduce((sum, d) => sum + s.scores[d.key] * mode.weights[d.key], 0);
      return { id: s.id, scores: s.scores, score: Math.round(score * 10) / 10 };
    }).sort((a, b) => b.score - a.score);

    const nameOf = id => (D.schemes.find(s => s.id === id) || {}).name || '';
    const top = rows[0];
    $('#decision-summary').innerHTML =
      '<div><span>当前偏好</span><strong>' + esc(mode.label) + '</strong></div>' +
      '<div class="rec"><span>推荐候选</span><strong>' + top.id + ' · ' + esc(nameOf(top.id)) + '</strong></div>' +
      '<div class="score"><span>综合得分</span><strong>' + top.score.toFixed(1) + '</strong></div>';

    const weightOf = key => Math.round(mode.weights[key] * 100) + '%';
    $('#decision-table').innerHTML =
      '<thead><tr><th>排名</th><th>方案</th>' +
      cfg.dims.map(d => '<th style="text-align:right">' + d.label + ' <em>' + weightOf(d.key) + '</em></th>').join('') +
      '<th style="text-align:right">综合</th><th>推荐</th></tr></thead><tbody>' +
      rows.map((s, i) =>
        '<tr class="decision-row' + (i === 0 ? ' top' : '') + '" data-scheme="' + s.id + '" style="animation-delay:' + (i * 45) + 'ms">' +
        '<td><span class="decision-rank">' + String(i + 1).padStart(2, '0') + '</span></td>' +
        '<td><span class="decision-scheme">' + s.id + '<small>' + esc(nameOf(s.id)) + '</small></span></td>' +
        cfg.dims.map(d =>
          '<td><div class="decision-score"><b>' + s.scores[d.key] + '</b><div class="score-bar"><i style="width:' + s.scores[d.key] + '%"></i></div></div></td>'
        ).join('') +
        '<td style="text-align:right"><span class="decision-total">' + s.score.toFixed(1) + '</span></td>' +
        '<td class="rec-cell">' + (i === 0 ? '<span class="tag tag-amber">推荐</span>' : '<span class="tag tag-neutral">候选</span>') + '</td>' +
        '</tr>'
      ).join('') + '</tbody>';
  }

  /* ---------------------------------------------------------
     schedule
     --------------------------------------------------------- */
  function slotDetail(i) {
    const time = D.meta.rangeOf(i);
    const price = D.price[i], load = D.load[i], net = D.netLoad[i], soc = D.soc[i], b = D.bessPower[i];
    const margin = D.gridLimit - net;
    $('#slot-time').textContent = time;
    $('#slot-metrics').innerHTML =
      '<div><span>日前价格</span><strong>' + Math.round(price) + '<small>元/MWh</small></strong></div>' +
      '<div><span>预测负荷</span><strong>' + load.toFixed(1) + '<small>MW</small></strong></div>' +
      '<div><span>并网余量</span><strong style="color:' + (margin < 4 ? 'var(--amber)' : 'var(--text)') + '">' + margin.toFixed(1) + '<small>MW</small></strong></div>' +
      '<div><span>储能 SOC</span><strong>' + soc.toFixed(1) + '<small>%</small></strong></div>';
    const acts = [];
    if (b > 0) acts.push('储能充电 ' + b.toFixed(1) + ' MW');
    if (b < 0) acts.push('储能放电 ' + Math.abs(b).toFixed(1) + ' MW');
    if (i >= 50 && i < 66) acts.push('2# 轧机 3.2 MW 移峰运行');
    if (!acts.length) acts.push('维持基础负荷 · 无储能动作');
    let html = '<strong>' + acts.join(' · ') + '</strong>';
    if (margin < 4) html += '<br>并网余量仅 ' + margin.toFixed(1) + ' MW，接近上限；压力情景下会触发阻断级预警。';
    else if (b > 0) html += '<br>处于低价窗口，充电成本约 ¥' + Math.round(price) + '/MWh。';
    else if (b < 0) html += '<br>晚峰放电替代高价购电，价差收益已扣除效率损耗。';
    else html += '<br>该时段仅执行基础负荷，不进行充放电。';
    const el = $('#slot-action');
    el.className = 'slot-action' + (margin < 4 ? ' warn' : '');
    el.innerHTML = html;
  }

  function renderSchedule() {
    C.schedule($('#schedule-chart'), D, slotDetail);
    C.gantt($('#gantt-chart'), D, state.ghost);
  }

  function renderTiers() {
    const defs = [
      { key: 'valley', label: '谷时', range: '≤ ¥300', color: '#bcd47c', max: 300, opacity: .78 },
      { key: 'flat', label: '平时', range: '¥300–500', color: '#86b6c0', max: 500, opacity: .5 },
      { key: 'peak', label: '峰时', range: '¥500–700', color: '#f2b04a', max: 700, opacity: .74 },
      { key: 'sharp', label: '尖峰', range: '> ¥700', color: '#e2675b', max: Infinity, opacity: .88 }
    ];
    const tierOf = D.price.map(p => defs.findIndex(d => p <= d.max));
    const stats = defs.map((d, ti) => {
      let count = 0, sum = 0, loadE = 0, charge = 0, discharge = 0, ranges = [], start = null;
      for (let i = 0; i < D.N; i++) {
        if (tierOf[i] !== ti) {
          if (start !== null) { ranges.push([start, i - 1]); start = null; }
          continue;
        }
        if (start === null) start = i;
        count++;
        sum += D.price[i];
        loadE += D.load[i] * 0.25;
        if (D.bessPower[i] > 0) charge += D.bessPower[i] * 0.25;
        if (D.bessPower[i] < 0) discharge += -D.bessPower[i] * 0.25;
      }
      if (start !== null) ranges.push([start, D.N - 1]);
      const windows = ranges.map(r => D.meta.rangeOf(r[0], r[1] - r[0] + 1));
      return {
        count,
        avg: count ? sum / count : 0,
        loadE,
        charge,
        discharge,
        share: count / D.N * 100,
        windows
      };
    });

    $('#tier-band').innerHTML = D.price.map((p, i) => {
      const d = defs[tierOf[i]];
      return '<span style="background:' + d.color + ';opacity:' + d.opacity + '" title="' +
        D.meta.rangeOf(i, 1) + ' · ¥' + p.toFixed(1) + ' · ' + d.label + '"></span>';
    }).join('');

    $('#tier-grid').innerHTML = defs.map((d, ti) => {
      const st = stats[ti];
      const hours = Number((st.count * 0.25).toFixed(2));
      const win = st.windows.join(' / ');
      return '<div class="tier-card" style="--tier-color:' + d.color + '">' +
        '<div class="tc-head"><span class="tc-label"><i></i>' + d.label + '</span><span class="tc-range">' + d.range + '</span></div>' +
        '<div class="tc-price">' + (st.count ? Math.round(st.avg) : '—') + '<small>元/MWh 均价</small></div>' +
        '<div class="tc-meta">' +
        '<span>时段 <b>' + st.count + ' 段 · ' + hours + ' h · ' + st.share.toFixed(1) + '%</b></span>' +
        '<span>负荷 <b>' + Math.round(st.loadE) + ' MWh</b></span>' +
        '<span>储能 <b>充 ' + Math.round(st.charge) + ' / 放 ' + Math.round(st.discharge) + ' MWh</b></span>' +
        '</div>' +
        '<div class="tc-windows" title="' + esc(win) + '">' + esc(win) + '</div>' +
        '<div class="tc-share"><i style="width:' + st.share + '%"></i></div>' +
        '</div>';
    }).join('');
  }

  /* ---------------------------------------------------------
     long-term
     --------------------------------------------------------- */
  function renderLongTerm() {
    const LT = D.longTerm;
    if ($('#lt-chart')) C.longTerm($('#lt-chart'), D);
    const q = $('#quarter-table');
    if (q) q.innerHTML =
      '<thead><tr><th>季度</th><th style="text-align:right">合同覆盖</th><th style="text-align:right">现货敞口</th><th style="text-align:right">预算 / 万元</th><th style="text-align:right">峰值需量</th><th>状态</th></tr></thead><tbody>' +
      LT.quarters.map(x =>
        '<tr><td><span class="qtr">' + x.name + '</span></td>' +
        '<td class="num">' + x.coverage + '%</td>' +
        '<td class="num">' + x.spot + '%</td>' +
        '<td class="num">' + fmtInt(x.budget) + '</td>' +
        '<td class="num">' + x.peak + ' MW</td>' +
        '<td><span class="tag ' + (x.status === '达标' ? 'tag-lime' : 'tag-warn') + '">' + x.status + '</span></td></tr>'
      ).join('') + '</tbody>';
    const inv = $('#invest-list');
    if (inv) inv.innerHTML = LT.investments.map(x =>
      '<article class="invest-card">' +
      '<div class="ic-top"><span class="micro">' + esc(x.kind) + '</span><span class="tag tag-' + x.tagKey + '">' + esc(x.tag) + '</span></div>' +
      '<h3>' + esc(x.title) + '</h3>' +
      '<div class="ic-value">' + esc(x.value) + '<small>' + esc(x.unit) + '</small><span>' + esc(x.metric) + '</span></div>' +
      '<div class="ic-rows"><div><span>成本 / 投资</span><b>' + esc(x.cost) + '</b></div><div><span>收益 / 影响</span><b>' + esc(x.benefit) + '</b></div></div>' +
      '<p class="ic-risk">风险：' + esc(x.risk) + '</p>' +
      '</article>'
    ).join('');
  }

  /* ---------------------------------------------------------
     alerts
     --------------------------------------------------------- */
  function filteredAlerts() {
    return D.alerts.filter(a => {
      if (state.alertLevel !== 'all' && a.levelKey !== state.alertLevel) return false;
      if (state.alertType !== 'all' && a.type !== state.alertType) return false;
      if (state.alertStatus !== 'all' && a.status !== state.alertStatus) return false;
      if (state.alertQuery) {
        const q = state.alertQuery.toLowerCase();
        const hay = [a.id, a.title, a.desc, a.type, fieldOf(a, '来源批次'), fieldOf(a, '关联方案')].join(' ').toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
  }

  function renderAlertList() {
    const list = filteredAlerts();
    if (!list.length) {
      $('#alert-list').innerHTML = '<div class="alert-empty">没有符合条件的预警 · 调整筛选或搜索词</div>';
      return;
    }
    $('#alert-list').innerHTML = list.map(a => {
      const owner = fieldOf(a, '责任角色');
      const deadline = fieldOf(a, '处理期限');
      return '<article class="alert-card lv-' + a.levelKey + '" data-alert="' + a.id + '" role="button" tabindex="0">' +
        '<div class="alert-top"><span class="alert-level">' + a.level + '</span><span class="alert-id">' + a.id + '</span>' +
        '<span class="tag ' + statusTagClass(a.status) + '">' + a.status + '</span></div>' +
        '<h3>' + esc(a.title) + '</h3>' +
        '<p>' + esc(a.desc) + '</p>' +
        '<div class="alert-meta"><span>' + esc(a.type) + '</span><span>' + esc(owner) + '</span><span>截止 ' + esc(deadline) + '</span><span class="alert-link">' + esc(a.link) + ' →</span></div>' +
        '</article>';
    }).join('');
  }

  function renderAlertStats() {
    const levels = [['block', '阻断'], ['important', '重要'], ['general', '一般'], ['hint', '提示']];
    const max = Math.max.apply(null, levels.map(l => D.alerts.filter(a => a.levelKey === l[0]).length));
    const closed = D.alerts.filter(a => a.status === '已解决').length;
    const ignored = D.alerts.filter(a => a.status === '已忽略').length;
    $('#alert-stats').innerHTML =
      levels.map(l => {
        const n = D.alerts.filter(a => a.levelKey === l[0]).length;
        return '<div class="stat-row ' + l[0] + '"><span class="lbl">' + l[1] + '</span><div class="bar"><i style="width:' + (n / max * 100) + '%"></i></div><strong>' + n + '</strong></div>';
      }).join('') +
      '<div class="stat-totals"><div><strong>' + openAlertsCount() + '</strong><span>未关闭</span></div><div><strong>' + closed + '</strong><span>已解决</span></div><div><strong>' + ignored + '</strong><span>忽略 / 误报</span></div></div>';
  }

  function updateAlertViews() {
    renderAlertList();
    renderAlertStats();
    renderAlertMini();
    updateAlertBadges();
    renderOverviewBatches();
  }

  function openAlert(id) {
    const a = D.alerts.find(x => x.id === id);
    if (!a) return;
    const owner = fieldOf(a, '责任角色');
    const deadline = fieldOf(a, '处理期限');
    const rows = (a.fields || []).map(f => '<div><span>' + esc(f[0]) + '</span><strong>' + esc(f[1]) + '</strong></div>').join('');
    const timeline = (a.events || []).map(e => '<li><time>' + esc(e[0]) + '</time><div><strong>' + esc(e[1]) + '</strong><br>' + esc(e[2]) + '</div></li>').join('');
    let actions = '';
    if (OPEN_STATES.indexOf(a.status) !== -1) {
      if (a.status === '处理中') {
        actions += '<button class="btn btn-primary btn-sm" data-alert-action="close" data-id="' + a.id + '"' + (a.levelKey === 'block' ? ' disabled title="阻断预警需条件解除后关闭"' : '') + '>关闭预警</button>';
      } else {
        actions += '<button class="btn btn-primary btn-sm" data-alert-action="ack" data-id="' + a.id + '">确认接单</button>';
      }
      actions += '<button class="btn btn-ghost btn-sm" data-alert-action="dispatch" data-id="' + a.id + '">分派处理</button>';
      actions += '<button class="btn btn-quiet btn-sm" data-alert-action="ignore" data-id="' + a.id + '">忽略 / 误报</button>';
    }
    const body =
      '<div class="detail-grid">' +
      '<div><span>级别</span><strong style="color:' + (a.levelKey === 'block' ? 'var(--red)' : a.levelKey === 'important' ? 'var(--amber)' : 'var(--text-2)') + '">' + a.level + '</strong></div>' +
      '<div><span>状态</span><strong>' + a.status + '</strong></div>' +
      '<div><span>责任角色</span><strong>' + esc(owner) + '</strong></div>' +
      '<div><span>处理期限</span><strong>' + esc(deadline) + '</strong></div>' +
      '</div>' +
      '<div class="drawer-section"><h4>说明</h4><p>' + esc(a.desc) + '</p></div>' +
      '<div class="drawer-section"><h4>触发字段与来源</h4><div class="evidence-fields">' + rows + '</div></div>' +
      '<div class="drawer-section"><h4>处理记录</h4><ul class="timeline">' + timeline + '</ul></div>' +
      '<div class="drawer-actions">' + actions + '</div>' +
      '<p class="drawer-note">预警关联 ' + esc(a.link) + '。关闭前系统再次校验触发条件；忽略或误报必须填写原因；外部通知失败不影响内部审计记录。</p>';
    openDrawer('ALERT · ' + a.id + ' · ' + a.type, a.title, body);
  }

  /* ---------------------------------------------------------
     data & billing
     --------------------------------------------------------- */
  function renderBatches() {
    $('#batch-table').innerHTML =
      '<thead><tr><th>批次编号</th><th>内容 / 来源</th><th>粒度</th><th>完整率</th><th>采集</th><th>状态</th><th>指纹</th></tr></thead><tbody>' +
      D.batches.map(b => {
        const meterCls = b.completeness === null ? 'low' : b.completeness < 95 ? 'low' : b.completeness < 99 ? 'mid' : '';
        const complete = b.completeness === null
          ? '<span class="fp">—</span>'
          : '<div class="completeness"><div class="meter"><i class="' + meterCls + '" style="transform:scaleX(' + (b.completeness / 100) + ')"></i></div><span>' + b.completeness + '%</span></div>';
        return '<tr data-batch="' + b.id + '" style="cursor:pointer">' +
          '<td><span class="batch-id">' + b.id + '</span></td>' +
          '<td><span class="batch-id" style="font-family:var(--sans);font-size:10px;color:var(--text-2)">' + esc(b.name) + '</span><span class="batch-sub">' + esc(b.sub) + '</span></td>' +
          '<td>' + esc(b.gran) + '</td>' +
          '<td>' + complete + '</td>' +
          '<td class="num dim" style="font-size:8.5px">' + esc(b.fresh) + '</td>' +
          '<td><span class="tag tag-' + (b.statusKey === 'ok' ? 'ok' : b.statusKey === 'warn' ? 'warn' : b.statusKey === 'danger' ? 'danger' : 'neutral') + '">' + esc(b.status) + '</span></td>' +
          '<td><span class="fp">' + esc(b.fp) + '</span></td></tr>';
      }).join('') + '</tbody>';
  }

  function renderQuality() {
    $('#quality-summary').innerHTML =
      '<div class="q-card ok"><span>关键字段完整率</span><strong>99.2%</strong><small>目标 ≥ 95%</small></div>' +
      '<div class="q-card"><span>异常与冲突</span><strong>5</strong><small>重复 / 缺测 / 单位 / 来源</small></div>' +
      '<div class="q-card ok"><span>已关闭问题</span><strong>3</strong><small>原始值与规则留档</small></div>' +
      '<div class="q-card danger"><span>未关闭阻断</span><strong>1</strong><small>另有 1 项来源冲突已记录</small></div>';
    $('#issue-list').innerHTML = D.issues.map(i =>
      '<li class="issue ' + (i.level || '') + '"><span class="issue-mark">' + i.mark + '</span>' +
      '<div><strong>' + esc(i.title) + '</strong><p>' + esc(i.meta) + '</p></div>' +
      '<span class="tag ' + (i.status === '未关闭' ? 'tag-danger' : i.status === '已记录' ? 'tag-warn' : 'tag-ok') + '">' + i.status + '</span></li>'
    ).join('');
  }

  function renderBilling() {
    const confirmed = D.billing.status === 'CONFIRMED';
    const totalDiff = validNumber(D.billing.recalcTotal) && validNumber(D.billing.billTotal) ? D.billing.recalcTotal - D.billing.billTotal : null;
    const rows = D.billing.rows.map(r => {
      const recalc = r.recalc === null ? '<span class="num dim">—</span>' : '<span class="num">' + fmtInt(r.recalc) + '</span>';
      const bill = r.bill === null ? '<span class="num dim">' + (r.status === '数据不足' ? '数据不足' : '待录入') + '</span>' : '<span class="num">' + fmtInt(r.bill) + '</span>';
      const diff = r.diff === null ? '<span class="num dim">—</span>' : '<span class="num ' + (r.diff < 0 ? 'neg' : r.diff > 0 ? 'pos' : '') + '">' + (r.diff > 0 ? '+' : '') + fmtInt(r.diff) + '</span>';
      const tag = r.status === '通过' ? 'tag-ok' : r.status === '数据不足' ? 'tag-danger' : 'tag-warn';
      return '<tr><td>' + esc(r.item) + '</td><td style="text-align:right">' + recalc + '</td><td style="text-align:right">' + bill + '</td><td style="text-align:right">' + diff + '</td><td class="num dim" style="text-align:right">' + esc(r.tol) + '</td><td><span class="tag ' + tag + '">' + esc(r.status) + '</span></td></tr>';
    }).join('');
    $('#billing-table').innerHTML =
      '<thead><tr><th>费用项目</th><th style="text-align:right">系统复算</th><th style="text-align:right">正式账单</th><th style="text-align:right">差异</th><th style="text-align:right">容差</th><th>状态</th></tr></thead><tbody>' +
      rows +
      '<tr class="total-row"><td>账单合计</td><td style="text-align:right"><span class="num">' + fmtInt(D.billing.recalcTotal) + '</span></td><td style="text-align:right"><span class="num">' + fmtInt(D.billing.billTotal) + '</span></td><td style="text-align:right"><span class="num ' + (totalDiff === null ? '' : totalDiff < 0 ? 'neg' : totalDiff > 0 ? 'pos' : '') + '">' + (totalDiff === null ? '—' : (totalDiff > 0 ? '+' : '') + fmtInt(totalDiff)) + '</span></td><td class="num dim" style="text-align:right">—</td><td><span class="tag ' + (confirmed ? 'tag-ok' : 'tag-warn') + '">' + (confirmed ? '已确认' : '核验中') + '</span></td></tr>' +
      '</tbody>';
  }

  function openBatch(id) {
    const b = D.batches.find(x => x.id === id);
    if (!b) return;
    const fields = [
      ['批次编号', b.id], ['内容', b.name], ['来源', b.sub], ['粒度', b.gran],
      ['完整率', b.completeness === null ? '—' : b.completeness + '%'], ['采集 / 发布', b.fresh],
      ['状态', b.status], ['指纹', b.fp]
    ].map(f => '<div><span>' + esc(f[0]) + '</span><strong>' + esc(f[1]) + '</strong></div>').join('');
    openDrawer('BATCH · ' + b.id, b.name,
      '<div class="drawer-section"><h4>批次字段</h4><div class="evidence-fields">' + fields + '</div></div>' +
      '<div class="drawer-section"><h4>质量备注</h4><p>' + esc(b.note) + '</p></div>' +
      '<div class="drawer-section"><h4>处理规则</h4><p>原始文件、字段映射、单位、时区与摘要指纹一并归档。错误批次整体隔离，不部分写入；缺失字段显示补录入口，不进入优化计算。</p></div>' +
      '<p class="drawer-note">该批次为只读快照，时间范围与授权范围已锁定。</p>');
  }

  /* ---------------------------------------------------------
     AI explain
     --------------------------------------------------------- */
  const EV_ORDER = ['E-0231', 'E-0188', 'E-0207', 'E-0244', 'E-0249', 'E-0261'];

  function evChips(ids) {
    return '<div class="evidence-chips"><span class="ec-label">证据</span>' +
      ids.map(id => '<button class="ev-chip" data-evidence="' + id + '">' + id + ' · ' + D.evidence[id].short + '</button>').join('') + '</div>';
  }

  function answerHtml(kind, q) {
    if (kind === 'mill') {
      return '<h3>因为原窗口的预测价格均值是 834 元/MWh，新窗口是 230 元/MWh。</h3>' +
        '<p>在满足<strong>连续 4 小时、交付窗口 23:00、班次与安全联锁</strong>的前提下，系统把 2# 轧机的 3.2 MW 负荷从 18:30–22:30 移至 12:30–16:30。移峰电量 12.8 MWh，该工序对方案差额的贡献为 <span class="hl">¥6,180</span>（已扣除可调成本）。</p>' +
        '<div class="answer-metrics"><div><span>原窗口均价</span><strong>834<em>元/MWh</em></strong></div><div><span>新窗口均价</span><strong>230<em>元/MWh</em></strong></div><div><span>该工序贡献</span><strong>+6,180<em>元</em></strong></div></div>' +
        '<p>没有继续前移到 12:00，是因为 12:00–12:30 处于班次交接与加热炉升温窗口，会与 C-07 班次约束冲突；16:30 结束则给交付保留 6.5 小时缓冲。</p>' +
        '<p class="answer-note">金额由计算服务 CALC-0304-0921 返回，非语言模型生成。该工序贡献不等于 S4 的全部差额。</p>' +
        evChips(['E-0188', 'E-0231', 'E-0207', 'E-0249']);
    }
    if (kind === 'price') {
      return '<h3>用的是日前预测值，不是企业结算价，也不是公开日均价。</h3>' +
        '<p>价格字段为 <strong>market.day_ahead_price[0..95]</strong>，单位元/MWh，来自批次 B-20260303-MKT-02，模型 PRICE-GBT v2.4.0，03-03 22:10 发布。晚峰 18:00–21:00 的误差带扩大至 ±38%，所以系统同时展示基准与压力情景，不把预测准确等同于节省。</p>' +
        '<div class="answer-metrics"><div><span>预测均价</span><strong>' + D.avgPrice.toFixed(1) + '<em>元/MWh</em></strong></div><div><span>晚峰峰值</span><strong>' + Math.round(D.maxPrice) + '<em>元/MWh</em></strong></div><div><span>晚峰误差带</span><strong>±38<em>%</em></strong></div></div>' +
        '<p>公开日级 CSV（B-20260303-DAY-CSV）只作日级参考，不能复制为小时价格，也不能替代企业最终结算电价。合同中固定电量的价格与交割时段来自合同批次 B-20260228-CTR-04 v4。</p>' +
        '<p class="answer-note">数据性质为预测值。若需要结算口径，请查看“数据与账单 → 账单核对”。</p>' +
        evChips(['E-0231', 'E-0207', 'E-0249']);
    }
    if (kind === 'load') {
      return '<h3>固定当前动作时，S4 在 13:45 并网越限，该情景不可执行。</h3>' +
        '<p>解析出的假设是：<strong>基础负荷 +10%，工序任务不变，固定当前动作</strong>。在不重新求解的情况下，13:45 并网功率 <span class="hl">' + D.stressNet.toFixed(1) + ' MW</span>，超过上限 ' + D.gridLimit + ' MW。系统把 S4 标记为不可执行，并生成重要预警 A-0304-02。</p>' +
        '<p>由于尚未重新计算，这里只说明影响方向，不生成新的精确节省金额。</p>' +
        '<div class="answer-action"><button class="btn btn-ghost btn-sm" data-chat-action="recalc">发起重新优化</button></div>' +
        '<p class="answer-note">固定动作评估与重新优化结果必须分别标记；重新优化会生成独立草案。</p>' +
        evChips(['E-0261', 'E-0207']);
    }
    return '<h3>这个问题需要先绑定到具体方案版本与数据证据。</h3>' +
      '<p>当前会话绑定 V-S4-003 / 批次 B-20260303-MKT-02 / 计算编号 CALC-0304-0921。我可以用结构化证据解释时段安排、价格来源与负荷变化，但不会在未调用计算服务时生成新的金额。</p>' +
      '<p>你可以尝试询问：为什么把 2# 轧机移到 12:30–16:30？价格依据是什么？若基础负荷增加 10% 会怎样？</p>' +
      evChips(['E-0249']);
  }

  function classify(q) {
    if (/2#|轧机|移峰|12:30|窗口/.test(q)) return 'mill';
    if (/负荷|10%|增加/.test(q)) return 'load';
    if (/价格|依据|结算|误差/.test(q)) return 'price';
    return 'fallback';
  }

  function msgUser(text) {
    return '<div class="msg msg-user"><div class="msg-meta"><strong>你</strong> · 10:36</div><div class="bubble">' + esc(text) + '</div></div>';
  }

  function msgAI(inner, time) {
    return '<div class="msg msg-ai"><div class="msg-meta"><strong>源能</strong> · V-S4-003 · ' + (time || '10:37') + '</div><div class="answer">' + inner + '</div></div>';
  }

  function seedChat() {
    const stream = $('#chat-stream');
    stream.innerHTML = msgUser('为什么把 2# 轧机移到 12:30–16:30？') + msgAI(answerHtml('mill'), '10:37');
    $('#chat-suggest').innerHTML = D.suggestions.map(s => '<button class="suggest" type="button">' + esc(s) + '</button>').join('');
    stream.scrollTop = stream.scrollHeight;
  }

  function ask(q) {
    if (!q) return;
    const stream = $('#chat-stream');
    stream.insertAdjacentHTML('beforeend', msgUser(q));
    const id = 'typing-' + Date.now();
    stream.insertAdjacentHTML('beforeend', '<div class="msg msg-ai" id="' + id + '"><div class="msg-meta"><strong>源能</strong> · 检索证据中</div><div class="typing"><i></i><i></i><i></i></div></div>');
    stream.scrollTop = stream.scrollHeight;
    window.setTimeout(function () {
      const box = document.getElementById(id);
      if (!box) return;
      box.outerHTML = msgAI(answerHtml(classify(q)), '10:4' + (Math.floor(Math.random() * 9)));
      stream.scrollTop = stream.scrollHeight;
    }, 850);
  }

  function recalc() {
    const stream = $('#chat-stream');
    const id = 'calc-' + Date.now();
    stream.insertAdjacentHTML('beforeend', '<div class="msg msg-ai" id="' + id + '"><div class="msg-meta"><strong>计算服务</strong> · JOB-2210</div><div class="typing"><i></i><i></i><i></i></div><div class="answer-note" style="border:0;padding:0;margin-top:4px">重新优化运行中，预计 1.5 秒…</div></div>');
    stream.scrollTop = stream.scrollHeight;
    window.setTimeout(function () {
      const box = document.getElementById(id);
      if (!box) return;
      const inner = '<h3>已重新求解：S4′ 可行，模拟差额 +¥14,220。</h3>' +
        '<p>在相同扰动下重新求解，系统把 13:45–14:30 的充电功率由 7.0 MW 降至 4.6 MW，并网峰值 72.9 / ' + D.gridLimit + ' MW。新结果保存为<strong>草案 V-S4-004</strong>，不覆盖审核中的 V-S4-003；提交审核前保持草稿。</p>' +
        '<div class="answer-metrics"><div><span>新草案差额</span><strong>+14,220<em>元</em></strong></div><div><span>并网峰值</span><strong>72.9<em>MW</em></strong></div><div><span>状态</span><strong style="font-size:11px">草稿</strong></div></div>' +
        '<p class="answer-note">固定动作评估与重新优化结果分别标记。金额来自 JOB-2210 / CALC-0304-1012。</p>' +
        evChips(['E-0272', 'E-0261']);
      box.outerHTML = msgAI(inner, '10:45');
      stream.scrollTop = stream.scrollHeight;
      state.recalcDone = true;
      addEvidenceToIndex('E-0272');
      toast('重新优化完成', 'V-S4-004 草稿已生成，未覆盖 V-S4-003', 'ok');
    }, 1550);
  }

  function renderEvidenceIndex() {
    $('#evidence-index').innerHTML = EV_ORDER.map(id => {
      const e = D.evidence[id];
      return '<button type="button" data-evidence="' + id + '"><span class="ei-id">' + id + '</span><span class="ei-name">' + esc(e.name) + '</span><span class="ei-go">→</span></button>';
    }).join('');
  }

  function addEvidenceToIndex(id) {
    if (EV_ORDER.indexOf(id) !== -1) return;
    EV_ORDER.push(id);
    const e = D.evidence[id];
    $('#evidence-index').insertAdjacentHTML('beforeend',
      '<button type="button" data-evidence="' + id + '"><span class="ei-id">' + id + '</span><span class="ei-name">' + esc(e.name) + '</span><span class="ei-go">→</span></button>');
  }

  function openEvidence(id) {
    const e = D.evidence[id];
    if (!e) return;
    const fields = e.fields.map(f => '<div><span>' + esc(f[0]) + '</span><strong>' + esc(f[1]) + '</strong></div>').join('');
    openDrawer('EVIDENCE · ' + e.id, e.name,
      '<div class="drawer-section"><h4>结构化字段</h4><div class="evidence-fields">' + fields + '</div></div>' +
      '<div class="drawer-section"><h4>访问与追溯</h4><p>证据已绑定方案版本 V-S4-003、批次 B-20260303-MKT-02 与计算编号 CALC-0304-0921。点击回答中的证据编号可回到相应字段与原始导入批次。</p></div>' +
      '<p class="drawer-note">问答内容、引用证据与访问日志已保存。敏感字段按企业 / 角色过滤，不跨企业可见。</p>');
  }

  /* ---------------------------------------------------------
     review
     --------------------------------------------------------- */
  function renderVersions() {
    $('#version-tree').innerHTML = D.reviews.versions.map(v => {
      const cur = state.reviewStatus === '审核中' && v.id === 'V-S4-003';
      const invalid = v.status === '已失效';
      return '<div class="version-item' + (cur ? ' current' : '') + (invalid ? ' invalid' : '') + '">' +
        '<div class="ver-card" data-version="' + v.id + '">' +
        '<div class="ver-top"><span class="ver-id">' + v.id + '</span><span class="tag tag-' + (v.statusKey === 'ok' ? 'ok' : v.statusKey === 'warn' ? 'warn' : v.statusKey === 'danger' ? 'danger' : 'neutral') + '">' + v.status + '</span></div>' +
        '<div class="ver-name">' + esc(v.name) + '</div>' +
        '<div class="ver-meta">' + esc(v.who) + '<br>' + v.time + ' · <span class="ver-cost">' + fmtCost(v.cost) + '</span></div>' +
        (v.note ? '<div class="ver-meta" style="color:var(--red)">' + esc(v.note) + '</div>' : '') +
        '</div></div>';
    }).join('');
  }

  function renderDiff() {
    $('#diff-table').innerHTML =
      '<thead><tr><th>参数 / 结果</th><th>父版本 V-S4-002</th><th>当前 V-S4-003</th></tr></thead><tbody>' +
      D.reviews.diffs.map(d =>
        '<tr><td>' + esc(d.field) + '</td><td><span class="diff-old">' + esc(d.old) + '</span></td><td><span class="diff-new">' + esc(d.now) + '</span>' + (d.delta ? ' <span class="tag tag-lime">' + d.delta + '</span>' : '') + '</td></tr>'
      ).join('') + '</tbody>';
  }

  function renderFlow() {
    const s = state.reviewStatus;
    const steps = [
      ['草稿', '03-04 09:18'], ['提交审核', '陈宏 · 09:20'], ['审核中', '待 李杰男 决策'],
      ['批准', '需填写意见'], ['执行前复核', '批准后开启']
    ];
    let classNames = ['done', 'done', 'current', '', ''];
    if (s === '已批准') {
      classNames = ['done', 'done', 'done', 'done', 'current'];
      steps[2][1] = '通过 · 李杰男';
      steps[3][1] = '03-04 · 已批准';
      steps[4][1] = '执行前复核待处理';
    } else if (s === '已退回') {
      classNames = ['done', 'done', 'done', '', ''];
      steps[2][1] = '已退回修改';
      steps[3][1] = '退回后重新提交';
    } else if (s === '已驳回') {
      classNames = ['done', 'done', 'done', '', ''];
      steps[2][1] = '驳回 · 终止当前版本';
      steps[3][1] = '不生成批准版本';
    }
    $('#approval-flow').innerHTML = steps.map((st, i) =>
      '<li class="' + classNames[i] + '"><i></i><div><strong>' + st[0] + '</strong><small>' + st[1] + '</small></div></li>'
    ).join('');
  }

  function renderAudit() {
    $('#audit-list').innerHTML = D.reviews.audit.map(a =>
      '<li><time>' + esc(a.time) + '</time><div><strong>' + esc(a.text) + '</strong><em>' + esc(a.who) + '</em>' + (a.meta ? '<em>' + esc(a.meta) + '</em>' : '') + '</div></li>'
    ).join('');
  }

  function renderReviewActions() {
    const s = state.reviewStatus;
    if (s === '审核中') {
      $('#review-actions').innerHTML =
        '<button class="btn btn-primary" id="btn-approve">批准 V-S4-003</button>' +
        '<button class="btn btn-ghost" id="btn-return">退回修改</button>' +
        '<button class="btn btn-quiet" id="btn-reject">驳回</button>';
      bindReviewButtons();
    } else {
      const cls = s === '已批准' ? 'tag-ok' : 'tag-warn';
      $('#review-actions').innerHTML =
        '<div class="review-done"><span class="tag ' + cls + '">' + s + '</span><p>' +
        (s === '已批准' ? '已生成批准记录与审计条目。执行前复核已开启；修改任何参数将生成新版本并重新审核。' : '本次审核已结束，当前版本保持只读。如需继续，请由提交人创建子版本。') +
        '</p></div>';
    }
    const tag = $('#review-status-tag');
    tag.textContent = s;
    tag.className = 'tag ' + (s === '已批准' ? 'tag-ok' : s === '已驳回' ? 'tag-danger' : 'tag-warn');
  }

  function renderReview() {
    renderVersions();
    renderDiff();
    renderFlow();
    renderAudit();
    renderReviewActions();
  }

  function bindReviewButtons() {
    const approve = $('#btn-approve');
    const ret = $('#btn-return');
    const rej = $('#btn-reject');
    if (approve) approve.addEventListener('click', function () {
      openModal({
        kicker: 'APPROVE · V-S4-003',
        title: '批准 V-S4-003？',
        html: '<p>将批准的是 <strong>V-S4-003</strong> 这一明确版本，不构成对企业后续方案的通用授权。</p><p class="modal-hint">批准后旧版本保持只读；任何参数变化必须重新计算并重新审核。提交人陈宏不能审批本人方案，当前身份为审核负责人。</p>',
        textarea: true,
        placeholder: '填写审核意见（必填）',
        requireText: true,
        confirmText: '确认批准',
        onConfirm: function (comment) {
          state.reviewStatus = '已批准';
          const v = D.reviews.versions[2];
          v.status = '已批准';
          v.statusKey = 'ok';
          D.reviews.audit.unshift({ time: '刚刚', who: '李杰男 · 审核负责人', text: '批准 V-S4-003', meta: '意见：' + comment });
          renderReview();
          toast('V-S4-003 已批准', '审计记录已写入 · 执行前复核已开启', 'ok');
        }
      });
    });
    if (ret) ret.addEventListener('click', function () {
      openModal({
        kicker: 'RETURN · V-S4-003',
        title: '退回修改？',
        html: '<p>退回后当前版本保持只读，提交人可基于父版本创建子版本并重新提交。旧版本不会被覆盖。</p>',
        textarea: true,
        placeholder: '说明需要修改的内容（必填）',
        requireText: true,
        confirmText: '确认退回',
        onConfirm: function (comment) {
          state.reviewStatus = '已退回';
          const v = D.reviews.versions[2];
          v.status = '已退回';
          v.statusKey = 'warn';
          D.reviews.audit.unshift({ time: '刚刚', who: '李杰男 · 审核负责人', text: '退回 V-S4-003', meta: '意见：' + comment });
          renderReview();
          toast('已退回修改', '子版本由提交人创建，旧版本只读', '');
        }
      });
    });
    if (rej) rej.addEventListener('click', function () {
      openModal({
        kicker: 'REJECT · V-S4-003',
        title: '驳回当前版本？',
        html: '<p>驳回将终止当前版本的审核流程，不生成批准版本。该动作会写入不可覆盖的审计记录。</p>',
        textarea: true,
        placeholder: '填写驳回原因（必填）',
        requireText: true,
        confirmText: '确认驳回',
        onConfirm: function (comment) {
          state.reviewStatus = '已驳回';
          const v = D.reviews.versions[2];
          v.status = '已驳回';
          v.statusKey = 'danger';
          D.reviews.audit.unshift({ time: '刚刚', who: '李杰男 · 审核负责人', text: '驳回 V-S4-003', meta: '原因：' + comment });
          renderReview();
          toast('已驳回', '当前版本终止审核，未生成批准记录', 'err');
        }
      });
    });
  }

  function openVersion(id) {
    const v = D.reviews.versions.find(x => x.id === id);
    if (!v) return;
    const fields = [
      ['版本', v.id], ['状态', v.status], ['提交 / 审核人', v.who], ['时间', v.time],
      ['模拟成本', fmtCost(v.cost)], ['父版本', id === 'V-S4-001' ? '—' : id === 'V-S4-002' ? 'V-S4-001' : 'V-S4-002'],
      ['输入指纹', id === 'V-S4-003' ? 'b71c…9a04' : '8f3a…c21d'],
      ['计算编号', id === 'V-S4-003' ? 'CALC-0304-0921' : '历史快照（只读）']
    ].map(f => '<div><span>' + f[0] + '</span><strong>' + esc(f[1]) + '</strong></div>').join('');
    openDrawer('VERSION · ' + v.id, v.name,
      '<div class="drawer-section"><h4>版本快照</h4><div class="evidence-fields">' + fields + '</div></div>' +
      '<div class="drawer-section"><h4>状态说明</h4><p>' +
      (v.status === '已失效' ? '合同批次更新导致输入指纹不匹配，本版本已失效，不得进入执行前复核。' :
        v.status === '审核中' ? '当前版本等待审核负责人决策。提交人与批准人分离，审核意见必填。' :
          '历史版本只读，用于追溯与差异对比，不能被覆盖或复用。') +
      '</p></div>' +
      '<p class="drawer-note">版本树保留父版本、差异、输入指纹、审核意见与操作记录。</p>');
  }

  /* ---------------------------------------------------------
     report export
     --------------------------------------------------------- */
  function exportReport() {
    const s4 = D.schemes[4];
    const rows = D.schemes.map(s =>
      '<tr><td>' + s.id + '</td><td>' + s.name + '</td><td class="r">' + fmtInt(s.cost) + '</td><td class="r">' + (s.diff ? fmtDiff(s.diff) : '基准') + '</td><td>' + s.feasibleText + '</td><td>' + s.nature + '</td></tr>'
    ).join('');
    const alertRows = D.alerts.slice(0, 5).map(a =>
      '<tr><td>' + a.id + '</td><td>' + a.level + '</td><td>' + a.title + '</td><td>' + a.status + '</td></tr>'
    ).join('');
    const html = '<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>源能决策报告 · 2026-03-04</title><style>' +
      'body{margin:0;padding:48px;background:#f3eee1;color:#171812;font-family:"Noto Serif SC","Songti SC",SimSun,serif;line-height:1.7}' +
      '.wrap{max-width:960px;margin:0 auto}h1{font-size:31px;letter-spacing:.05em;margin:12px 0 6px}h2{font-size:17px;letter-spacing:.06em;margin:38px 0 12px;border-bottom:1px solid #c8c0aa;padding-bottom:7px}' +
      '.meta{font-family:Consolas,monospace;font-size:10px;letter-spacing:.1em;color:#6c6858;text-transform:uppercase}' +
      '.kpis{display:flex;gap:30px;margin:24px 0;flex-wrap:wrap}.kpi{border-left:2px solid #b57f1f;padding-left:14px}.kpi span{font-family:Consolas,monospace;font-size:9px;letter-spacing:.08em;color:#6c6858}.kpi strong{display:block;font-family:Consolas,monospace;font-size:24px;font-weight:400;margin-top:2px}' +
      'table{width:100%;border-collapse:collapse;font-size:11px;font-family:"Noto Sans SC","Microsoft YaHei",sans-serif}th{text-align:left;font-family:Consolas,monospace;font-size:8px;letter-spacing:.1em;color:#6c6858;border-bottom:1px solid #9e9682;padding:8px 6px}td{padding:8px 6px;border-bottom:1px solid #d6cfbc}.r{text-align:right;font-family:Consolas,monospace}' +
      '.note{background:#eae2cf;border-left:3px solid #b57f1f;padding:13px 16px;font-size:11px;margin:22px 0}.foot{margin-top:46px;border-top:1px solid #c8c0aa;padding-top:14px;font-family:Consolas,monospace;font-size:9px;color:#6c6858;letter-spacing:.06em}' +
      '.print{position:fixed;right:26px;top:26px;background:#b57f1f;color:#fff;border:0;padding:10px 16px;font-size:11px;cursor:pointer}' +
      '@media print{.print{display:none}body{padding:0;background:#fff}.wrap{max-width:none}}' +
      '</style></head><body><button class="print" onclick="window.print()">打印 / 保存 PDF</button><div class="wrap">' +
      '<div class="meta">YUANHENG · SHANXI SPOT OPS · PROTOTYPE</div>' +
      '<h1>企业用电成本优化 · 决策报告</h1>' +
      '<div class="meta">规划日 2026-03-04 / ' + D.meta.pilot + ' / 计量点 ' + D.meta.point + ' / 批次 ' + D.meta.batch + '</div>' +
      '<div class="kpis"><div class="kpi"><span>S4 模拟差额</span><strong>+¥' + fmtInt(s4.diff) + '</strong></div>' +
      '<div class="kpi"><span>S4 模拟成本</span><strong>' + fmtCost(s4.cost) + '</strong></div>' +
      '<div class="kpi"><span>日前预测均价</span><strong>' + D.avgPrice.toFixed(1) + ' 元/MWh</strong></div>' +
      '<div class="kpi"><span>预测负荷峰值</span><strong>' + D.peakLoad.toFixed(1) + ' MW</strong></div></div>' +
      '<div class="note">本报告中的金额均为同一规划日、同一数据批次、同一约束集下的<strong>模拟成本</strong>。actualSaving 为空：正式账单仍有 1 项费用未录入、反事实基准未确认。模拟差额不等于实际节省。</div>' +
      '<h2>一、五方案比较</h2><table><thead><tr><th>方案</th><th>名称</th><th>模拟成本 / 元</th><th>S0 差额 / 元</th><th>可行性</th><th>数据性质</th></tr></thead><tbody>' + rows + '</tbody></table>' +
      '<h2>二、明日动作窗口</h2><table><thead><tr><th>时段</th><th>动作</th><th>参数</th></tr></thead><tbody>' +
      D.actions.map(a => '<tr><td>' + a.time + '</td><td>' + a.title + '</td><td>' + a.meta + '</td></tr>').join('') + '</tbody></table>' +
      '<h2>三、关键约束</h2><table><thead><tr><th>硬约束</th><th>校验结果</th></tr></thead><tbody>' +
      D.constraints.map(c => '<tr><td>' + c.title + '</td><td>' + c.meta + '</td></tr>').join('') + '</tbody></table>' +
      '<h2>四、预警摘录</h2><table><thead><tr><th>编号</th><th>级别</th><th>内容</th><th>状态</th></tr></thead><tbody>' + alertRows + '</tbody></table>' +
      '<h2>五、数据与证据</h2><table><thead><tr><th>批次</th><th>内容</th><th>完整率</th><th>状态</th></tr></thead><tbody>' +
      D.batches.slice(0, 6).map(b => '<tr><td>' + b.id + '</td><td>' + b.name + '</td><td class="r">' + (b.completeness === null ? '—' : b.completeness + '%') + '</td><td>' + b.status + '</td></tr>').join('') + '</tbody></table>' +
      '<div class="note">解释证据：E-0231 价格窗口 / E-0188 工序窗口 / E-0207 负荷预测 / E-0244 储能 SOC / E-0249 成本明细 / E-0261 压力情景。金额来自计算服务 ' + D.meta.calc + '，方案版本 V-S4-003。</div>' +
      '<div class="foot">源能 · 企业用电成本优化与智能调度决策系统 · 所有正式购电、调度与结算动作由企业授权人员确认</div>' +
      '</div></body></html>';
    const blob = new Blob([html], { type: 'text/html;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = '源能_决策报告_2026-03-04.html';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { a.remove(); URL.revokeObjectURL(url); }, 30000);
    toast('决策报告已生成', 'HTML 报告已下载，可打印或另存为 PDF', 'ok');
  }

  /* ---------------------------------------------------------
     events
     --------------------------------------------------------- */
  function bindEvents() {
    $$('.nav a').forEach(a => a.addEventListener('click', function (e) {
      e.preventDefault();
      go(a.dataset.view);
    }));
    document.addEventListener('click', function (e) {
      const goto = e.target.closest('[data-goto]');
      if (goto) { e.preventDefault(); go(goto.dataset.goto); return; }

      const fMode = e.target.closest('[data-fmode]');
      if (fMode) {
        state.termMode = fMode.dataset.fmode;
        updateTermTabs();
        renderTermChart();
        return;
      }
      const ovBtn = e.target.closest('[data-overlay]');
      if (ovBtn) {
        state.termOverlay = ovBtn.dataset.overlay;
        updateTermTabs();
        renderTermChart();
        return;
      }
      const tapeRow = e.target.closest('#term-tape [data-term-slot]');
      if (tapeRow) {
        focusTermSlot(Number(tapeRow.dataset.termSlot));
        return;
      }

      const decisionBtn = e.target.closest('[data-decision]');
      if (decisionBtn) {
        state.decisionMode = decisionBtn.dataset.decision;
        renderDecision();
        return;
      }

      const schemeEl = e.target.closest('[data-scheme]');
      if (schemeEl) {
        state.selectedScheme = schemeEl.dataset.scheme;
        renderSchemeCards();
        renderComposition();
        renderSchemeDetail();
        if (!$('#view-compare').classList.contains('active')) go('compare');
        return;
      }

      const alertEl = e.target.closest('[data-alert]');
      if (alertEl) {
        const id = alertEl.dataset.alert;
        if (state.view !== 'alerts') go('alerts');
        setTimeout(() => openAlert(id), 120);
        return;
      }

      const evEl = e.target.closest('[data-evidence]');
      if (evEl) { openEvidence(evEl.dataset.evidence); return; }

      const versionEl = e.target.closest('[data-version]');
      if (versionEl) { openVersion(versionEl.dataset.version); return; }

      if (e.target.closest('#cmd-open')) { openPalette(); return; }
      if (e.target.closest('#bell')) { go('alerts'); return; }
      if (e.target.closest('#export-btn')) { exportReport(); return; }
      if (e.target.closest('#term-export')) { exportForecastCSV(); return; }
      if (e.target.closest('#drawer-close') || e.target === $('#scrim')) { closeDrawer(); return; }

      const modalBtn = e.target.closest('[data-modal]');
      if (modalBtn) {
        if (modalBtn.dataset.modal === 'cancel') { closeModal(); return; }
        if (modalBtn.dataset.modal === 'confirm') {
          const opts = modalConfirm;
          if (!opts) { closeModal(); return; }
          let val = '';
          if (opts.textarea) {
            const ta = $('#modal-text');
            val = ta ? ta.value.trim() : '';
            if (opts.requireText && !val) {
              const err = $('#modal-error');
              if (err) { err.textContent = '请填写意见后再提交。'; err.style.color = 'var(--red)'; err.style.fontSize = '9.5px'; err.style.marginTop = '6px'; }
              if (ta) ta.focus();
              return;
            }
          }
          closeModal();
          if (opts.onConfirm) opts.onConfirm(val);
          return;
        }
      }
      if (e.target.closest('#modal-close')) { closeModal(); return; }

      const alertAction = e.target.closest('[data-alert-action]');
      if (alertAction) { handleAlertAction(alertAction.dataset.alertAction, alertAction.dataset.id); return; }

      const tab = e.target.closest('.tab[data-tab]');
      if (tab) {
        state.dataTab = tab.dataset.tab;
        $$('.tab').forEach(t => { t.classList.toggle('active', t === tab); t.setAttribute('aria-selected', t === tab ? 'true' : 'false'); });
        $$('.tabpane').forEach(p => p.classList.toggle('active', p.dataset.pane === state.dataTab));
        return;
      }

      const batchRow = e.target.closest('[data-batch]');
      if (batchRow) { openBatch(batchRow.dataset.batch); return; }

      const chatAction = e.target.closest('[data-chat-action]');
      if (chatAction && chatAction.dataset.chatAction === 'recalc') {
        chatAction.closest('.answer-action').innerHTML = '<span class="typing"><i></i><i></i><i></i></span> <span style="font-family:var(--mono);font-size:8px;color:var(--dim)">计算服务运行中…</span>';
        recalc();
        return;
      }
    });

    document.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        if ($('#palette').hidden) openPalette();
        else closePalette();
        return;
      }
      if (!$('#palette').hidden) {
        if (e.key === 'Escape') { e.preventDefault(); closePalette(); return; }
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          if (palItems.length) { palIndex = (palIndex + 1) % palItems.length; updatePaletteActive(); }
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          if (palItems.length) { palIndex = (palIndex - 1 + palItems.length) % palItems.length; updatePaletteActive(); }
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          executePalette(palIndex);
          return;
        }
      }
      if (e.key === 'Escape') {
        if (!$('#modal').hidden) closeModal();
        else if ($('#drawer').classList.contains('open')) closeDrawer();
      }
      if ((e.key === 'Enter' || e.key === ' ') && document.activeElement) {
        const el = document.activeElement;
        if (el.dataset && (el.dataset.alert || el.dataset.scheme) && el.getAttribute('role') === 'button') {
          e.preventDefault();
          el.click();
        }
      }
    });

    /* price layers */
    $$('#price-layers .chip').forEach(btn => btn.addEventListener('click', function () {
      const key = btn.dataset.layer;
      state.layers[key] = !state.layers[key];
      btn.classList.toggle('active', state.layers[key]);
      btn.setAttribute('aria-pressed', state.layers[key] ? 'true' : 'false');
      renderPrice();
    }));

    /* sensitivity */
    $$('#sens-mode .seg-btn').forEach(btn => btn.addEventListener('click', function () {
      state.sensMode = btn.dataset.mode;
      renderSensitivity();
    }));

    /* ghost toggle */
    const ghost = $('#ghost-toggle');
    if (ghost) ghost.addEventListener('click', function () {
      state.ghost = !state.ghost;
      ghost.classList.toggle('active', state.ghost);
      ghost.setAttribute('aria-pressed', state.ghost ? 'true' : 'false');
      C.gantt($('#gantt-chart'), D, state.ghost);
    });

    /* alert filters */
    $$('#alert-level-filter .seg-btn').forEach(btn => btn.addEventListener('click', function () {
      state.alertLevel = btn.dataset.level;
      $$('#alert-level-filter .seg-btn').forEach(b => b.classList.toggle('active', b === btn));
      renderAlertList();
    }));
    const typeSel = $('#alert-type');
    if (typeSel) typeSel.addEventListener('change', function () { state.alertType = typeSel.value; renderAlertList(); });
    const statSel = $('#alert-status');
    if (statSel) statSel.addEventListener('change', function () { state.alertStatus = statSel.value; renderAlertList(); });
    const search = $('#alert-search');
    if (search) search.addEventListener('input', function () { state.alertQuery = search.value.trim(); renderAlertList(); });

    /* chat */
    const form = $('#chat-form');
    if (form) form.addEventListener('submit', function (e) {
      e.preventDefault();
      const input = $('#chat-input');
      const v = input.value.trim();
      if (!v) return;
      input.value = '';
      ask(v);
    });
    $('#chat-suggest').addEventListener('click', function (e) {
      const b = e.target.closest('.suggest');
      if (b) ask(b.textContent.trim());
    });

    const termTape = $('#term-tape');
    if (termTape) termTape.addEventListener('mouseover', function (e) {
      const row = e.target.closest('[data-term-slot]');
      if (row) focusTermSlot(Number(row.dataset.termSlot));
    });
    const termOverlayMain = $('#term-overlay-main');
    if (termOverlayMain) termOverlayMain.addEventListener('change', function () {
      state.termOverlayMain = termOverlayMain.checked;
      renderTermChart();
    });

    /* scrim / modal clicks */
    $('#scrim').addEventListener('click', closeDrawer);
    $('#modal').addEventListener('click', function (e) {
      if (e.target === $('#modal')) closeModal();
    });

    const palInput = $('#palette-input');
    if (palInput) palInput.addEventListener('input', function () {
      palIndex = 0;
      renderPalette(palInput.value);
    });
    const palResults = $('#palette-results');
    if (palResults) {
      palResults.addEventListener('click', function (e) {
        const item = e.target.closest('[data-pal-index]');
        if (item) executePalette(Number(item.dataset.palIndex));
      });
      palResults.addEventListener('mouseover', function (e) {
        const item = e.target.closest('[data-pal-index]');
        if (item) { palIndex = Number(item.dataset.palIndex); updatePaletteActive(); }
      });
    }
    $('#palette').addEventListener('click', function (e) {
      if (e.target === $('#palette')) closePalette();
    });
    if ($('#modal-close')) $('#modal-close').addEventListener('click', closeModal);

    const importBtn = $('#import-btn');
    if (importBtn) importBtn.addEventListener('click', function () {
      openModal({
        kicker: 'DATA IMPORT',
        title: '导入数据批次',
        html: '<p>导入前检查必填字段、日期与时间粒度；导入后保留原始文件、清洗结果、异常清单与批次编号。</p>' +
          '<p class="modal-hint">支持 CSV / Excel / JSON 与企业计量接口。错误批次整体隔离，不部分写入；15 分钟数据按电量守恒聚合校验。</p>',
        textarea: false,
        confirmText: '模拟选择文件',
        onConfirm: function () { toast('导入向导（原型）', '文件解析、字段映射与质量检查在此接入', ''); }
      });
    });

    window.addEventListener('popstate', function () {
      const v = location.hash.replace('#', '') || 'overview';
      go(v, false);
    });
  }

  function handleAlertAction(action, id) {
    const a = D.alerts.find(x => x.id === id);
    if (!a) return;
    if (action === 'ack') {
      a.status = '处理中';
      a.events.push(['刚刚', '李杰男 · 审核负责人', '确认接单，进入处理']);
      updateAlertViews();
      openAlert(id);
      toast('已确认接单', a.id + ' 状态更新为「处理中」', 'ok');
    } else if (action === 'dispatch') {
      toast('已分派', a.id + ' 已分派至 ' + fieldOf(a, '责任角色'), 'ok');
    } else if (action === 'close') {
      if (a.levelKey === 'block') {
        toast('无法关闭阻断预警', '需先解除触发条件并完成重新审核', 'err');
        return;
      }
      a.status = '已解决';
      a.events.push(['刚刚', '李杰男 · 审核负责人', '关闭预警；条件复核已解除']);
      updateAlertViews();
      openAlert(id);
      toast('预警已关闭', a.id + ' 已记录关闭人与时间', 'ok');
    } else if (action === 'ignore') {
      openModal({
        kicker: 'IGNORE · ' + a.id,
        title: '标记为忽略 / 误报？',
        html: '<p>忽略或误报必须填写原因。记录会写入不可覆盖的审计日志，通知失败也不会丢失。</p>',
        textarea: true,
        placeholder: '填写忽略 / 误报原因（必填）',
        requireText: true,
        confirmText: '确认忽略',
        onConfirm: function (reason) {
          a.status = '已忽略';
          a.events.push(['刚刚', '李杰男 · 审核负责人', '忽略：' + reason]);
          updateAlertViews();
          openAlert(id);
          toast('已标记忽略', '原因已写入审计记录', '');
        }
      });
    }
  }

  /* ---------------------------------------------------------
     boot
     --------------------------------------------------------- */
  function init() {
    hydrateKpis();
    renderPrice();
    renderAlertMini();
    renderOverviewBatches();
    renderSchemeStrip();

    renderSchemeCards();
    renderComposition();
    renderSchemeDetail();
    renderSensitivity();

    renderSchedule();
    renderTiers();
    renderDecision();
    renderLongTerm();
    renderAlertList();
    renderAlertStats();
    updateAlertBadges();

    renderBatches();
    renderQuality();
    renderBilling();

    renderEvidenceIndex();
    seedChat();

    renderReview();
    hydrateTerminal();
    bindEvents();

    const initial = (location.hash || '#overview').slice(1);
    go(initial, false);
  }

  /* The live adapter updates DATA from the authenticated business API. Keep the
     visual shell and its interactions in this file, while exposing one guarded
     redraw entry point for the backend bridge. */
  window.YUANHENG = {
    data: D,
    state: state,
    go: go,
    redraw: function () {
      hydrateKpis();
      renderPrice();
      renderAlertMini();
      renderOverviewBatches();
      renderSchemeStrip();
      renderSchemeCards();
      renderComposition();
      renderSchemeDetail();
      renderSensitivity();
      renderSchedule();
      renderTiers();
      renderDecision();
      renderLongTerm();
      renderAlertList();
      renderAlertStats();
      updateAlertBadges();
      renderBatches();
      renderQuality();
      renderBilling();
      renderEvidenceIndex();
      renderReview();
      hydrateTerminal();
      if (window.YUANHENG_OPERATIONS && window.YUANHENG_OPERATIONS.refresh) window.YUANHENG_OPERATIONS.refresh();
    }
  };

  init();
})();
