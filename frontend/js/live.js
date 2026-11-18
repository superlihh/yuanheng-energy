(function () {
  'use strict';

  const TOKEN_KEY = 'powerpilot_token';
  const REMEMBER_KEY = 'powerpilot_remembered_username';
  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.prototype.slice.call((root || document).querySelectorAll(selector));
  const liveState = { mode: 'login', dashboard: null, alerts: null, aiHistory: [], selectedPlanId: null, user: null, firstAiMessage: true, captcha: '' };

  function esc(value) {
    return String(value === null || value === undefined ? '' : value)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function number(value, fallback) {
    const n = Number(value);
    return Number.isFinite(n) ? n : (fallback === undefined ? 0 : fallback);
  }

  function fmtTime(value) {
    if (!value) return '—';
    const text = String(value);
    return text.length > 16 ? text.slice(5, 16).replace('T', ' ') : text;
  }

  function showSession(message, kind) {
    const box = $('#live-session');
    const text = $('#live-session-text');
    if (!box || !text) return;
    box.hidden = false;
    box.classList.toggle('demo', kind === 'demo');
    box.classList.toggle('error', kind === 'error');
    text.textContent = message;
  }

  function showAuth(message) {
    setAuthMode('login');
    const wall = $('#auth-wall');
    if (wall) wall.hidden = false;
    const error = $('#live-auth-error');
    if (error) error.textContent = message || '';
    const session = $('#live-session');
    if (session) session.hidden = true;
  }

  function refreshCaptcha() {
    const node = $('#live-captcha-code');
    if (!node) return;
    const chars = '23456789ABCDEFGHJKLMNPQRSTUVWXYZ';
    let code = '';
    for (let i = 0; i < 4; i += 1) code += chars[Math.floor(Math.random() * chars.length)];
    liveState.captcha = code;
    node.textContent = code;
    node.setAttribute('aria-label', '刷新验证码，当前验证码为 ' + code);
  }

  function applyRememberedUsername() {
    const input = $('#live-username');
    const remember = $('#live-remember');
    const saved = localStorage.getItem(REMEMBER_KEY) || '';
    if (input && saved && !input.value) input.value = saved;
    if (remember) remember.checked = Boolean(saved);
  }

  function hideAuth() {
    const wall = $('#auth-wall');
    if (wall) wall.hidden = true;
  }

  function setAuthMode(mode) {
    liveState.mode = mode === 'register' ? 'register' : 'login';
    const register = liveState.mode === 'register';
    const wall = $('#auth-wall');
    if (wall) wall.classList.toggle('is-registering', register);
    const title = $('#live-auth-title');
    const subtitle = $('#live-auth-subtitle');
    const submit = $('#live-auth-submit');
    const switcher = $('#live-auth-switch');
    const emailRow = $('#live-email-row');
    if (title) title.textContent = register ? '创建企业空间' : '能源数据平台登录';
    if (subtitle) subtitle.textContent = register ? '建立独立的数据、方案和审核工作区。' : '登录后查看用电、价格与调度方案。';
    if (submit) submit.textContent = register ? '创建并进入' : '登录';
    if (switcher) switcher.textContent = register ? '已有账号？返回登录' : '还没有账号？创建企业空间';
    if (emailRow) emailRow.hidden = !register;
    const error = $('#live-auth-error');
    if (error) error.textContent = '';
    const captcha = $('#live-captcha');
    if (captcha) captcha.value = '';
    refreshCaptcha();
    applyRememberedUsername();
  }

  async function request(path, options) {
    const config = options || {};
    const headers = Object.assign({ Accept: 'application/json' }, config.headers || {});
    if (config.body !== undefined && !(config.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      config.body = JSON.stringify(config.body);
    }
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(path, Object.assign({}, config, { headers: headers }));
    let payload = null;
    try { payload = await response.json(); } catch (_) { payload = {}; }
    if (response.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      showAuth(payload.message || '登录已过期，请重新登录。');
    }
    if (!response.ok) {
      const error = new Error(payload.message || payload.error || ('请求失败（' + response.status + '）'));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function streamRequest(path, options) {
    const config = options || {};
    const headers = Object.assign({ Accept: 'text/event-stream' }, config.headers || {});
    if (config.body !== undefined && !(config.body instanceof FormData)) {
      headers['Content-Type'] = 'application/json';
      config.body = JSON.stringify(config.body);
    }
    const token = localStorage.getItem(TOKEN_KEY);
    if (token) headers.Authorization = 'Bearer ' + token;
    const response = await fetch(path, Object.assign({}, config, { headers }));
    if (response.status === 401) {
      localStorage.removeItem(TOKEN_KEY);
      showAuth('登录已过期，请重新登录。');
    }
    if (!response.ok) {
      let payload = {};
      try { payload = await response.json(); } catch (_) { /* plain error response */ }
      const error = new Error(payload.message || payload.error || ('请求失败（' + response.status + '）'));
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return response;
  }

  function applyUser(user) {
    liveState.user = user || null;
    if (!user) return;
    const name = user.username || '企业用户';
    const strong = $('.user-txt strong');
    const small = $('.user-txt small');
    const avatar = $('.avatar');
    if (strong) strong.textContent = name;
    const workspaceRole = user.workspaceRole || user.role;
    if (small) small.textContent = workspaceRole === 'APPROVER' ? '审核负责人' : workspaceRole === 'FINANCE' ? '财务核验人' : workspaceRole === 'ANALYST' ? '分析人员' : workspaceRole === 'PRODUCTION' ? '生产负责人' : workspaceRole === 'DEVICE' ? '设备负责人' : workspaceRole === 'VIEWER' ? '只读成员' : '企业用能负责人';
    if (avatar) avatar.textContent = name.slice(0, 1).toUpperCase();
  }

  function setText(selector, value) {
    $$(selector).forEach(node => { node.textContent = value; });
  }

  function expandHourly(values, fallback) {
    const source = (values || []).map(v => Number(v)).filter(v => Number.isFinite(v));
    if (source.length >= 96) return source.slice(0, 96);
    if (source.length === 24) return source.reduce((all, item) => all.concat([item, item, item, item]), []);
    if (source.length > 0) {
      const out = source.slice();
      while (out.length < 96) out.push(out[out.length - 1]);
      return out;
    }
    return (fallback || []).slice(0, 96);
  }

  function applyMeta(payload, forecast, profile) {
    const D = window.YUANHENG && window.YUANHENG.data;
    if (!D) return;
    const market = payload.market || {};
    D.meta.planningDay = forecast.forecastDate || market.dateEnd || D.meta.planningDay;
    D.meta.pilot = profile.name || D.meta.pilot;
    D.meta.point = profile.meter || profile.settlementPoint || D.meta.point;
    D.meta.batch = (forecast.evidenceBatchIds && forecast.evidenceBatchIds[0]) || D.meta.batch;
    D.meta.model = forecast.modelVersion || forecast.model || D.meta.model;
    D.meta.calc = '实时计算';
    D.meta.intervalMinutes = (payload.workflow && payload.workflow.datasets && payload.workflow.datasets.intervalMinutes) || 60;
    const granularity = D.meta.intervalMinutes === 15 ? '96 × 15 min' : '24 × 1 h（界面按四段展开）';
    D.meta.granularity = granularity;
    setText('.rail-foot .rail-meta:nth-child(1) strong', profile.name || '未配置企业');
    setText('.rail-foot .rail-meta:nth-child(2) strong', profile.meter || profile.settlementPoint || '未配置计量点');
    setText('.crumb.dim', '规划日 ' + (D.meta.planningDay || '待定') + ' · ' + granularity);
    $$('.batch-chip').forEach(node => { node.textContent = D.meta.batch || '未冻结批次'; });
    $$('.status-chip').forEach(node => { node.innerHTML = '<i class="dot live"></i>数据同步 ' + fmtTime(market.latest && (market.latest.updated_at || market.latest.trade_date)); });
    $$('.eyebrow').forEach(node => {
      if (node.textContent.indexOf('PLANNING DAY') !== -1) {
        node.innerHTML = '<span class="sq"></span>PLANNING DAY · ' + esc(D.meta.planningDay || '待定') + ' · ' + esc(granularity.toUpperCase());
      }
      if (node.textContent.indexOf('FORECAST TERMINAL') !== -1) {
        node.innerHTML = '<span class="sq"></span>02 / FORECAST TERMINAL · ' + esc(granularity.toUpperCase());
      }
    });
  }

  function renderEnergySummary(summary, profile) {
    const grid = $('#energy-summary-grid');
    const dailyTable = $('#energy-summary-daily');
    const monthlyTable = $('#energy-summary-monthly');
    const meta = $('#energy-summary-meta');
    if (!grid || !dailyTable || !monthlyTable || !meta) return;
    const source = summary || {};
    const day = source.latestDay;
    const month = source.latestMonth;
    const fmt = value => Number.isFinite(Number(value)) ? Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
    const money = value => Number.isFinite(Number(value)) ? '¥' + Number(value).toLocaleString('zh-CN', { maximumFractionDigits: 2 }) : '—';
    const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(new Date());
    const currentMonth = today.slice(0, 7);
    const dayLabel = day && day.date === today ? '今日用电量' : '最近一日用电量';
    const monthLabel = month && month.month === currentMonth ? '本月用电量' : '最近一月用电量';
    const cards = [
      [dayLabel, day ? fmt(day.energyKwh) + ' kWh' : '—', day ? day.date + ' · ' + day.hours + ' 小时' : '等待企业小时数据'],
      [monthLabel, month ? fmt(month.energyKwh) + ' kWh' : '—', month ? month.month + ' · ' + month.hours + ' 小时' : '等待企业小时数据'],
      [dayLabel.replace('用电量', '分析费用'), day ? money(day.costYuan) : '—', '按导入价格估算'],
      [monthLabel.replace('用电量', '分析费用'), month ? money(month.costYuan) : '—', '按导入价格估算'],
      ['统计峰值负荷', day ? fmt(day.peakKw) + ' kW' : '—', day ? day.date + ' · 导入数据口径' : '等待企业小时数据'],
      ['已统计小时', source.rowCount ? fmt(source.rowCount) + ' 小时' : '—', '每条记录按 1 小时计算']
    ];
    grid.innerHTML = cards.map(item => '<div class="energy-summary-kpi"><span>' + esc(item[0]) + '</span><strong>' + esc(item[1]) + '</strong><small>' + esc(item[2]) + '</small></div>').join('');
    const renderRows = (rows, key, label) => {
      const values = Array.isArray(rows) ? rows.slice(-7).reverse() : [];
      if (!values.length) return '<tbody><tr><td>暂无企业导入数据</td></tr></tbody>';
      return '<thead><tr><th>' + label + '</th><th>用电量 kWh</th><th>分析费用</th><th>峰值 kW</th><th>小时数</th></tr></thead><tbody>' + values.map(row => '<tr><td>' + esc(row[key]) + (row.demo ? ' <span class="tag tag-warn">演示</span>' : '') + '</td><td>' + esc(fmt(row.energyKwh)) + '</td><td>' + esc(money(row.costYuan)) + '</td><td>' + esc(fmt(row.peakKw)) + '</td><td>' + esc(row.hours) + '</td></tr>').join('') + '</tbody>';
    };
    dailyTable.innerHTML = renderRows(source.daily, 'date', '日期');
    monthlyTable.innerHTML = renderRows(source.monthly, 'month', '月份');
    const model = profile && profile.settlementModel === 'fixed_contract_difference' ? '固定合同差额 + 现货参考' : '现货参考购电费';
    meta.textContent = source.hasData
      ? '数据来源：' + (source.sourceLabel || '企业导入小时数据') + ' · 统计口径：' + (source.calculation || '小时电量 = 负荷 × 1 小时') + ' · 费用口径：' + model + ' · 更新时间：' + fmtTime(source.updatedAt) + ' · 仅供分析，不替代正式账单结算。'
      : '数据来源：暂无企业导入小时数据 · 请先进入“用能设置”确认计量点和费用口径，再到“数据与账单”导入 CSV。';
    window.YUANHENG = window.YUANHENG || {};
    window.YUANHENG.data = window.YUANHENG.data || {};
    window.YUANHENG.data.energySummary = source;
  }

  function applySeries(payload, forecast, optimization, profile) {
    const D = window.YUANHENG && window.YUANHENG.data;
    if (!D) return;
    const slots = forecast.slots || [];
    const oldPrice = D.price || [];
    const oldLoad = (D.load || []).map(v => number(v) * 1000);
    const prices = expandHourly(slots.map(s => s.predictedPrice), oldPrice);
    const loadsKw = expandHourly(slots.map(s => s.predictedLoad), oldLoad);
    const optSlots = optimization.slots || slots;
    const adjustedKw = expandHourly(optSlots.map(s => s.adjustedLoad), loadsKw);
    const chargeKw = expandHourly(optSlots.map(s => s.charge), new Array(96).fill(0));
    const dischargeKw = expandHourly(optSlots.map(s => s.discharge), new Array(96).fill(0));
    const soc = expandHourly(optSlots.map(s => s.soc), D.soc || new Array(96).fill(0));
    D.N = 96;
    D.price = prices;
    D.actualPrice = prices.slice();
    D.load = loadsKw.map(v => number(v) / 1000);
    D.bessPower = chargeKw.map((v, i) => (number(v) - number(dischargeKw[i])) / 1000);
    D.netLoad = adjustedKw.map(v => number(v) / 1000);
    D.soc = soc.map(v => number(v));
    D.gridLimit = number(profile.gridLimitKw, D.gridLimit * 1000) / 1000;
    D.avgPrice = prices.length ? Math.round(prices.reduce((a, b) => a + b, 0) / prices.length * 10) / 10 : D.avgPrice;
    D.maxPrice = Math.max.apply(null, prices.length ? prices : [D.maxPrice]);
    D.maxIdx = prices.indexOf(D.maxPrice);
    D.minPrice = Math.min.apply(null, prices.length ? prices : [D.minPrice]);
    D.minIdx = prices.indexOf(D.minPrice);
    D.peakLoad = Math.max.apply(null, D.load.length ? D.load : [D.peakLoad]);
    D.peakIdx = D.load.indexOf(D.peakLoad);
    D.netPeak = Math.max.apply(null, D.netLoad.length ? D.netLoad : [D.netPeak]);
    D.netPeakIdx = D.netLoad.indexOf(D.netPeak);
    D.stressNet = Math.round(D.netPeak * 1.1 * 10) / 10;
    D.socEnd = D.soc.length ? D.soc[D.soc.length - 1] : D.socEnd;
    D.bessThroughput = chargeKw.reduce((sum, value) => sum + number(value), 0) / 1000;
    const evaluation = forecast.evaluation || [];
    const priceEval = evaluation[0] || {};
    const meanPrice = prices.length ? prices.reduce((sum, value) => sum + value, 0) / prices.length : 1;
    const meanLoadKw = loadsKw.length ? loadsKw.reduce((sum, value) => sum + value, 0) / loadsKw.length : 1;
    D.forecastStats = Object.assign({}, D.forecastStats, {
      mape: priceEval.priceMAE !== undefined ? number(priceEval.priceMAE) / Math.max(1, meanPrice) * 100 : D.forecastStats.mape,
      loadMape: priceEval.loadMAE !== undefined ? number(priceEval.loadMAE) / Math.max(1, meanLoadKw) * 100 : D.forecastStats.loadMape,
      samples: number(priceEval.testHours, D.forecastStats.samples)
    });
  }

  function scenarioName(code) {
    return ({ S0: '原计划', S1: '中长期合同优先', S2: '移峰方案', S3: '储能方案', S4: '组合方案' })[code] || code;
  }

  function applyScenarios(optimization) {
    const D = window.YUANHENG && window.YUANHENG.data;
    const scenarios = optimization.scenarios;
    if (!D || !Array.isArray(scenarios) || !scenarios.length) return;
    const old = D.schemes || [];
    D.schemes = scenarios.map((item, index) => {
      const code = item.code || item.id || ('S' + index);
      const previous = old.find(s => s.id === code) || {};
      const cost = item.cost !== undefined ? item.cost : item.optimizedCost;
      const baseline = item.baselineCost !== undefined ? item.baselineCost : optimization.baselineCost;
      const saving = item.saving !== undefined ? item.saving : (number(baseline, 0) - number(cost, 0));
      const breakdown = item.breakdown || {};
      const feasible = item.status === 'FEASIBLE' || item.status === 'REFERENCE' || item.status === undefined;
      return Object.assign({}, previous, {
        id: code, name: scenarioName(code), short: code,
        cost: cost === null || cost === undefined ? previous.cost : number(cost),
        diff: saving === null || saving === undefined ? previous.diff : number(saving),
        feasible: feasible, feasibleText: feasible ? '可行' : (item.status || '数据不足'),
        nature: item.message || previous.nature || '后端计算',
        natureTag: feasible ? 'lime' : 'danger',
        note: item.solver || previous.note || '后端计算结果',
        comp: Object.assign({}, previous.comp || {}, {
          energy: number(breakdown.gridEnergyCost, previous.comp && previous.comp.energy),
          contract: number(breakdown.contractDifference, previous.comp && previous.comp.contract),
          bess: number(breakdown.degradationCost, previous.comp && previous.comp.bess),
          ops: number(breakdown.maintenanceCost, previous.comp && previous.comp.ops)
        }),
        tag: code === 'S4' ? '推荐' : (feasible ? '可行' : '数据不足')
      });
    });
  }

  function applyBatches(workflow) {
    const D = window.YUANHENG && window.YUANHENG.data;
    const dataset = workflow.datasets || {};
    if (!D || !Array.isArray(dataset.batches)) return;
    const interval = dataset.intervalMinutes || 60;
    D.batches = dataset.batches.map(batch => {
      const meta = batch.metadata || {};
      const issueCount = Array.isArray(batch.issues) ? batch.issues.length : 0;
      const completeness = batch.row_count ? Math.min(100, Math.round(batch.row_count / Math.max(1, dataset.completeDays * 24) * 1000) / 10) : null;
      return {
        id: 'B-' + batch.id, backendId: batch.id, name: batch.filename || '未命名批次',
        sub: meta.source || (batch.is_demo ? '系统演示数据' : '企业导入'),
        gran: (meta.intervalMinutes || interval) + 'min', completeness: completeness,
        fresh: fmtTime(batch.created_at), status: batch.status === 'ACCEPTED' ? '已接收' : batch.status === 'REJECTED' ? '已隔离' : batch.status,
        statusKey: batch.status === 'ACCEPTED' ? 'ok' : 'danger', fp: String(batch.digest || '').slice(0, 8) + '…',
        note: issueCount ? ('发现 ' + issueCount + ' 项质量问题，批次未写入计算') : ('已写入 ' + number(batch.row_count) + ' 条记录')
      };
    });
    const issues = [];
    dataset.batches.forEach(batch => (batch.issues || []).forEach(issue => issues.push({
      mark: '!', level: 'open', title: (batch.filename || '批次') + ' · 第' + issue.line + '行',
      meta: issue.message || '导入质量问题', status: '未关闭'
    })));
    if (issues.length) D.issues = issues;
  }

  function applyActualSaving(savings) {
    const valueNode = $('#actual-saving');
    const tagNode = $('.actual-save .tag');
    const noteNode = $('.actual-save p');
    const record = (savings || [])[0];
    const amount = record ? (record.actual_saving !== undefined ? record.actual_saving : record.payload && record.payload.actualSaving) : null;
    if (!record || !Number.isFinite(Number(amount))) {
      if (valueNode) valueNode.textContent = '—';
      if (tagNode) { tagNode.textContent = '未核验 · 保持为空'; tagNode.className = 'tag tag-danger'; }
      if (noteNode) noteNode.innerHTML = '正式账单、实际曲线和反事实基准尚未完成同口径核验。actualSaving 保持为空，不登记为 0。';
      return;
    }
    if (valueNode) valueNode.textContent = '¥' + number(amount).toFixed(2);
    if (tagNode) { tagNode.textContent = '已核验 · ' + fmtTime(record.created_at); tagNode.className = 'tag tag-ok'; }
    if (noteNode) noteNode.textContent = '该金额来自已确认账单、24 小时实际曲线和经授权人员确认的反事实基准，范围与排除项见核验记录。';
  }

  function applyBilling(workflow) {
    const D = window.YUANHENG && window.YUANHENG.data;
    const bill = (workflow.bills || [])[0];
    applyActualSaving(workflow.savings || []);
    const confirmButton = $('#confirm-bill-btn');
    if (!D || !bill) {
      if (confirmButton) confirmButton.hidden = true;
      return;
    }
    D.billing = {
      period: bill.period_start + (bill.period_end !== bill.period_start ? ' 至 ' + bill.period_end : ''),
      point: D.meta.point, tolerance: '±¥' + number(bill.tolerance).toFixed(2),
      rows: (bill.items || []).map(item => ({ item: item.name, recalc: item.calculated, bill: item.officialAmount, diff: item.difference, tol: '±¥' + number(bill.tolerance).toFixed(2), status: Math.abs(number(item.difference)) <= number(bill.tolerance) ? '通过' : '超差' })),
      recalcTotal: number(bill.calculated_total), billTotal: number(bill.official_total),
      backendId: bill.id, status: bill.status
    };
    if (confirmButton) {
      confirmButton.hidden = bill.status !== 'PENDING';
      confirmButton.dataset.billId = String(bill.id);
    }
    const billTag = $('.bill-meta .tag');
    if (billTag) {
      billTag.textContent = bill.status === 'CONFIRMED' ? '已确认' : '核验中';
      billTag.className = 'tag ' + (bill.status === 'CONFIRMED' ? 'tag-ok' : 'tag-warn');
    }
  }

  function applyReviews(workflow) {
    const D = window.YUANHENG && window.YUANHENG.data;
    const plans = workflow.plans || [];
    const executeBox = $('#execute-box');
    if (!plans.length) {
      if (executeBox) executeBox.hidden = true;
      return;
    }
    const plan = plans[0];
    if (executeBox) {
      const canExecute = plan.status === 'APPROVED';
      executeBox.hidden = !canExecute;
      if (canExecute) {
        const expected = plan.snapshot && Array.isArray(plan.snapshot.slots)
          ? plan.snapshot.slots.reduce((sum, slot) => sum + Number(slot.adjustedLoad || 0), 0)
          : 0;
        const actualInput = $('#actual-kwh');
        if (actualInput && !actualInput.value && Number.isFinite(expected)) actualInput.value = expected.toFixed(2);
      }
    }
    if (!D) return;
    liveState.selectedPlanId = plan.id;
    const statusText = { DRAFT: '草案', APPROVED: '已批准', REJECTED: '已驳回', EXECUTED: '已执行' }[plan.status] || plan.status;
    D.reviews.current = 'V-' + plan.id;
    D.reviews.versions = plans.slice(0, 5).map(item => ({
      id: 'V-' + item.id, name: (item.snapshot && item.snapshot.code ? item.snapshot.code : '用能优化方案') + ' · ' + item.plan_date,
      status: { DRAFT: '审核中', APPROVED: '已批准', REJECTED: '已驳回', EXECUTED: '已执行' }[item.status] || item.status,
      statusKey: item.status === 'APPROVED' || item.status === 'EXECUTED' ? 'ok' : item.status === 'REJECTED' ? 'danger' : 'warn',
      who: liveState.user ? liveState.user.username : '企业用户', time: fmtTime(item.created_at), cost: item.snapshot && item.snapshot.cost
    }));
    if (!D.reviews.versions.length) D.reviews.versions = [{ id: 'V-' + plan.id, name: '当前计算方案', status: statusText, statusKey: 'warn', who: '企业用户', time: '刚刚', cost: null }];
  }

  function syncLiveReviewActions() {
    const container = $('#review-actions');
    const tag = $('#review-status-tag');
    const plan = (liveState.workflow && liveState.workflow.plans || [])[0];
    if (!container || !plan) return;
    const role = liveState.user && (liveState.user.workspaceRole || liveState.user.role);
    const statusText = { DRAFT: '草案', SUBMITTED: '待审核', IN_REVIEW: '审核中', APPROVED: '已批准', EXECUTED: '已执行', REJECTED: '已驳回', RETURNED: '已退回' }[plan.status] || plan.status;
    if (tag) {
      tag.textContent = statusText;
      tag.className = 'tag ' + (plan.status === 'APPROVED' || plan.status === 'EXECUTED' ? 'tag-ok' : plan.status === 'REJECTED' ? 'tag-danger' : 'tag-warn');
    }
    if (plan.status === 'DRAFT') {
      container.innerHTML = role !== 'OWNER' && role !== 'ANALYST'
        ? '<p class="review-waiting">等待提交人提交审核；批准人不能直接改变草案状态。</p>'
        : '<button class="btn btn-primary" id="btn-submit-plan">提交方案审核</button><p class="review-waiting">提交后由独立审核负责人复核，提交人不能批准自己的版本。</p>';
      return;
    }
    if ((plan.status === 'SUBMITTED' || plan.status === 'IN_REVIEW') && role === 'APPROVER') {
      container.innerHTML = '<button class="btn btn-primary" id="btn-approve">批准当前版本</button><button class="btn btn-ghost" id="btn-return">退回修改</button><button class="btn btn-quiet" id="btn-reject">驳回</button>';
      return;
    }
    if (plan.status === 'SUBMITTED' || plan.status === 'IN_REVIEW') {
      container.innerHTML = '<p class="review-waiting">已提交，等待独立审核负责人处理。</p>';
      return;
    }
    if (plan.status === 'APPROVED' || plan.status === 'EXECUTED') {
      container.innerHTML = '<p class="review-waiting">' + (plan.status === 'EXECUTED' ? '已登记实际执行，等待正式账单复盘。' : '已批准，执行前复核已开启。') + '</p>';
      return;
    }
    container.innerHTML = '<p class="review-waiting">当前版本已结束，需创建新版本后继续。</p>';
  }

  function applySavingVerification(workflow) {
    const box = $('#saving-verification-box');
    if (!box) return;
    const plans = (workflow.plans || []).filter(plan => plan.status === 'EXECUTED');
    const bills = (workflow.bills || []).filter(bill => bill.status === 'CONFIRMED');
    const planSelect = $('#verify-plan-select');
    const billSelect = $('#verify-bill-select');
    if (!plans.length || !bills.length || (workflow.savings || []).length) {
      box.hidden = true;
      return;
    }
    box.hidden = false;
    if (planSelect) {
      const previous = planSelect.value;
      planSelect.innerHTML = plans.map(plan => '<option value="' + esc(plan.id) + '">#' + esc(plan.id) + ' · ' + esc(plan.plan_date) + '</option>').join('');
      if (plans.some(plan => String(plan.id) === previous)) planSelect.value = previous;
    }
    if (billSelect) {
      const previous = billSelect.value;
      billSelect.innerHTML = bills.map(bill => '<option value="' + esc(bill.id) + '">#' + esc(bill.id) + ' · ' + esc(bill.period_start) + ' · ¥' + number(bill.official_total).toFixed(2) + '</option>').join('');
      if (bills.some(bill => String(bill.id) === previous)) billSelect.value = previous;
    }
  }

  function applyTeam(workflow) {
    const current = workflow.team && workflow.team.current ? workflow.team.current : liveState.user;
    const role = current && (current.workspaceRole || current.role);
    const roleNames = { OWNER: '企业所有者', APPROVER: '独立批准人', FINANCE: '财务核验人', ANALYST: '分析人员', PRODUCTION: '生产负责人', DEVICE: '设备负责人', VIEWER: '只读成员' };
    const roleText = $('#team-role-text');
    const identityText = $('#review-identity-text');
    const inviteRow = $('#team-invite-row');
    if (roleText) roleText.textContent = '当前角色：' + (roleNames[role] || role || '未识别') + ' · 审批和核验由服务端强制分权。';
    if (identityText) identityText.textContent = '当前身份：' + ((current && current.username) || '企业用户') + ' · ' + (roleNames[role] || role || '未识别');
    if (inviteRow) inviteRow.hidden = role !== 'OWNER';
    const profileSettings = $('#profile-settings');
    if (profileSettings) profileSettings.hidden = !['OWNER', 'ANALYST', 'PRODUCTION'].includes(role);
    const registerSettings = $('#device-register-panel');
    if (registerSettings) registerSettings.hidden = !['OWNER', 'ANALYST', 'DEVICE'].includes(role);
    const canImport = ['OWNER', 'ANALYST'].includes(role);
    const importButton = $('#import-btn');
    const demoButton = $('#demo-btn');
    if (importButton) importButton.hidden = !canImport;
    if (demoButton) demoButton.hidden = !canImport;
  }

  function applyProfileForm(profile) {
    const form = $('#profile-form');
    if (!form || !profile) return;
    Object.keys(profile).forEach(key => {
      const field = form.elements[key];
      if (!field) return;
      if (field.type === 'checkbox') field.checked = !!profile[key];
      else if (key !== 'tasks') field.value = profile[key] === null || profile[key] === undefined ? '' : profile[key];
    });
    const tasks = form.elements.tasksJson;
    if (tasks && Array.isArray(profile.tasks) && profile.tasks.length && document.activeElement !== tasks) tasks.value = JSON.stringify(profile.tasks, null, 2);
  }

  async function saveProfile(event) {
    event.preventDefault();
    const form = event.target;
    const data = Object.fromEntries(new FormData(form));
    ['ruleVerified', 'dataAuthorized', 'constraintsConfirmed', 'storageEnabled', 'storageParametersConfirmed'].forEach(key => { data[key] = form.elements[key].checked; });
    ['gridLimitKw', 'processKw', 'duration', 'baselineStart', 'windowStart', 'windowEnd', 'capacityKwh', 'storagePowerKw', 'socInitial', 'socMin', 'socMax', 'roundtripEfficiency', 'degradationYuanKwh', 'maintenanceYuanDay'].forEach(key => { data[key] = Number(data[key]); });
    data.settlementModel = form.elements.settlementModel ? form.elements.settlementModel.value : 'spot_only';
    const tasksText = String(data.tasksJson || '').trim();
    delete data.tasksJson;
    if (tasksText) {
      try { data.tasks = JSON.parse(tasksText); } catch (_) { showSession('生产任务 JSON 格式无效，请检查括号和引号', 'error'); return; }
    } else {
      const existing = liveState.workflow && liveState.workflow.profile && liveState.workflow.profile.values && liveState.workflow.profile.values.tasks;
      data.tasks = Array.isArray(existing) ? existing : [];
    }
    const result = $('#profile-save-result');
    if (result) result.textContent = '正在保存…';
    try {
      await request('/api/profile', { method: 'POST', body: data });
      if (result) result.textContent = '已保存，正在重新计算';
      showSession('企业与生产约束已保存 · 方案将按新版本重新计算', '');
      await hydrate();
    } catch (error) {
      if (result) result.textContent = error.message || '保存失败';
      showSession('企业参数保存失败 · ' + (error.message || '请检查输入'), 'error');
    }
  }

  function deviceStatusText(status) {
    return ({ ONLINE: '在线', WARNING: '需处理', STALE: '数据过期', NO_DATA: '无遥测', DISABLED: '已停用' })[status] || status || '未知';
  }

  function deviceValue(values, key, suffix) {
    const value = values && values[key];
    return value === null || value === undefined || value === '' ? '—' : number(value).toFixed(key === 'temperatureC' ? 1 : 1) + (suffix || '');
  }

  function renderDeviceTelemetry(payload) {
    const note = $('#device-detail-note');
    const table = $('#device-telemetry-table');
    if (!table) return;
    const device = payload && payload.device;
    const points = payload && Array.isArray(payload.points) ? payload.points : [];
    if (!device) {
      if (note) note.textContent = '选择设备后查看最近观测。质量码、采集时间、来源批次和原始摘要都保留在系统中。';
      table.innerHTML = '<tbody><tr><td>暂无遥测数据</td></tr></tbody>';
      return;
    }
    if (note) note.textContent = (device.mode === 'DEMO' ? '【合成演示】' : '【现场设备】') + ' ' + device.name + ' · ' + (device.config && (device.config.source || '未填写来源')) + ' · 展示最近 ' + points.length + ' 条观测。';
    const rows = points.slice(-48).reverse();
    table.innerHTML = '<thead><tr><th>观测时间</th><th>质量</th><th>功率 kW</th><th>SOC %</th><th>温度 ℃</th><th>状态</th><th>批次</th></tr></thead><tbody>' +
      (rows.length ? rows.map(point => '<tr><td>' + esc(fmtTime(point.timestamp)) + '</td><td>' + esc(point.quality || '—') + '</td><td>' + deviceValue(point.values, 'powerKw') + '</td><td>' + deviceValue(point.values, 'soc') + '</td><td>' + deviceValue(point.values, 'temperatureC') + '</td><td>' + esc((point.values && point.values.state) || '—') + '</td><td>#' + esc(point.batchId) + '</td></tr>').join('') : '<tr><td colspan="7">尚无有效遥测</td></tr>') + '</tbody>';
  }

  async function loadDeviceTelemetry(deviceId) {
    if (!deviceId) { renderDeviceTelemetry(null); return; }
    try {
      const payload = await request('/api/telemetry?deviceId=' + encodeURIComponent(deviceId));
      renderDeviceTelemetry(payload);
    } catch (error) {
      const note = $('#device-detail-note');
      if (note) note.textContent = '遥测读取失败 · ' + (error.message || '请检查设备权限');
    }
  }

  function applyDevices(payload) {
    const data = payload || {};
    const devices = Array.isArray(data.devices) ? data.devices : [];
    const counts = data.counts || {};
    const summary = $('#device-summary');
    if (summary) {
      const demo = number(counts.demo);
      summary.innerHTML = [
        ['已登记设备', number(counts.total), '设备台账'],
        ['在线设备', number(counts.online), '最新遥测正常'],
        ['需要处理', number(counts.attention), '过期 / 越限 / 故障'],
        ['数据性质', demo ? (demo + ' 台演示') : (devices.length ? '现场只读' : '待接入'), demo ? '不进入收益验收' : '按批次追溯']
      ].map(item => '<div class="device-kpi"><span>' + esc(item[0]) + '</span><strong>' + esc(item[1]) + '</strong><small>' + esc(item[2]) + '</small></div>').join('');
    }
    const list = $('#device-list');
    if (list) {
      list.innerHTML = devices.length ? devices.map(item => {
        const cfg = item.config || {};
        const latest = item.latest || {};
        const values = latest.values || {};
        const statusClass = item.status === 'ONLINE' ? 'tag-ok' : item.status === 'DISABLED' ? 'tag-neutral' : 'tag-danger';
        const issues = (item.issues || []).map(issue => '<p class="device-issue">' + esc(issue.message) + ' · 当前值 ' + esc(issue.value) + ' · 阈值 ' + esc(issue.threshold) + esc(issue.unit || '') + '</p>').join('');
        return '<article class="panel device-card reveal"><div class="panel-head"><div><h3>' + esc(item.name) + '</h3><span class="device-mode ' + (item.mode === 'DEMO' ? 'demo' : 'real') + '">' + esc(item.device_id) + ' · ' + (item.mode === 'DEMO' ? '合成演示' : '现场设备') + '</span></div><span class="tag ' + statusClass + '">' + esc(deviceStatusText(item.status)) + '</span></div><p class="device-meta">' + esc(cfg.line || '未填写产线') + ' · 设备 ' + esc(cfg.equipmentId || '未关联') + '<br>来源：' + esc(cfg.source || '未填写') + ' · ' + (cfg.enforce ? '异常将阻断审核/执行' : '仅观测') + '</p><div class="device-readings"><div><span>功率</span><strong>' + deviceValue(values, 'powerKw', ' kW') + '</strong></div><div><span>SOC</span><strong>' + deviceValue(values, 'soc', ' %') + '</strong></div><div><span>状态</span><strong>' + esc(values.state || '—') + '</strong></div></div><p class="device-meta">最近观测：' + esc(fmtTime(latest.timestamp) || '—') + (item.ageSeconds !== null && item.ageSeconds !== undefined ? ' · ' + number(item.ageSeconds, 0).toFixed(0) + ' 秒前' : '') + '</p>' + issues + '<div class="device-actions"><button class="btn btn-quiet btn-sm" type="button" data-device-view="' + esc(item.device_id) + '">查看遥测</button></div></article>';
      }).join('') : '<article class="panel device-empty">尚未同步设备台账。可刷新现场状态，或在空的企业空间载入明确标识的合成设备。</article>';
    }
    const select = $('#device-select');
    if (select) {
      const previous = select.value;
      select.innerHTML = devices.length ? devices.map(item => '<option value="' + esc(item.device_id) + '">' + esc(item.name) + ' · ' + esc(item.device_id) + '</option>').join('') : '<option value="">暂无设备</option>';
      if (devices.some(item => item.device_id === previous)) select.value = previous;
      if (select.value) loadDeviceTelemetry(select.value); else renderDeviceTelemetry(null);
    }
  }

  async function refreshDevices() {
    try {
      const payload = await request('/api/devices');
      applyDevices(payload);
      showSession('设备台账已刷新 · 现场遥测仍为只读数据', '');
    } catch (error) {
      showSession('设备状态刷新失败 · ' + (error.message || '请检查服务状态'), 'error');
    }
  }

  async function loadDeviceDemo() {
    if (!window.confirm('演示设备和遥测为合成数据，不会证明企业真实节省。仅在空设备空间载入，继续吗？')) return;
    try {
      const payload = await request('/api/devices/demo', { method: 'POST', body: {} });
      applyDevices(payload);
      showSession('已载入 5 台合成设备 · 请勿用于企业收益验收', 'demo');
    } catch (error) {
      showSession('设备演示未载入 · ' + (error.message || '当前空间已有设备'), 'error');
    }
  }

  async function saveDevice(event) {
    event.preventDefault();
    const form = event.target;
    const data = Object.fromEntries(new FormData(form));
    data.enabled = form.elements.enabled.checked;
    data.enforce = form.elements.enforce.checked;
    data.ratedPowerKw = Number(data.ratedPowerKw);
    data.staleSeconds = Number(data.staleSeconds);
    try {
      await request('/api/devices', { method: 'POST', body: data });
      await refreshDevices();
      form.closest('details').open = false;
      showSession('设备台账已保存 · 现有批准方案需重新做执行前复核', '');
    } catch (error) {
      showSession('设备台账保存失败 · ' + (error.message || '请检查字段'), 'error');
    }
  }

  function applyDashboard(payload) {
    liveState.dashboard = payload;
    const workflow = payload.workflow || {};
    liveState.workflow = workflow;
    const profile = workflow.profile && workflow.profile.values ? workflow.profile.values : {};
    const forecast = payload.forecast || (payload.optimization && payload.optimization.forecast) || {};
    const optimization = payload.optimization || {};
    const hasEnterpriseData = Array.isArray(forecast.slots) && forecast.slots.length > 0;
    document.body.classList.toggle('has-enterprise-data', hasEnterpriseData);
    applyMeta(payload, forecast, profile);
    applyProfileForm(profile);
    renderEnergySummary(workflow.energySummary || payload.energySummary || {}, profile);
    applySeries(payload, forecast, optimization, profile);
    if (Array.isArray(workflow.readiness) && workflow.readiness.length) {
      const D = window.YUANHENG && window.YUANHENG.data;
      if (D) D.constraints = workflow.readiness.map(check => ({ title: check.label, meta: check.passed ? '已满足当前企业口径' : '待补齐，暂不进入正式审核' }));
    }
    applyScenarios(optimization);
    applyBatches(workflow);
    applyBilling(workflow);
    applyReviews(workflow);
    applySavingVerification(workflow);
    applyTeam(workflow);
    const demo = number(workflow.datasets && workflow.datasets.demoRows) > 0 || forecast.isDemo;
    if (demo) showSession('后端已同步 · 当前含合成演示数据，金额不可作为真实收益', 'demo');
    else if (!forecast.slots || !forecast.slots.length) showSession('已登录 · 尚未形成企业分时预测，请先导入完整小时数据', 'error');
    else showSession('后端已同步 · 预测和方案来自当前企业数据', '');
    if (window.YUANHENG && window.YUANHENG.redraw) window.YUANHENG.redraw();
    syncLiveReviewActions();
    renderDecisionLoop();
  }

  function applyAlerts(payload) {
    const D = window.YUANHENG && window.YUANHENG.data;
    if (!D) return;
    const source = payload && payload.records ? payload : (payload && payload.alerts ? payload.alerts : {});
    liveState.alerts = source;
    const level = { BLOCKING: ['阻断', 'block'], IMPORTANT: ['重要', 'important'], GENERAL: ['一般', 'general'], NOTICE: ['提示', 'notice'] };
    const status = { OPEN: '待处理', ACKNOWLEDGED: '处理中', IN_PROGRESS: '处理中', RESOLVED: '已解决', IGNORED: '已忽略', FALSE_POSITIVE: '已忽略' };
    D.alerts = (source.records || []).map(record => {
      const pair = level[record.level] || ['提示', 'notice'];
      return {
        id: 'A-' + record.id, backendId: record.id, level: pair[0], levelKey: pair[1], type: record.category || '业务规则',
        status: status[record.status] || record.status, title: record.title || '企业用能预警',
        desc: record.details && (record.details.message || record.details.reason || record.details.description) || '请打开预警查看触发条件、依据与处置记录。',
        meta: record.assigned_to ? '责任人：' + record.assigned_to : '更新时间：' + fmtTime(record.updated_at),
        due: fmtTime(record.due_at), events: (source.actions || []).filter(a => a.alert_id === record.id).map(a => [fmtTime(a.created_at), a.action, a.note]),
        link: 'ALERT #' + record.id
      };
    });
    if (window.YUANHENG && window.YUANHENG.redraw) window.YUANHENG.redraw();
    syncLiveReviewActions();
    renderDecisionLoop();
  }

  function renderDecisionLoop() {
    const track = $('#decision-loop-track');
    const next = $('#decision-loop-next');
    const mode = $('#decision-loop-mode');
    const intro = $('#decision-loop-intro');
    if (!track || !next) return;
    const workflow = liveState.workflow || {};
    const datasets = workflow.datasets || {};
    const readiness = workflow.readiness || [];
    const plans = workflow.plans || [];
    const bills = workflow.bills || [];
    const alerts = workflow.alerts || liveState.alerts || {};
    const savings = workflow.savings || [];
    const optimization = (liveState.dashboard && liveState.dashboard.optimization) || {};
    const ready = label => readiness.some(item => item.label === label && item.passed);
    const missing = readiness.filter(item => !item.passed).map(item => item.label);
    const completeData = Number(datasets.completeDays || 0) > 0 && ready('完整小时价格和负荷');
    const profileReady = ['企业与计量点', '数据使用已获授权', '购电与规则口径已确认', '生产设备约束已确认', '企业审核责任人'].every(ready);
    const bill = bills[0];
    const billDone = !!bill && bill.status === 'CONFIRMED';
    const plan = plans[0];
    const planDone = !!plan;
    const approved = !!plan && (plan.status === 'APPROVED' || plan.status === 'EXECUTED');
    const executed = !!plan && plan.status === 'EXECUTED';
    const blocking = Number(alerts.counts && alerts.counts.blocking || 0);
    const active = Number(alerts.counts && alerts.counts.active || 0);
    const steps = [
      { index: '01', title: '数据可信', detail: completeData ? datasets.completeDays + ' 个完整日 · 已通过基础校验' : (missing[0] || '导入完整小时价格与负荷'), state: completeData && profileReady ? 'done' : 'current' },
      { index: '02', title: '账单可核对', detail: billDone ? '正式账单已确认 · 可用于实际节省核验' : bill ? '账单已导入 · 等待逐项复核' : '尚未建立账单基线', state: billDone ? 'done' : completeData ? 'current' : 'pending' },
      { index: '03', title: '方案可执行', detail: planDone ? ('当前版本 ' + plan.id + ' · ' + (plan.status || 'DRAFT')) : (optimization.status === 'FEASIBLE' ? '优化完成 · 需要保存方案草案' : '等待可行的价格、负荷和约束输入'), state: planDone ? 'done' : optimization.status === 'FEASIBLE' ? 'current' : 'pending' },
      { index: '04', title: '审核与执行', detail: blocking ? blocking + ' 项阻断预警 · 禁止批准或执行' : approved ? (executed ? '已登记执行 · 等待正式账单复盘' : '已批准 · 可登记实际执行') : plan && (plan.status === 'SUBMITTED' || plan.status === 'IN_REVIEW') ? '已提交 · 等待独立批准人审核' : plan && plan.status === 'DRAFT' ? '草案等待提交审核' : '尚未进入审核', state: blocking ? 'blocked' : approved ? 'done' : planDone ? 'current' : 'pending' },
      { index: '05', title: '结果可证明', detail: savings.length ? '已形成实际节省核验记录' : executed ? '已执行 · 需要实际计量、反事实基准和账单' : '执行后才进入实际节省核验', state: savings.length ? 'done' : executed ? 'current' : 'pending' }
    ];
    track.innerHTML = steps.map(step => '<div class="loop-step ' + step.state + '"><span class="loop-index">' + step.index + ' / ' + (step.state === 'done' ? 'DONE' : step.state === 'blocked' ? 'BLOCKED' : step.state === 'current' ? 'NEXT' : 'WAIT') + '</span><strong>' + esc(step.title) + '</strong><small>' + esc(step.detail) + '</small></div>').join('');
    let action = { title: '先导入企业数据并完成口径确认', detail: '当前系统不把公开日级市场数据直接当成企业分时价格。', view: 'data', className: 'tag-warn' };
    if (!profileReady || !completeData) {
      action = { title: '补齐企业口径并导入完整小时数据', detail: missing.length ? '待处理：' + missing.slice(0, 3).join('、') : '需要至少一个完整日的企业价格和负荷数据。', view: 'data', className: 'tag-warn' };
    } else if (!billDone) {
      action = { title: bill ? '复核正式账单，建立费用基线' : '导入正式账单，建立费用基线', detail: '账单未确认前，任何金额都不登记为实际节省。', view: 'data', tab: 'billing', className: 'tag-warn' };
    } else if (blocking) {
      action = { title: '先处理阻断预警', detail: '当前有 ' + blocking + ' 项阻断条件，系统不会允许方案批准或执行。', view: 'alerts', className: 'tag-danger' };
    } else if (!planDone && optimization.status === 'FEASIBLE') {
      action = { title: '保存当前可行方案草案', detail: '保存后才能进入版本审核，并冻结本次输入指纹。', action: 'save-plan', view: 'compare', className: 'tag-lime' };
    } else if (plan && plan.status === 'DRAFT') {
      action = { title: '提交方案审核', detail: '由生产、设备和费用负责人确认执行边界。', view: 'review', className: 'tag-lime' };
    } else if (plan && (plan.status === 'SUBMITTED' || plan.status === 'IN_REVIEW')) {
      action = { title: '等待独立批准人审核', detail: '提交人不能批准自己的版本；审核完成后才会开启执行登记。', view: 'review', className: 'tag-warn' };
    } else if (approved && !executed) {
      action = { title: '登记实际执行结果', detail: '执行记录需要实际电量和计量来源，不能用模拟值替代。', view: 'review', className: 'tag-lime' };
    } else if (executed && !savings.length) {
      action = { title: '导入实际曲线并核验正式账单', detail: '完成反事实基准与正式账单核对后，才会生成 actualSaving。', view: 'data', tab: 'billing', className: 'tag-warn' };
    } else if (savings.length) {
      action = { title: '复盘已完成，可创建下一版方案', detail: '当前闭环已有可核验结果，下一步可以比较新的生产周期。', view: 'compare', className: 'tag-lime' };
    }
    if (mode) { mode.textContent = blocking ? '阻断中' : savings.length ? '已闭环' : '进行中'; mode.className = 'tag ' + action.className; }
    if (intro) intro.textContent = active ? ('当前有 ' + active + ' 项活动预警，系统按“先处理风险、再批准方案”的顺序推进。') : '系统按数据、账单、方案、审核和复盘的先后顺序判断下一步动作。';
    const tabAttr = action.tab ? ' data-loop-tab="' + action.tab + '"' : '';
    const actionButton = action.action === 'save-plan' ? '<button class="btn btn-primary btn-sm" type="button" data-loop-action="save-plan">保存方案草案</button>' : '<button class="btn btn-ghost btn-sm" type="button" data-goto="' + action.view + '"' + tabAttr + '>进入处理 →</button>';
    next.innerHTML = '<div><span class="micro">NEXT ACTION</span><strong>' + esc(action.title) + '</strong><small>' + esc(action.detail) + '</small></div>' + actionButton;
  }

  async function savePlanDraft() {
    try {
      const result = await request('/api/plans', { method: 'POST', body: {} });
      liveState.selectedPlanId = result.id;
      showSession('方案草案已保存 · 已冻结当前输入指纹', '');
      await hydrate();
    } catch (error) {
      showSession('方案保存失败 · ' + error.message, 'error');
    }
  }

  async function confirmBill() {
    const button = $('#confirm-bill-btn');
    const billId = button && Number(button.dataset.billId);
    if (!billId || !window.confirm('确认已核对合同、计量和正式账单吗？确认后该账单会进入方案审核口径。')) return;
    try {
      await request('/api/bills/confirm', { method: 'POST', body: { id: billId, confirmed: true } });
      showSession('账单已确认 · 可进入方案审核闭环', '');
      await hydrate();
    } catch (error) {
      showSession('账单确认失败 · ' + error.message, 'error');
    }
  }

  async function executePlan() {
    const plan = (liveState.workflow && liveState.workflow.plans || [])[0];
    const actualInput = $('#actual-kwh');
    const noteInput = $('#execution-note');
    const actualKwh = actualInput ? Number(actualInput.value) : NaN;
    const note = noteInput ? noteInput.value.trim() : '';
    if (!plan || plan.status !== 'APPROVED') {
      showSession('当前没有可登记的已批准方案', 'error');
      return;
    }
    if (!Number.isFinite(actualKwh) || actualKwh < 0 || !note) {
      showSession('请填写实际执行电量和计量来源', 'error');
      return;
    }
    try {
      await request('/api/plans/execute', { method: 'POST', body: { id: plan.id, actualKwh: actualKwh, note: note } });
      showSession('实际执行已登记 · 等待实际曲线和正式账单复盘', '');
      await hydrate();
    } catch (error) {
      showSession('执行登记失败 · ' + error.message, 'error');
    }
  }

  async function submitPlan() {
    const plan = (liveState.workflow && liveState.workflow.plans || [])[0];
    if (!plan || plan.status !== 'DRAFT') { showSession('当前没有可提交的草案', 'error'); return; }
    const note = window.prompt('请填写提交审核说明（必填）', '已核对生产约束、设备边界和费用口径');
    if (!note || !note.trim()) return;
    try {
      await request('/api/plans/review', { method: 'POST', body: { id: plan.id, action: 'SUBMITTED', note: note.trim() } });
      showSession('方案已提交 · 等待独立审核负责人处理', '');
      await hydrate();
    } catch (error) {
      showSession('提交审核失败 · ' + error.message, 'error');
    }
  }

  async function inviteMember() {
    const role = $('#invite-role') && $('#invite-role').value;
    const resultNode = $('#team-result');
    try {
      const result = await request('/api/team/invite', { method: 'POST', body: { role: role } });
      if (resultNode) resultNode.textContent = '邀请码：' + result.inviteCode + ' · 有效期 ' + result.expiresInHours + ' 小时';
    } catch (error) {
      if (resultNode) resultNode.textContent = '生成失败 · ' + error.message;
    }
  }

  async function joinWorkspace() {
    const codeInput = $('#join-code');
    const resultNode = $('#team-result');
    const code = codeInput ? codeInput.value.trim() : '';
    if (!code) { if (resultNode) resultNode.textContent = '请先粘贴企业邀请码。'; return; }
    try {
      await request('/api/team/join', { method: 'POST', body: { code: code } });
      if (resultNode) resultNode.textContent = '已加入企业空间，正在刷新当前角色…';
      if (codeInput) codeInput.value = '';
      await hydrate();
    } catch (error) {
      if (resultNode) resultNode.textContent = '加入失败 · ' + error.message;
    }
  }

  function parseActualCurveCsv(raw) {
    const lines = String(raw || '').trim().split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('请粘贴包含表头和 24 行数据的实际曲线 CSV');
    const headers = lines[0].replace(/^\uFEFF/, '').split(',').map(item => item.trim());
    const required = ['hour', 'gridKw', 'baselineGridKw', 'price', 'chargeKw', 'dischargeKw', 'contractKwh', 'contractPrice'];
    const positions = required.map(name => headers.indexOf(name));
    if (positions.some(index => index < 0)) throw new Error('CSV 表头必须包含：' + required.join(', '));
    const records = lines.slice(1).map((line, rowIndex) => {
      const values = line.split(',').map(item => item.trim());
      const record = {};
      required.forEach((name, index) => {
        const value = Number(values[positions[index]]);
        if (!Number.isFinite(value)) throw new Error('第 ' + (rowIndex + 2) + ' 行的 ' + name + ' 不是有效数字');
        record[name] = value;
      });
      return record;
    });
    if (records.length !== 24) throw new Error('实际曲线必须严格包含 24 行（hour 0 至 23）');
    return records;
  }

  function fillCurveTemplate() {
    const input = $('#actual-curve-csv');
    if (!input) return;
    if (input.value.trim() && !window.confirm('已有曲线内容，是否用空白模板替换？')) return;
    input.value = ['hour,gridKw,baselineGridKw,price,chargeKw,dischargeKw,contractKwh,contractPrice']
      .concat(Array.from({ length: 24 }, (_, hour) => hour + ',,,,,,,')).join('\n');
    input.focus();
  }

  async function verifySaving() {
    const resultNode = $('#verification-result');
    const showResult = (message, kind) => { if (resultNode) { resultNode.textContent = message; resultNode.className = 'verification-result ' + (kind || ''); } };
    const planId = Number($('#verify-plan-select') && $('#verify-plan-select').value);
    const billId = Number($('#verify-bill-select') && $('#verify-bill-select').value);
    const baselineEvidence = ($('#baseline-evidence') && $('#baseline-evidence').value.trim()) || '';
    const meterEvidence = ($('#meter-evidence') && $('#meter-evidence').value.trim()) || '';
    const excludedFactors = ($('#excluded-factors') && $('#excluded-factors').value.trim()) || '';
    const scopeConfirmed = !!($('#scope-confirmed') && $('#scope-confirmed').checked);
    if (!planId || !billId || !baselineEvidence || !meterEvidence || !excludedFactors || !scopeConfirmed) {
      showResult('请先选择方案和账单，填写三类依据并确认核验范围。', 'error');
      return;
    }
    let actualIntervals;
    try { actualIntervals = parseActualCurveCsv($('#actual-curve-csv') && $('#actual-curve-csv').value); }
    catch (error) { showResult(error.message, 'error'); return; }
    showResult('正在复算 24 小时曲线并核对正式账单…', '');
    try {
      const result = await request('/api/savings/verify', { method: 'POST', body: { planId, billId, scopeConfirmed: true, baselineEvidence, meterEvidence, excludedFactors, actualIntervals } });
      showResult('实际节省已核验：¥' + number(result.actualSaving).toFixed(2) + '，并写入审计记录。', 'ok');
      showSession('实际节省已核验 · 闭环完成', '');
      await hydrate();
    } catch (error) {
      showResult('核验未通过 · ' + error.message, 'error');
    }
  }

  function evidenceHtml(evidence) {
    if (!Array.isArray(evidence) || !evidence.length) return '';
    return '<div class="evidence-chips"><span class="ec-label">证据</span>' + evidence.slice(0, 6).map((item, index) =>
      '<span class="ev-chip" title="' + esc(item.field || '') + '">' + esc(item.id || ('E-' + (index + 1))) + ' · ' + esc(item.label || item.field || '业务字段') + '</span>'
    ).join('') + '</div>';
  }

  function appendAiMessage(role, text, evidence) {
    const stream = $('#chat-stream');
    if (!stream) return;
    if (liveState.firstAiMessage) { stream.innerHTML = ''; liveState.firstAiMessage = false; }
    const who = role === 'user' ? '你' : '源能 AI';
    const cls = role === 'user' ? 'msg-user' : 'msg-ai';
    const body = role === 'user' ? '<div class="bubble">' + esc(text) + '</div>' : '<div class="answer"><p>' + esc(text).replace(/\n/g, '<br>') + '</p>' + evidenceHtml(evidence) + '</div>';
    stream.insertAdjacentHTML('beforeend', '<div class="msg ' + cls + '"><div class="msg-meta"><strong>' + who + '</strong> · ' + new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) + '</div>' + body + '</div>');
    stream.scrollTop = stream.scrollHeight;
  }

  async function askLive(question) {
    const q = String(question || '').trim();
    if (!q) return;
    appendAiMessage('user', q);
    showSession('AI 正在读取当前方案和数据证据…', '');
    try {
      const result = await request('/api/ai/chat', { method: 'POST', body: {
        messages: [...liveState.aiHistory.slice(-6), { role: 'user', content: q }],
        conversationId: 'legacy-chat',
        context: { region: '全国', timeRange: '今日', metric: '负荷' },
        stream: false
      } });
      liveState.aiHistory.push({ role: 'user', content: q }, { role: 'assistant', content: result.answer || '' });
      const metrics = Array.isArray(result.metrics) && result.metrics.length
        ? '\n关键指标：' + result.metrics.slice(0, 4).map(item => (item.label || '指标') + ' ' + (item.value == null ? '暂无' : item.value) + (item.unit || '')).join('；')
        : '';
      const suggestions = Array.isArray(result.suggestions) && result.suggestions.length
        ? '\n辅助建议：' + result.suggestions.slice(0, 3).map(item => typeof item === 'string' ? item : (item.content || item.title || '请人工复核')).join('；')
        : '';
      appendAiMessage('assistant', (result.answer || '当前没有返回可解释内容。') + metrics + suggestions, result.sources || []);
      showSession(result.mode === 'model' ? 'AI 已回答 · 已读取导入数据' : '本地数据分析已回答 · 模型暂不可用', result.mode === 'model' ? '' : 'demo');
    } catch (error) {
      appendAiMessage('assistant', error.message || 'AI 服务暂时不可用，请稍后重试。');
      showSession('AI 请求失败 · 可继续查看本地计算结果', 'error');
    }
  }

  async function hydrate() {
    showSession('正在同步企业数据、方案和预警…', '');
    try {
      const results = await Promise.all([
        request('/api/auth/me'),
        request('/api/dashboard'),
        request('/api/alerts'),
        request('/api/devices').catch(() => ({ devices: [], counts: {} }))
      ]);
      applyUser(results[0].user);
      applyDashboard(results[1]);
      applyAlerts(results[2]);
      applyDevices(results[3]);
      hideAuth();
    } catch (error) {
      if (error.status !== 401) showSession(error.message || '后端暂时不可用', 'error');
      if (error.status === 401) showAuth(error.message);
    }
  }

  async function logout() {
    try { await request('/api/auth/logout', { method: 'POST', body: {} }); } catch (_) { /* the local session is still cleared below */ }
    localStorage.removeItem(TOKEN_KEY);
    liveState.user = null;
    showAuth('已退出当前企业空间。');
  }

  function handleAuthSubmit(event) {
    event.preventDefault();
    event.stopImmediatePropagation();
    const username = ($('#live-username') || {}).value || '';
    const password = ($('#live-password') || {}).value || '';
    const email = ($('#live-email') || {}).value || '';
    const captcha = ($('#live-captcha') || {}).value || '';
    const remember = $('#live-remember');
    const error = $('#live-auth-error');
    if (error) error.textContent = '';
    if (captcha.trim().toUpperCase() !== liveState.captcha) {
      if (error) error.textContent = '安全验证不正确，请重新输入。';
      refreshCaptcha();
      const captchaInput = $('#live-captcha');
      if (captchaInput) { captchaInput.value = ''; captchaInput.focus(); }
      return;
    }
    const card = $('.auth-wall-card');
    if (card) card.classList.add('is-auth-busy');
    const submit = $('#live-auth-submit');
    if (submit) { submit.disabled = true; submit.textContent = liveState.mode === 'register' ? '正在创建…' : '正在登录…'; }
    request('/api/auth/' + liveState.mode, { method: 'POST', body: { username: username.trim(), password: password, email: email.trim() } })
      .then(result => {
        localStorage.setItem(TOKEN_KEY, result.token);
        if (remember && remember.checked && username.trim()) localStorage.setItem(REMEMBER_KEY, username.trim());
        else localStorage.removeItem(REMEMBER_KEY);
        applyUser(result.user);
        return hydrate();
      })
      .catch(reason => { if (error) error.textContent = reason.message || '登录失败，请检查服务状态。'; refreshCaptcha(); })
      .finally(() => {
        if (card) card.classList.remove('is-auth-busy');
        if (submit) { submit.disabled = false; submit.textContent = liveState.mode === 'register' ? '创建并进入' : '登录'; }
      });
  }

  function handleForgotPassword(event) {
    event.preventDefault();
    const username = (($('#live-username') || {}).value || '').trim();
    const error = $('#live-auth-error');
    if (error) { error.classList.add('success'); error.textContent = username ? '已记录找回请求，请联系企业管理员重置密码。' : '请输入账号后再发起找回请求。'; }
    if (!username && $('#live-username')) $('#live-username').focus();
    window.setTimeout(() => { if (error) error.classList.remove('success'); }, 4200);
  }

  function importFile() {
    const input = document.createElement('input');
    input.type = 'file'; input.accept = '.csv,text/csv'; input.style.display = 'none';
    input.addEventListener('change', function () {
      const file = input.files && input.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function () {
        const csv = String(reader.result || '');
        const stamps = csv.split(/\r?\n/).slice(1).map(line => (line.split(',')[0] || '').trim()).filter(Boolean).slice(0, 16);
        const configuredInterval = ($('#import-interval') || {}).value || 'auto';
        const hasQuarterHour = stamps.some(stamp => /T\d{2}:(15|30|45)(:|$)/.test(stamp) || / \d{2}:(15|30|45)(:|$)/.test(stamp));
       const intervalMinutes = configuredInterval === 'auto' ? (hasQuarterHour ? 15 : 60) : Number(configuredInterval);
       const overwrite = window.confirm('是否覆盖已有相同时间的数据？\n选择“确定”可更新，选择“取消”遇到重复时间将拒绝本批次。');
        const metadata = {
          intervalMinutes: intervalMinutes,
          source: (($('#import-source') || {}).value || '前端文件导入').trim(),
          meter: (($('#import-meter') || {}).value || '').trim(),
          authorization: (($('#import-authorization') || {}).value || '企业已授权分析使用').trim(),
          timezone: (($('#import-timezone') || {}).value || 'Asia/Shanghai'),
          priceUnit: '元/MWh',
          loadUnit: 'kW',
          validFrom: (($('#import-valid-from') || {}).value || '').trim(),
          validTo: (($('#import-valid-to') || {}).value || '').trim()
        };
         request('/api/import', { method: 'POST', body: { filename: file.name, csv: csv, metadata: metadata, replaceExisting: overwrite } })
           .then(result => {
             if (result.status !== 'ACCEPTED') {
               const first = result.issues && result.issues[0] ? result.issues[0].message : '请检查 CSV 表头、时间和单位。';
               throw new Error('数据未导入：' + first);
             }
             showSession('数据已导入 · ' + number(result.rows) + ' 条记录，正在刷新分析', '');
             return hydrate();
           })
           .then(() => { if (window.YUANHENG && window.YUANHENG.go) window.YUANHENG.go('overview'); })
           .catch(error => showSession('导入失败 · ' + error.message, 'error'));
      };
      reader.readAsText(file, 'utf-8');
    }, { once: true });
    document.body.appendChild(input);
    input.click();
    window.setTimeout(() => input.remove(), 120000);
  }

  function downloadImportTemplate() {
    const rows = [
      'timestamp,price_yuan_mwh,load_kw,temperature_c,renewable_kw,contract_kwh,contract_price_yuan_mwh',
      '2026-11-06 00:00,286.50,420,8.2,0,0,0',
      '2026-11-06 01:00,274.80,398,8.0,0,0,0',
      '2026-11-06 02:00,268.20,382,7.9,0,0,0'
    ];
    const blob = new Blob(['\uFEFF' + rows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = '源能_企业分时用电导入模板.csv';
    document.body.appendChild(link);
    link.click();
    window.setTimeout(function () { link.remove(); URL.revokeObjectURL(link.href); }, 30000);
  }

  function loadDemo() {
    if (!localStorage.getItem(TOKEN_KEY)) {
      showAuth('请先登录或创建企业空间，再载入演示数据。');
      return;
    }
    if (!window.confirm('演示数据只适合体验流程，不代表真实企业结算。继续载入吗？')) return;
    request('/api/demo', { method: 'POST', body: {} })
      .then(result => { showSession(result.message || '演示数据已载入，正在重算', 'demo'); return hydrate(); })
      .catch(error => showSession('演示数据未载入 · ' + error.message, 'error'));
  }

  function mapAlertAction(action) {
    return ({ ack: 'ACKNOWLEDGE', dispatch: 'ASSIGN', close: 'RESOLVE', ignore: 'IGNORE' })[action] || action;
  }

  function handleAlertAction(button) {
    const id = String(button.dataset.id || '').replace(/^A-/, '');
    const action = mapAlertAction(button.dataset.alertAction);
    if (!/^\d+$/.test(id)) return;
    const note = window.prompt('请填写本次处置意见（必填）', action === 'ASSIGN' ? '已分派责任人，等待现场核实' : '已按当前规则完成处置');
    if (!note || !note.trim()) return;
    const assignedTo = action === 'ASSIGN' ? window.prompt('责任人或责任岗位', '能源负责人') : undefined;
    request('/api/alerts/action', { method: 'POST', body: { id: Number(id), action: action, note: note.trim(), assignedTo: assignedTo || '' } })
      .then(result => { applyAlerts(result); showSession('预警处置已写入审计记录', ''); })
      .catch(error => showSession('预警处置失败 · ' + error.message, 'error'));
  }

  function handleReview(action) {
    if (!liveState.selectedPlanId) { showSession('当前没有可审核的后端方案草案，请先完成计算并保存方案', 'error'); return; }
    const note = window.prompt('请填写审核意见（必填）', action === 'APPROVED' ? '约束、数据和费用口径已复核' : '请补充生产或设备约束后重新提交');
    if (!note || !note.trim()) return;
    request('/api/plans/review', { method: 'POST', body: { id: liveState.selectedPlanId, action: action, note: note.trim() } })
      .then(() => { showSession(action === 'APPROVED' ? '方案已批准，审计记录已写入' : '方案已驳回，当前版本保持只读', ''); return hydrate(); })
      .catch(error => showSession('审核失败 · ' + error.message, 'error'));
  }

  function downloadReport() {
    request('/api/report').then(report => {
      const blob = new Blob([JSON.stringify(report, null, 2)], { type: 'application/json;charset=utf-8' });
      const link = document.createElement('a');
    link.href = URL.createObjectURL(blob); link.download = '源能决策报告-' + new Date().toISOString().slice(0, 10) + '.json';
      document.body.appendChild(link); link.click(); link.remove(); URL.revokeObjectURL(link.href);
      showSession('决策报告已导出 · 含数据质量、方案、账单和审计信息', '');
    }).catch(error => showSession('报告导出失败 · ' + error.message, 'error'));
  }

  function bind() {
    const form = $('#live-auth-form');
    if (form) form.addEventListener('submit', handleAuthSubmit, true);
    const switcher = $('#live-auth-switch');
    if (switcher) switcher.addEventListener('click', () => setAuthMode(liveState.mode === 'login' ? 'register' : 'login'));
    const captcha = $('#live-captcha-code');
    if (captcha) captcha.addEventListener('click', refreshCaptcha);
    const forgot = $('#live-forgot');
    if (forgot) forgot.addEventListener('click', handleForgotPassword);
    document.addEventListener('submit', function (event) {
      if (event.target && event.target.id === 'chat-form') {
        event.preventDefault(); event.stopImmediatePropagation();
        const input = $('#chat-input'); if (input) { const question = input.value.trim(); input.value = ''; askLive(question); }
      }
    }, true);
    document.addEventListener('click', function (event) {
      const settings = event.target.closest && event.target.closest('[data-open-profile-settings]');
      if (settings) {
        event.preventDefault(); event.stopImmediatePropagation();
        const nav = $('.nav a[data-view="devices"]');
        if (nav) nav.click();
        window.setTimeout(function () {
          const details = $('#profile-settings');
          if (details) { details.open = true; details.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
        }, 80);
        return;
      }
      const loopTab = event.target.closest && event.target.closest('[data-loop-tab]');
      if (loopTab) {
        event.preventDefault(); event.stopImmediatePropagation();
        const nav = $('.nav a[data-view="' + loopTab.dataset.goto + '"]');
        const tab = $('.tab[data-tab="' + loopTab.dataset.loopTab + '"]');
        if (nav) nav.click();
        if (tab) tab.click();
        return;
      }
      const loopAction = event.target.closest && event.target.closest('[data-loop-action]');
      if (loopAction) { event.preventDefault(); event.stopImmediatePropagation(); if (loopAction.dataset.loopAction === 'save-plan') savePlanDraft(); return; }
      if (event.target.closest && event.target.closest('#confirm-bill-btn')) { event.preventDefault(); event.stopImmediatePropagation(); confirmBill(); return; }
      if (event.target.closest && event.target.closest('#execute-plan-btn')) { event.preventDefault(); event.stopImmediatePropagation(); executePlan(); return; }
      if (event.target.closest && event.target.closest('#btn-submit-plan')) { event.preventDefault(); event.stopImmediatePropagation(); submitPlan(); return; }
      if (event.target.closest && event.target.closest('#invite-member-btn')) { event.preventDefault(); event.stopImmediatePropagation(); inviteMember(); return; }
      if (event.target.closest && event.target.closest('#join-workspace-btn')) { event.preventDefault(); event.stopImmediatePropagation(); joinWorkspace(); return; }
      if (event.target.closest && event.target.closest('#curve-template-btn')) { event.preventDefault(); event.stopImmediatePropagation(); fillCurveTemplate(); return; }
      if (event.target.closest && event.target.closest('#verify-saving-btn')) { event.preventDefault(); event.stopImmediatePropagation(); verifySaving(); return; }
      if (event.target.closest && event.target.closest('#refresh-devices')) { event.preventDefault(); event.stopImmediatePropagation(); refreshDevices(); return; }
      if (event.target.closest && event.target.closest('#load-device-demo')) { event.preventDefault(); event.stopImmediatePropagation(); loadDeviceDemo(); return; }
      const deviceButton = event.target.closest && event.target.closest('[data-device-view]');
      if (deviceButton) {
        event.preventDefault(); event.stopImmediatePropagation();
        const select = $('#device-select');
        if (select) { select.value = deviceButton.dataset.deviceView; select.dispatchEvent(new Event('change')); }
        return;
      }
      const action = event.target.closest && event.target.closest('[data-alert-action]');
      if (action) { event.preventDefault(); event.stopImmediatePropagation(); handleAlertAction(action); return; }
      const suggest = event.target.closest && event.target.closest('#chat-suggest .suggest');
      if (suggest) { event.preventDefault(); event.stopImmediatePropagation(); askLive(suggest.textContent.trim()); return; }
      const review = event.target.closest && event.target.closest('#btn-approve, #btn-return, #btn-reject');
      if (review) { event.preventDefault(); event.stopImmediatePropagation(); handleReview(review.id === 'btn-approve' ? 'APPROVED' : 'REJECTED'); return; }
      if (event.target.closest && event.target.closest('#logout-btn')) { event.preventDefault(); event.stopImmediatePropagation(); logout(); return; }
      if (event.target.closest && event.target.closest('[data-open-import]')) { event.preventDefault(); event.stopImmediatePropagation(); importFile(); return; }
      if (event.target.closest && event.target.closest('[data-template-download]')) { event.preventDefault(); event.stopImmediatePropagation(); downloadImportTemplate(); return; }
      if (event.target.closest && event.target.closest('[data-load-demo]')) { event.preventDefault(); event.stopImmediatePropagation(); loadDemo(); return; }
      if (event.target.closest && event.target.closest('#import-btn')) { event.preventDefault(); event.stopImmediatePropagation(); importFile(); return; }
      if (event.target.closest && event.target.closest('#demo-btn')) { event.preventDefault(); event.stopImmediatePropagation(); loadDemo(); return; }
      if (event.target.closest && event.target.closest('#export-btn')) { event.preventDefault(); event.stopImmediatePropagation(); downloadReport(); }
    }, true);
    const deviceSelect = $('#device-select');
    if (deviceSelect) deviceSelect.addEventListener('change', () => loadDeviceTelemetry(deviceSelect.value));
    const deviceForm = $('#device-register-form');
    if (deviceForm) deviceForm.addEventListener('submit', saveDevice);
    const profileForm = $('#profile-form');
    if (profileForm) profileForm.addEventListener('submit', saveProfile);
  }

  async function boot() {
    bind();
    setAuthMode('login');
    const token = localStorage.getItem(TOKEN_KEY);
    if (!token) { showAuth(''); return; }
    try {
      const me = await request('/api/auth/me');
      applyUser(me.user);
      await hydrate();
    } catch (error) {
      localStorage.removeItem(TOKEN_KEY);
      showAuth(error.message || '请重新登录。');
    }
  }

  window.YUANHENG_LIVE = { request: request, stream: streamRequest, hydrate: hydrate, ask: askLive, showSession: showSession };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
