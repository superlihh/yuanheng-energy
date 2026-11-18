(function () {
  'use strict';

  const N = 96;

  function interp(anchors, h) {
    for (let i = 0; i < anchors.length - 1; i++) {
      const a = anchors[i], b = anchors[i + 1];
      if (h >= a[0] && h <= b[0]) {
        const t = (h - a[0]) / (b[0] - a[0] || 1);
        const e = t * t * (3 - 2 * t);
        return a[1] + (b[1] - a[1]) * e;
      }
    }
    return anchors[anchors.length - 1][1];
  }

  const priceAnchors = [
    [0, 268], [1.5, 246], [3, 232], [4.5, 238], [6, 262], [7, 330],
    [8, 518], [8.75, 612], [9.5, 556], [10.5, 352], [11.5, 286],
    [12.5, 242], [13.5, 214], [14.5, 224], [15.5, 252], [16.5, 344],
    [17.5, 566], [18.5, 792], [19.25, 928], [20, 886], [20.75, 764],
    [21.5, 584], [22.5, 432], [24, 330]
  ];

  const loadAnchors = [
    [0, 59.2], [2, 57.4], [4, 55.6], [5.5, 54.8], [7, 57.2], [8.5, 60.2],
    [10, 61.6], [11.5, 60.6], [12.5, 61.9], [14, 63.1], [16, 61.8],
    [17.5, 61.4], [18.5, 63.2], [19.5, 64.6], [20.5, 63.9], [21.5, 61.6],
    [23, 59.5], [24, 59.2]
  ];

  const price = [];
  const load = [];
  for (let i = 0; i < N; i++) {
    const h = i / 4;
    const p = interp(priceAnchors, h) + Math.sin(i * 1.7) * 4.2 + Math.sin(i * 0.53 + 2.1) * 5.5;
    price.push(Math.round(p * 10) / 10);
    const l = interp(loadAnchors, h) + Math.sin(i * 0.83 + 0.6) * 0.32 + Math.sin(i * 2.1) * 0.12;
    load.push(Math.round(l * 10) / 10);
  }

  const actualPrice = price.map((p, i) => {
    const e = 0.075 * Math.sin(i * 0.47 + 1.2) + 0.055 * Math.cos(i * 1.11 + 0.4) +
      (i >= 70 && i <= 86 ? 0.045 * Math.sin(i * 0.63) : 0);
    return Math.max(60, Math.round(p * (1 + e) * 10) / 10);
  });
  const mape = actualPrice.reduce((s, v, i) => s + Math.abs(v - price[i]) / price[i], 0) / N * 100;
  const highErr = (function () {
    let s = 0, c = 0;
    for (let i = 72; i <= 84; i++) { s += Math.abs(actualPrice[i] - price[i]) / price[i]; c++; }
    return s / c * 100;
  })();
  const forecastStats = {
    mape: Math.round(mape * 10) / 10,
    highMape: Math.round(highErr * 10) / 10,
    loadMape: 3.1,
    samples: 90
  };

  const bessPower = new Array(N).fill(0);
  for (let i = 8; i < 12; i++) bessPower[i] = 3;
  for (let i = 48; i < 60; i++) bessPower[i] = 7;
  for (let i = 72; i < 80; i++) bessPower[i] = -7;

  const capacity = 40, eff = 0.94;
  const soc = [];
  let s = 0.30;
  for (let i = 0; i < N; i++) {
    const p = bessPower[i];
    const delta = p > 0 ? (p * 0.25 * eff) / capacity : (p * 0.25) / eff / capacity;
    s = Math.min(0.9, Math.max(0.2, s + delta));
    soc.push(Math.round(s * 1000) / 10);
  }
  soc[0] = 30.0;
  const socEnd = soc[N - 1];

  const netLoad = load.map((v, i) => Math.round((v + bessPower[i]) * 10) / 10);
  const gridLimit = 74;
  let netPeakIdx = 0;
  netLoad.forEach((v, i) => { if (v > netLoad[netPeakIdx]) netPeakIdx = i; });
  const netPeak = netLoad[netPeakIdx];
  const stressNet = Math.round((load[netPeakIdx] * 1.1 + bessPower[netPeakIdx]) * 10) / 10;
  const maxPrice = Math.max.apply(null, price);
  const maxIdx = price.indexOf(maxPrice);
  const minPrice = Math.min.apply(null, price);
  const minIdx = price.indexOf(minPrice);
  const avgPrice = Math.round(price.reduce((a, b) => a + b, 0) / N * 10) / 10;
  const peakLoad = Math.max.apply(null, load);
  const peakIdx = load.indexOf(peakLoad);
  const bessThroughput = bessPower.reduce((a, b) => a + (b > 0 ? b * 0.25 : 0), 0);

  function timeOf(i) {
    const h = Math.floor(i / 4), m = (i % 4) * 15;
    return String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
  }
  function rangeOf(i, span) {
    const end = i + (span || 1);
    const h = Math.floor(end / 4), m = (end % 4) * 15;
    const hh = h === 24 ? '24:00' : String(h).padStart(2, '0') + ':' + String(m).padStart(2, '0');
    return timeOf(i) + '–' + hh;
  }

  const schemes = [
    {
      id: 'S0', name: '原计划', short: '基准', cost: 486320, diff: 0,
      feasible: true, feasibleText: '基准',
      nature: '企业确认', natureTag: 'neutral',
      note: '原负荷 / 原工序 / 现有合同',
      comp: { energy: 412860, contract: 38400, bess: 5120, ops: 24600, other: 5340 },
      changes: ['无调整。作为反事实比较的基准执行安排。'],
      keeps: ['原工序时段与已有合同', '现有储能运行计划', '全部生产与安全约束'],
      risks: ['晚峰裸露 14.0 MWh 于高价时段', '未调用午间低价窗口'],
      tag: '基准'
    },
    {
      id: 'S1', name: '中长期合同优先', short: '合同', cost: 478900, diff: 7420,
      feasible: true, feasibleText: '可行',
      nature: '合同量未优化', natureTag: 'warn',
      note: '固定合同曲线 · 仅差额分析',
      comp: { energy: 403100, contract: 37200, bess: 5120, ops: 24600, other: 8880 },
      changes: ['按现有合同曲线提高交割电量覆盖', '减少晚峰现货暴露 3.4 MWh'],
      keeps: ['合同价格与交割时段保持不变', '生产工序与储能动作不变'],
      risks: ['交易资格与交割曲线未齐备，合同量优化不可用', '仅能完成合同差额分析'],
      tag: '合同量未优化'
    },
    {
      id: 'S2', name: '移峰方案', short: '移峰', cost: 477680, diff: 8640,
      feasible: true, feasibleText: '可行',
      nature: '模拟值', natureTag: 'info',
      note: '2# 轧机 · 连续 4h',
      comp: { energy: 401980, contract: 38400, bess: 5120, ops: 24600, other: 7580 },
      changes: ['2# 轧机由 18:30–22:30 移至 12:30–16:30', '晚峰购电减少 12.8 MWh'],
      keeps: ['生产任务、电量与交付期限', '班次、检修窗口与安全联锁', '储能动作保持原计划'],
      risks: ['若 16:30 前进度延误，需回退原窗口并触发预警'],
      tag: '可行'
    },
    {
      id: 'S3', name: '储能方案', short: '储能', cost: 480150, diff: 6170,
      feasible: true, feasibleText: '可行',
      nature: '参数待复核', natureTag: 'warn',
      note: '40 MWh / 10 MW · η 94%',
      comp: { energy: 405240, contract: 38400, bess: 9120, ops: 24600, other: 2790 },
      changes: ['午间充电 7 MW × 3h，晚峰放电 7 MW × 2h', '日循环 0.64 次，末端 SOC 49.2%'],
      keeps: ['工序时段与原负荷不变', 'SOC 20%–90% 与检修禁充窗口'],
      risks: ['效率参数为铭牌值，待 BMS 实测复核', '净收益已扣除寿命与运维成本'],
      tag: '可行'
    },
    {
      id: 'S4', name: '组合方案', short: '组合', cost: 467680, diff: 18640,
      feasible: true, feasibleText: '可行',
      nature: '独立求解', natureTag: 'lime',
      note: '合同 v4 + 移峰 + 储能',
      comp: { energy: 381240, contract: 42800, bess: 8940, ops: 24600, other: 10100 },
      changes: ['2# 轧机移至 12:30–16:30（3.2 MW × 4h）', '储能午间充电 7 MW、晚峰 18:00–20:00 放电 7 MW', '晚峰现货购电减少 26.8 MWh（移峰 12.8 + 储能 14.0）'],
      keeps: ['合同曲线 v4 的 860 MWh 与交割时段', '1# 烧结 / 3# 加热炉 / 4# 公辅连续运行', '班次、检修窗口、并网上限与日末 SOC 目标'],
      risks: ['固定动作下基础负荷 +10% 时 13:45 并网越限', '重新优化生成独立草案，不覆盖原批准版本'],
      tag: '推荐'
    }
  ];

  const sensitivity = {
    fixed: {
      desc: '保持已生成的工序、合同与储能动作不变，只替换价格或负荷，回答“预测错了会怎样”。',
      rows: [
        { id: 'S2', name: '移峰方案', base: 8640, cells: [
          { v: 8210, ok: true }, { v: 9070, ok: true }, { v: 7920, ok: false }, { v: 8510, ok: true }
        ]},
        { id: 'S3', name: '储能方案', base: 6170, cells: [
          { v: 5980, ok: true }, { v: 6360, ok: true }, { v: 5940, ok: false }, { v: 6230, ok: true }
        ]},
        { id: 'S4', name: '组合方案', base: 18640, cells: [
          { v: 18210, ok: true }, { v: 19070, ok: true }, { v: 15870, ok: false }, { v: 18930, ok: true }
        ]}
      ]
    },
    reopt: {
      desc: '按新的价格或负荷假设重新求解，回答“是否应当换方案”。结果生成独立草案，不覆盖原批准版本。',
      rows: [
        { id: 'S2', name: '移峰方案', base: 8640, cells: [
          { v: 8180, ok: true }, { v: 9100, ok: true }, { v: 9420, ok: true }, { v: 8480, ok: true }
        ]},
        { id: 'S3', name: '储能方案', base: 6170, cells: [
          { v: 5940, ok: true }, { v: 6410, ok: true }, { v: 6580, ok: true }, { v: 6050, ok: true }
        ]},
        { id: 'S4', name: '组合方案', base: 18640, cells: [
          { v: 17940, ok: true }, { v: 19320, ok: true }, { v: 14220, ok: true, draft: '新草案' }, { v: 18880, ok: true }
        ]}
      ]
    }
  };

  const actions = [
    { time: '12:00–15:00', title: '储能充电', meta: '7 MW · 21 MWh · 均价 ¥231', kind: 'charge' },
    { time: '12:30–16:30', title: '2# 轧机移峰', meta: '3.2 MW · 贡献 ¥6,180', kind: 'shift' },
    { time: '18:00–20:00', title: '储能放电', meta: '7 MW · 覆盖晚峰 14 MWh', kind: 'discharge' },
    { time: timeOf(netPeakIdx), title: '并网峰值收紧', meta: netPeak.toFixed(1) + ' / ' + gridLimit + ' MW · 余量 ' + (gridLimit - netPeak).toFixed(1) + ' MW', kind: 'warn' }
  ];

  const constraints = [
    { title: '2# 轧机连续运行 ≥ 4h', meta: '新窗口 12:30–16:30 · 4.0h' },
    { title: '交付窗口 ≤ 23:00', meta: '最晚完成 16:30' },
    { title: '班次 08:00–20:00', meta: '移峰窗口处于日班内' },
    { title: '并网功率 ≤ ' + gridLimit + ' MW', meta: '峰值 ' + netPeak.toFixed(1) + ' MW · 余量 ' + (gridLimit - netPeak).toFixed(1) + ' MW' },
    { title: 'SOC 20%–90%', meta: '区间 30%–86.4% · 末端 ' + socEnd.toFixed(1) + '%' },
    { title: '04:00–06:00 检修禁充', meta: '该时段储能功率为 0' }
  ];

  const batches = [
    { id: 'B-20260303-MKT-02', name: '山西现货日前市场价格', sub: '交易平台授权接口', gran: '96 × 15min', completeness: 99.8, fresh: '03-03 22:10', status: '已发布', statusKey: 'ok', fp: '8f3a…c21d', note: '用于价格预测与方案计算' },
    { id: 'B-20260303-MKT-03', name: '实时市场价格', sub: '交易平台 · 迟到补录', gran: '96 × 15min', completeness: 97.4, fresh: '03-04 03:10', status: '已发布', statusKey: 'ok', fp: '2c90…71ab', note: '24 条迟到数据已写入修订版本' },
    { id: 'B-20260303-LOAD-01', name: '企业分时计量', sub: 'MP-1400127 · 智能电表', gran: '96 × 15min', completeness: 99.2, fresh: '03-04 03:40', status: '已发布', statusKey: 'ok', fp: 'd41e…08f2', note: '2 段缺测已由备用计量补录' },
    { id: 'B-20260303-PROD-02', name: '生产计划与工序约束', sub: 'MES 导出 · 生产负责人确认', gran: '日 / 工序', completeness: 100, fresh: '03-03 17:20', status: '已确认', statusKey: 'ok', fp: 'a33b…5d1e', note: '硬约束 6 项 / 软约束 2 项' },
    { id: 'B-20260228-CTR-04', name: '中长期合同曲线 v4', sub: '合同台账 · 财务确认', gran: '日 / 96 时段', completeness: 100, fresh: '03-04 08:02', status: '已更新', statusKey: 'warn', fp: 'b71c…9a04', note: '触发 V-S4-002 输入指纹失效' },
    { id: 'B-20260215-BESS-01', name: '储能 BMS 参数', sub: '设备台账 · 铭牌值', gran: '静态', completeness: 92.4, fresh: '02-15 11:00', status: '待复核', statusKey: 'warn', fp: '77fa…3c60', note: '充放电效率待实测' },
    { id: 'B-20260201-BILL-02', name: '2026-02 正式账单', sub: '财务 PDF + 费用明细', gran: '账期', completeness: null, fresh: '03-03 15:00', status: '待核验', statusKey: 'danger', fp: '5e0d…c9aa', note: '1 项费用未录入，actualSaving 为空' },
    { id: 'B-20260303-DAY-CSV', name: '山西现货日级汇总 CSV', sub: '公开来源 · 14 条日记录', gran: '日级', completeness: 100, fresh: '03-03 09:12', status: '仅参考', statusKey: 'neutral', fp: '19c4…6bb1', note: '不得冒充小时价格或企业结算价' }
  ];

  const issues = [
    { mark: '✓', level: '', title: '重复时间戳 · 18 条', meta: '规则 R-04：保留首条，原值留档 · 已解决', status: '已解决' },
    { mark: '✓', level: '', title: '15 分钟缺测 · 03:15–03:30', meta: '备用计量补录 · 电量守恒校验通过 · 已解决', status: '已解决' },
    { mark: '✓', level: '', title: '单位冲突 · 元/kWh vs 元/MWh', meta: '统一为元/MWh，保留原值与换算规则 · 已解决', status: '已解决' },
    { mark: '!', level: 'warn', title: '来源冲突 · 日前价格两源差异 3.4%', meta: '采用交易平台授权源，另一源标记为参考 · 已记录', status: '已记录' },
    { mark: '×', level: 'open', title: '合同交割曲线最大电量缺失', meta: '影响 S1 合同量优化 · 显示“数据不足”，不阻断 S2–S4', status: '未关闭' }
  ];

  const billing = {
    period: '2026-02',
    point: 'MP-1400127',
    tolerance: '±0.5% 或 ±¥800',
    rows: [
      { item: '电能费（日前 + 实时）', recalc: 412860, bill: 413520, diff: -660, tol: '±¥800', status: '通过' },
      { item: '中长期合同差额', recalc: 38400, bill: 38400, diff: 0, tol: '±¥800', status: '通过' },
      { item: '输配电费', recalc: 86200, bill: 86200, diff: 0, tol: '±0.5%', status: '通过' },
      { item: '基本电费 / 需量电费', recalc: 24600, bill: 24600, diff: 0, tol: '±¥800', status: '通过' },
      { item: '政府性基金及附加', recalc: 9740, bill: 9780, diff: -40, tol: '±0.5%', status: '通过' },
      { item: '偏差考核', recalc: null, bill: null, diff: null, tol: '规则待补', status: '数据不足' },
      { item: '其他已确认费用', recalc: 5340, bill: null, diff: null, tol: '±¥800', status: '未核验' }
    ],
    recalcTotal: 577140,
    billTotal: 572500
  };

  const reviews = {
    current: 'V-S4-003',
    parent: 'V-S4-002',
    versions: [
      { id: 'V-S4-001', name: '组合方案初稿 · 价格 v2.3.7', status: '已归档', statusKey: 'neutral', who: '陈宏 · 能源负责人', time: '03-02 16:10', cost: 478240 },
      { id: 'V-S4-002', name: '组合方案 · 合同 v3', status: '已失效', statusKey: 'danger', who: '李杰男 · 审核负责人', time: '03-03 18:42', cost: 473120, note: '合同批次更新，输入指纹不匹配' },
      { id: 'V-S4-003', name: '组合方案 · 合同 v4 + 负荷 v2.4.0', status: '审核中', statusKey: 'warn', who: '陈宏 · 能源负责人', time: '03-04 09:20', cost: 467680 }
    ],
    diffs: [
      { field: '合同日电量', old: '820 MWh', now: '860 MWh' },
      { field: '储能末端 SOC 目标', old: '20%', now: '25%' },
      { field: '2# 轧机窗口', old: '13:00–17:00', now: '12:30–16:30' },
      { field: '价格预测版本', old: 'v2.3.9', now: 'v2.4.0' },
      { field: '负荷预测峰值', old: '63.9 MW', now: '64.8 MW' },
      { field: '模拟成本', old: '473,120 元', now: '467,680 元', delta: '−5,440' },
      { field: '输入指纹', old: '8f3a…c21d', now: 'b71c…9a04' }
    ],
    audit: [
      { time: '09:20', who: '陈宏 · 能源负责人', text: '提交 V-S4-003 审核', meta: '意见：合同 v4 已确认，请求批准' },
      { time: '09:18', who: '系统 · CALC-0304-0921', text: '重新计算完成', meta: '五方案与敏感性结果快照已冻结' },
      { time: '08:05', who: '系统', text: '输入批次变更', meta: 'B-20260228-CTR-04 v3 → v4 · V-S4-002 失效' },
      { time: '08:02', who: '王岚 · 财务负责人', text: '合同交割曲线更新', meta: '日电量 820 → 860 MWh' },
      { time: '03-03 18:42', who: '李杰男 · 审核负责人', text: '批准 V-S4-002', meta: '意见：约束校验通过，准予执行前复核' },
      { time: '03-03 17:58', who: '陈宏 · 能源负责人', text: '提交 V-S4-002', meta: '父版本 V-S4-001' }
    ]
  };

  const evidence = {
    'E-0231': {
      id: 'E-0231', name: '价格窗口 · 时段字段', short: '价格窗口',
      fields: [
        ['字段路径', 'market.day_ahead_price[49..66]'],
        ['取值', '246.0 – 336.0 元/MWh'],
        ['数据性质', '日前预测值（非结算价）'],
        ['来源批次', 'B-20260303-MKT-02'],
        ['预测版本', 'PRICE-GBT v2.4.0'],
        ['方案版本', 'V-S4-003'],
        ['采集 / 发布', '03-03 22:10 / 03-03 22:14']
      ]
    },
    'E-0188': {
      id: 'E-0188', name: '工序窗口 · 硬约束', short: '工序窗口',
      fields: [
        ['字段路径', 'process.2#_MILL.window'],
        ['原窗口', '18:30 – 22:30'],
        ['新窗口', '12:30 – 16:30'],
        ['工序参数', '3.2 MW · 连续运行 4h'],
        ['硬约束', 'C-03 连续时长 / C-05 交付窗 23:00 / C-07 班次'],
        ['参数版本', 'P-2026-021'],
        ['确认人', '生产负责人 · 赵宇（03-03 17:20）']
      ]
    },
    'E-0207': {
      id: 'E-0207', name: '负荷预测 · 模型版本', short: '负荷预测',
      fields: [
        ['字段路径', 'load.forecast[0..95]'],
        ['峰值', '64.6 MW @ 19:15'],
        ['模型', 'LOAD-BLEND v2.4.0'],
        ['回测 MAE', '3.1%（近 30 日）'],
        ['训练样本', '2025-12-01 – 2026-03-01 · 90 天'],
        ['数据批次', 'B-20260303-LOAD-01'],
        ['数据性质', '预测值']
      ]
    },
    'E-0244': {
      id: 'E-0244', name: '储能 SOC · 递推参数', short: '储能参数',
      fields: [
        ['字段路径', 'bess.soc[0..95]'],
        ['容量 / 功率', '40 MWh / 10 MW'],
        ['效率', '94%（铭牌值，待复核）'],
        ['SOC 区间', '30.0% – 86.4%'],
        ['末端 SOC', socEnd.toFixed(1) + '%'],
        ['充放电', '12:00–15:00 充 7 MW / 18:00–20:00 放 7 MW'],
        ['批次', 'B-20260215-BESS-01']
      ]
    },
    'E-0249': {
      id: 'E-0249', name: '成本明细 · 计算编号', short: '成本明细',
      fields: [
        ['计算编号', 'CALC-0304-0921'],
        ['基准成本 S0', '486,320 元'],
        ['候选成本 S4', '467,680 元'],
        ['模拟差额', '+18,640 元'],
        ['费用范围', '电能费 / 合同差额 / 储能 / 固定运维 / 其他'],
        ['方案版本', 'V-S4-003'],
        ['数据性质', '模拟值，非实际节省']
      ]
    },
    'E-0261': {
      id: 'E-0261', name: '压力情景 · 并网越限', short: '压力情景',
      fields: [
        ['情景编号', 'SC-LOAD+10'],
        ['扰动', '基础负荷 +10%，工序任务不变'],
        ['评估模式', '固定动作评估'],
        ['越限时段', '13:45 – 14:00'],
        ['并网功率', stressNet.toFixed(1) + ' MW / 上限 74 MW'],
        ['结论', 'S4 该情景不可执行'],
        ['生成方式', 'Python 情景计算 · JOB-2197']
      ]
    },
    'E-0272': {
      id: 'E-0272', name: '重新优化 · 草案', short: '重算草案',
      fields: [
        ['计算编号', 'JOB-2210 / CALC-0304-1012'],
        ['情景', 'SC-LOAD+10 · 重新优化'],
        ['新草案', 'V-S4-004（草稿）'],
        ['模拟差额', '+14,220 元'],
        ['新增动作', '13:45–14:30 充电功率降至 4.6 MW'],
        ['可行性', '可行 · 并网 72.9 / 74 MW'],
        ['说明', '不覆盖 V-S4-003，提交审核前保持草稿']
      ]
    }
  };

  const alerts = [
    {
      id: 'A-0304-01', level: '阻断', levelKey: 'block', type: '方案状态', status: '待处理',
      title: '已批准版本 V-S4-002 因合同数据更新失效',
      desc: '合同批次 B-20260228-CTR-04 由 v3 更新至 v4，交割曲线与输入指纹发生变化。已批准版本不得进入执行前复核，需重新计算或重新审核。',
      fields: [
        ['触发字段', 'input.fingerprint'],
        ['当前值', 'b71c…9a04'],
        ['阈值 / 期望', '与已批准版本一致（8f3a…c21d）'],
        ['来源批次', 'B-20260228-CTR-04 v4'],
        ['关联方案', 'V-S4-002（已失效）'],
        ['责任角色', '能源负责人 · 陈宏'],
        ['处理期限', '2026-03-04 12:00'],
        ['当前状态', '待处理']
      ],
      events: [
        ['08:05', '系统', '生成预警并冻结 V-S4-002 执行前复核'],
        ['08:20', '陈宏', '确认预警，发起重新计算'],
        ['09:20', '陈宏', '提交新版 V-S4-003（审核中）']
      ],
      link: 'V-S4-002'
    },
    {
      id: 'A-0304-02', level: '重要', levelKey: 'important', type: '负荷与生产', status: '处理中',
      title: '压力情景 SC-LOAD+10 于 13:45 并网越限',
      desc: '基础负荷 +10%、工序任务不变的固定动作评估中，13:45–14:00 并网功率 ' + stressNet.toFixed(1) + ' MW，超过上限 74 MW。S4 在该情景下标记为不可执行。',
      fields: [
        ['触发字段', 'grid.power[55..56]'],
        ['当前值', stressNet.toFixed(1) + ' MW'],
        ['阈值', '74 MW'],
        ['越限时段', '13:45 – 14:00'],
        ['来源批次', 'B-20260303-LOAD-01'],
        ['关联方案', 'S4 / SC-LOAD+10'],
        ['责任角色', '生产负责人 · 赵宇'],
        ['处理期限', '2026-03-04 16:00'],
        ['当前状态', '处理中']
      ],
      events: [
        ['13:40', '系统', '压力测试发现并网越限，生成重要预警'],
        ['14:05', '赵宇', '分派至能源组，评估重新优化'],
        ['14:30', '系统', '重新优化任务 JOB-2210 排队']
      ],
      link: 'SC-LOAD+10'
    },
    {
      id: 'A-0304-03', level: '重要', levelKey: 'important', type: '价格风险', status: '待确认',
      title: '晚峰价格预测误差带扩大至 ±38%',
      desc: '18:00–21:00 误差带由 ±25% 扩大至 ±38%，高价时段连续 3 小时出现。预测值不得当作结算价，敏感性结果须与基准同时展示。',
      fields: [
        ['触发字段', 'price.error_band[72..84]'],
        ['当前值', '±38%'],
        ['阈值', '±25%'],
        ['时段', '18:00 – 21:00'],
        ['来源批次', 'B-20260303-MKT-02'],
        ['关联方案', '预测版本 v2.4.0'],
        ['责任角色', '算法负责人 · 谢嘉豪'],
        ['处理期限', '2026-03-04 18:00'],
        ['当前状态', '待确认']
      ],
      events: [
        ['22:12', '系统', '误差带扩大触发价格风险预警'],
        ['07:50', '谢嘉豪', '待确认：复核晚峰特征输入']
      ],
      link: 'PRICE v2.4.0'
    },
    {
      id: 'A-0304-04', level: '一般', levelKey: 'general', type: '储能与安全', status: '待确认',
      title: '储能月度循环次数接近阈值 412 / 450',
      desc: '本月累计等效循环 412 次，接近企业设定阈值 450 次。继续按当前策略运行预计 3 天后触达，需评估寿命成本优先模式。',
      fields: [
        ['触发字段', 'bess.monthly_cycles'],
        ['当前值', '412 次'],
        ['阈值', '450 次'],
        ['统计周期', '2026-03-01 – 2026-03-31'],
        ['来源批次', 'B-20260215-BESS-01'],
        ['关联方案', 'S3 / S4'],
        ['责任角色', '设备负责人 · 王岚'],
        ['处理期限', '2026-03-06 18:00'],
        ['当前状态', '待确认']
      ],
      events: [
        ['06:00', '系统', '循环计数达到阈值 91%，生成一般预警'],
        ['09:10', '王岚', '待确认：等待 BMS 效率实测数据']
      ],
      link: 'BESS-01'
    },
    {
      id: 'A-0304-05', level: '一般', levelKey: 'general', type: '合同与费用', status: '待处理',
      title: '2026-02 正式账单未核验，actualSaving 保持为空',
      desc: '账期 2026-02 仍有偏差考核费用未录入、反事实基准未确认。系统只显示核算金额，不将模拟差额登记为实际节省。',
      fields: [
        ['触发字段', 'bill.verified'],
        ['当前值', 'false（1 项未录入）'],
        ['阈值', '全部费用项已确认'],
        ['账期', '2026-02'],
        ['来源批次', 'B-20260201-BILL-02'],
        ['关联方案', '账单核对 / 2026-02'],
        ['责任角色', '财务 · 周敏'],
        ['处理期限', '2026-03-08 17:00'],
        ['当前状态', '待处理']
      ],
      events: [
        ['11:20', '系统', '账单核验未完成，actualSaving 维持空值'],
        ['11:35', '周敏', '已分派：补录偏差考核费用']
      ],
      link: 'BILL 2026-02'
    },
    {
      id: 'A-0304-06', level: '提示', levelKey: 'hint', type: '数据质量', status: '已解决',
      title: '计量批次 2 段缺测已补录',
      desc: 'B-20260303-LOAD-01 在 03:15–03:30 存在 2 段缺测，已通过备用计量补录并通过电量守恒校验。批次完整率恢复至 99.2%。',
      fields: [
        ['触发字段', 'load.missing_slots'],
        ['当前值', '0（补录前 2）'],
        ['阈值', '0'],
        ['来源批次', 'B-20260303-LOAD-01'],
        ['关联方案', 'S2 / S4'],
        ['责任角色', '数据管理员 · 马凯'],
        ['处理期限', '—'],
        ['当前状态', '已解决']
      ],
      events: [
        ['03:18', '系统', '检测到 2 段缺测，阻断批次发布'],
        ['03:32', '马凯', '备用计量补录完成'],
        ['03:40', '系统', '电量守恒校验通过，批次发布']
      ],
      link: 'LOAD-01'
    },
    {
      id: 'A-0304-07', level: '提示', levelKey: 'hint', type: '方案状态', status: '已忽略',
      title: '预测模型 v2.4.0 已发布，可按周窗口重训',
      desc: '模型版本更新提示。当前方案已绑定 v2.4.0；按既定周窗口统一重训，本次不触发重新审核。忽略动作已记录原因。',
      fields: [
        ['触发字段', 'model.version'],
        ['当前值', 'v2.4.0'],
        ['阈值', '周更窗口'],
        ['来源批次', '模型注册表'],
        ['关联方案', '全部'],
        ['责任角色', '算法负责人 · 谢嘉豪'],
        ['处理期限', '03-07（周窗口）'],
        ['当前状态', '已忽略']
      ],
      events: [
        ['07:00', '系统', '检测到模型版本更新，生成提示'],
        ['07:20', '谢嘉豪', '忽略：按周窗口统一重训，原因已记录']
      ],
      link: 'MODEL v2.4.0'
    }
  ];

  const suggestions = [
    '为什么把 2# 轧机移到 12:30–16:30？',
    '价格依据是什么？',
    '若基础负荷增加 10% 会怎样？'
  ];

  const decision = {
    dims: [
      { key: 'cost', label: '成本', hint: '模拟差额' },
      { key: 'risk', label: '风险', hint: '价格 / 负荷 / 执行' },
      { key: 'prod', label: '生产影响', hint: '工序调整' },
      { key: 'asset', label: '设备影响', hint: '储能 / 寿命' },
      { key: 'data', label: '数据完整性', hint: '必需输入' }
    ],
    modes: [
      { key: 'cost', label: '成本优先', weights: { cost: .50, risk: .20, prod: .10, asset: .10, data: .10 }, desc: '以模拟成本为主，风险与生产影响作为约束项。' },
      { key: 'risk', label: '风险优先', weights: { cost: .10, risk: .50, prod: .15, asset: .15, data: .10 }, desc: '优先降低价格、负荷与执行风险，可接受较小的成本让步。' },
      { key: 'prod', label: '生产影响最小', weights: { cost: .15, risk: .15, prod: .50, asset: .10, data: .10 }, desc: '优先保持工序、班次与设备连续运行，减少现场调整。' },
      { key: 'asset', label: '储能寿命优先', weights: { cost: .15, risk: .15, prod: .10, asset: .50, data: .10 }, desc: '优先降低循环次数与寿命成本，避免设备边界风险。' }
    ],
    schemes: [
      { id: 'S0', scores: { cost: 0, risk: 48, prod: 96, asset: 92, data: 100 } },
      { id: 'S2', scores: { cost: 46, risk: 70, prod: 58, asset: 92, data: 94 } },
      { id: 'S3', scores: { cost: 33, risk: 60, prod: 96, asset: 56, data: 76 } },
      { id: 'S4', scores: { cost: 100, risk: 56, prod: 55, asset: 60, data: 86 } }
    ],
    excluded: { id: 'S1', name: '中长期合同优先', reason: '合同交割曲线最大电量缺失，合同量优化不可用' }
  };

  const longTerm = {
    months: ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'],
    coverage: [64, 63, 62, 66, 68, 69, 72, 71, 70, 68, 67, 67],
    budgets: [430, 398, 412, 405, 418, 455, 470, 468, 440, 425, 418, 432],
    peak: [62, 60, 63, 61, 64, 66, 68, 67, 65, 63, 61, 62],
    target: 70,
    corridor: [68, 72],
    annualBudget: 5171,
    annualCoverage: 67.3,
    spotExposure: 32.7,
    spotCap: 30,
    demandBoundary: 74,
    quarters: [
      { name: 'Q1', coverage: '63.0', spot: '37.0', budget: 1240, peak: 63, status: '需关注' },
      { name: 'Q2', coverage: '67.7', spot: '32.3', budget: 1278, peak: 66, status: '需关注' },
      { name: 'Q3', coverage: '71.0', spot: '29.0', budget: 1378, peak: 68, status: '达标' },
      { name: 'Q4', coverage: '67.3', spot: '32.7', budget: 1275, peak: 65, status: '需关注' }
    ],
    investments: [
      {
        kind: '合同', tag: '优先', tagKey: 'lime',
        title: '合同增签 +4.0 pp', value: '+4.0', unit: 'pp', metric: '年度合同覆盖率',
        cost: '+¥96 万 / 年', benefit: '现货敞口 32.7% → 28.7%',
        risk: '依赖交易资格、可用合同量与交割曲线确认'
      },
      {
        kind: '储能', tag: '评估中', tagKey: 'warn',
        title: '储能扩容 +20 MWh', value: '5.4', unit: '年', metric: '静态回收期',
        cost: '投资 ¥420 万', benefit: '年净收益 ¥78 万',
        risk: '循环寿命、效率实测与晚峰价差波动'
      },
      {
        kind: '需求侧', tag: '可执行', tagKey: 'info',
        title: '需量管理 −3 MW', value: '−3.0', unit: 'MW', metric: '最大需量下降',
        cost: '改造 ¥60 万', benefit: '年节省 ¥54 万',
        risk: '依赖生产排程弹性与设备最小开停时间'
      }
    ]
  };

  window.DATA = {
    N, price, actualPrice, forecastStats, load, netLoad, bessPower, soc, socEnd, bessThroughput,
    avgPrice, maxPrice, maxIdx, minPrice, minIdx, peakLoad, peakIdx, stressNet,
    gridLimit, netPeak, netPeakIdx,
    schemes, sensitivity, actions, constraints, batches, issues, billing,
    reviews, evidence, alerts, suggestions, longTerm, decision,
    meta: {
      planningDay: '2026-03-04',
      pilot: '晋阳新材料 · 一号厂区',
      point: 'MP-1400127',
      batch: 'B-20260303-MKT-02',
      model: 'v2.4.0',
      calc: 'CALC-0304-0921',
      timeOf, rangeOf
    }
  };
})();
