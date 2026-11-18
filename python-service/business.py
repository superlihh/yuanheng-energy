"""Enterprise workflow: source data -> forecast -> constrained plan -> review -> bill.

Hourly inputs use Asia/Shanghai timestamps, kW, kWh and yuan/MWh. Forecasts and
contract scenarios are analytical references; official settlement remains external.
"""
from __future__ import annotations

import csv
import hashlib
import io
import json
import math
import os
import sqlite3
from collections import defaultdict
from datetime import date, datetime, timedelta, timezone
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DB_PATH = Path(os.environ.get("POWER_DB_PATH", ROOT / "data" / "power_optimizer.db"))
CHINA = timezone(timedelta(hours=8))


class Problem(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


class ClosingConnection(sqlite3.Connection):
    def __exit__(self, *args):
        try:
            return super().__exit__(*args)
        finally:
            self.close()


def connect():
    conn = sqlite3.connect(DB_PATH, timeout=15, factory=ClosingConnection)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys=ON")
    return conn


def now():
    return datetime.now(CHINA).isoformat(timespec="seconds")


def audit(conn, uid, kind, entity, detail):
    import governance
    identity = governance.actor(uid)
    detail = {**detail, 'actorId': identity['id'], 'role': identity['workspaceRole']}
    conn.execute("INSERT INTO enterprise_event(user_id,event_type,entity_id,detail,created_at) VALUES(?,?,?,?,?)",
                 (uid, kind, str(entity), json.dumps(detail, ensure_ascii=False), now()))


def number(value, label, low=0, high=1e9):
    if isinstance(value, bool):
        raise Problem(f"{label}必须是数值")
    try:
        v = float(value)
    except (TypeError, ValueError):
        raise Problem(f"{label}必须是数值")
    if not math.isfinite(v) or not low <= v <= high:
        raise Problem(f"{label}应在 {low} 到 {high} 之间")
    return v


def integer(value, label, low, high):
    v = number(value, label, low, high)
    if v != int(v):
        raise Problem(f"{label}必须是整数")
    return int(v)


def text(value, limit=500):
    if not isinstance(value, str) or len(value) > limit:
        raise Problem(f"文本应不超过 {limit} 个字符")
    return value.strip()


DEFAULT_PROFILE = {
    "name": "", "industry": "", "purchaseMethod": "待确认", "meter": "",
    "settlementPoint": "", "ruleReference": "", "ruleVerified": False,
    "dataAuthorized": False, "constraintsConfirmed": False, "reviewer": "",
    "processName": "可调工序", "processKw": 0, "duration": 2,
    "baselineStart": 16, "windowStart": 0, "windowEnd": 24, "forbiddenHours": "",
    "gridLimitKw": 2000, "storageEnabled": False, "capacityKwh": 500,
    "storagePowerKw": 150, "socInitial": 50, "socMin": 10, "socMax": 90,
    "roundtripEfficiency": 92, "degradationYuanKwh": 0.08,
    "maintenanceYuanDay": 0, "settlementModel": "spot_only",
    "storageParametersConfirmed": False, "storageMaxCycles": 2, "storageUnavailableHours": [], "tasks": [],
}


def profile(uid):
    with connect() as conn:
        row = conn.execute("SELECT * FROM enterprise_profile WHERE user_id=?", (uid,)).fetchone()
    return {"values": {**DEFAULT_PROFILE, **(json.loads(row["payload"]) if row else {})},
            "revision": row["revision"] if row else 0, "updatedAt": row["updated_at"] if row else None}


def save_profile(uid, data):
    p = {**DEFAULT_PROFILE}
    for k in ("name", "industry", "purchaseMethod", "meter", "settlementPoint", "ruleReference", "reviewer", "processName", "forbiddenHours"):
        p[k] = text(data.get(k, p[k]))
    for k in ("ruleVerified", "dataAuthorized", "constraintsConfirmed", "storageEnabled"):
        if not isinstance(data.get(k, False), bool):
            raise Problem(f"{k}必须为是或否")
        p[k] = data.get(k, False)
    for k in ("processKw", "gridLimitKw", "capacityKwh", "storagePowerKw", "degradationYuanKwh", "maintenanceYuanDay"):
        p[k] = number(data.get(k, p[k]), k)
    for k, low, high in (("duration", 1, 24), ("baselineStart", 0, 23), ("windowStart", 0, 23), ("windowEnd", 1, 24)):
        p[k] = integer(data.get(k, p[k]), k, low, high)
    for k in ("socInitial", "socMin", "socMax"):
        p[k] = number(data.get(k, p[k]), k, 0, 100)
    p["roundtripEfficiency"] = number(data.get("roundtripEfficiency", 92), "往返效率", 1, 100)
    if p["windowEnd"] <= p["windowStart"] or p["duration"] > p["windowEnd"] - p["windowStart"]:
        raise Problem("工序连续时长必须能放入允许时窗")
    if p["baselineStart"] + p["duration"] > 24:
        raise Problem("原计划工序不得跨越本规划日")
    if not p["socMin"] <= p["socInitial"] <= p["socMax"]:
        raise Problem("初始 SOC 必须位于上下限之间")
    if p["gridLimitKw"] <= 0:
        raise Problem("并网功率上限必须大于零")
    if p["storageEnabled"] and (p["capacityKwh"] <= 0 or p["storagePowerKw"] <= 0):
        raise Problem("启用储能时容量与功率必须大于零")
    try:
        forbidden = sorted({int(v.strip()) for v in p["forbiddenHours"].replace("，", ",").split(",") if v.strip()})
        if any(h < 0 or h > 23 for h in forbidden):
            raise ValueError()
    except ValueError:
        raise Problem("禁运行小时请用 0–23 的整数并用逗号分隔")
    p["forbiddenHours"] = ",".join(map(str, forbidden))
    if data.get("settlementModel", "spot_only") not in ("spot_only", "fixed_contract_difference"):
        raise Problem("无效的购电分析口径")
    p["settlementModel"] = data.get("settlementModel", "spot_only")
    import governance
    p.update(governance.validate_profile(data))
    with connect() as conn:
        conn.execute("""INSERT INTO enterprise_profile(user_id,payload,revision,updated_at) VALUES(?,?,1,?)
            ON CONFLICT(user_id) DO UPDATE SET payload=excluded.payload,revision=revision+1,updated_at=excluded.updated_at""",
                     (uid, json.dumps(p, ensure_ascii=False), now()))
        audit(conn, uid, "PROFILE_SAVED", uid, {"name": p["name"]})
    return profile(uid)


COLUMNS = ["timestamp", "price_yuan_mwh", "load_kw", "temperature_c", "renewable_kw", "contract_kwh", "contract_price_yuan_mwh"]


def import_csv(uid, payload, is_demo=False):
    raw = payload.get("csv", "")
    if not isinstance(raw, str) or not raw.strip() or len(raw.encode("utf-8")) > 1_800_000:
        raise Problem("请上传不超过 1.8 MB 的 UTF-8 CSV 文件")
    filename = text(payload.get("filename", "interval.csv"), 180)
    reader = csv.DictReader(io.StringIO(raw.lstrip("\ufeff")))
    if not reader.fieldnames or not set(COLUMNS[:3]).issubset(reader.fieldnames):
        raise Problem("CSV 缺少 timestamp、price_yuan_mwh、load_kw 列，请下载导入模板")
    rows, issues, seen = [], [], set()
    for n, r in enumerate(reader, 2):
        if n > 10002:
            raise Problem("单次最多导入 10000 个小时")
        try:
            stamp = datetime.fromisoformat(r["timestamp"].strip())
            if stamp.tzinfo is not None:
                stamp = stamp.astimezone(CHINA).replace(tzinfo=None)
            if stamp.minute or stamp.second or stamp.microsecond:
                raise Problem("目前仅支持整小时起点，15 分钟数据需先按电量守恒聚合")
            if stamp.date() > datetime.now(CHINA).date():
                raise Problem("历史数据不能晚于今天")
            key = stamp.isoformat(timespec="minutes")
            if key in seen:
                raise Problem("文件内存在重复小时")
            seen.add(key)
            row = [key, number(r["price_yuan_mwh"], "价格", -100000, 100000), number(r["load_kw"], "负荷", 0, 1e7)]
            for col in COLUMNS[3:]:
                value = r.get(col, "")
                row.append(None if value is None or not value.strip() else number(value, col, -100 if col == "temperature_c" else -100000 if col == "contract_price_yuan_mwh" else 0, 1e8))
            if (row[5] is None) != (row[6] is None):
                raise Problem("合约电量和合约价格必须同时填写")
            rows.append(row)
        except (Problem, ValueError, TypeError, KeyError) as exc:
            issues.append({"line": n, "message": str(exc)})
    if not rows and not issues:
        raise Problem("CSV 没有数据行")
    with connect() as conn:
        if payload.get("replaceExisting") is not True:
            existing = {r[0] for r in conn.execute("SELECT timestamp FROM enterprise_interval WHERE user_id=?", (uid,))}
            overlap = existing & seen
            if overlap:
                issues.append({"line": 0, "message": f"{len(overlap)} 个小时已存在；如需更新请勾选覆盖已有小时"})
        batch = conn.execute("""INSERT INTO import_batch(user_id,filename,digest,raw_csv,status,row_count,issues,is_demo,created_at)
            VALUES(?,?,?,?,?,?,?,?,?)""", (uid, filename, hashlib.sha256(raw.encode()).hexdigest(), raw,
            "REJECTED" if issues else "ACCEPTED", len(rows), json.dumps(issues[:100], ensure_ascii=False), int(is_demo), now())).lastrowid
        if not issues:
            conn.executemany("""INSERT INTO enterprise_interval(user_id,timestamp,price_yuan_mwh,load_kw,temperature_c,renewable_kw,contract_kwh,contract_price_yuan_mwh,batch_id)
              VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(user_id,timestamp) DO UPDATE SET
              price_yuan_mwh=excluded.price_yuan_mwh,load_kw=excluded.load_kw,temperature_c=excluded.temperature_c,
              renewable_kw=excluded.renewable_kw,contract_kwh=excluded.contract_kwh,contract_price_yuan_mwh=excluded.contract_price_yuan_mwh,batch_id=excluded.batch_id""",
                [(uid, *r, batch) for r in rows])
        audit(conn, uid, "IMPORT_REJECTED" if issues else "IMPORT_ACCEPTED", batch, {"filename": filename, "rows": len(rows), "issues": issues[:10], "demo": is_demo})
    return {"batchId": batch, "status": "REJECTED" if issues else "ACCEPTED", "rows": len(rows), "issues": issues[:100]}


def interval_rows(uid):
    with connect() as conn:
        return [dict(r) for r in conn.execute("""SELECT i.*,b.filename,b.is_demo FROM enterprise_interval i
          JOIN import_batch b ON b.id=i.batch_id WHERE i.user_id=? ORDER BY i.timestamp""", (uid,))]


def energy_summary(uid, limit_days=31, limit_months=12):
    """Aggregate imported hourly load into transparent daily/monthly accounting."""
    rows = interval_rows(uid)
    daily = defaultdict(lambda: {"energyKwh": 0.0, "costYuan": 0.0, "peakKw": 0.0, "loadTotal": 0.0,
                                 "hours": 0, "demoHours": 0, "sourceBatches": set()})
    monthly = defaultdict(lambda: {"energyKwh": 0.0, "costYuan": 0.0, "peakKw": 0.0, "loadTotal": 0.0,
                                   "hours": 0, "demoHours": 0, "sourceBatches": set()})
    for row in rows:
        stamp = str(row.get("timestamp") or "")
        if len(stamp) < 7:
            continue
        day_key = stamp[:10]
        month_key = stamp[:7]
        load_kw = float(row.get("load_kw") or 0)
        price = float(row.get("price_yuan_mwh") or 0)
        energy_kwh = load_kw  # imported rows are hourly samples
        cost_yuan = energy_kwh * price / 1000.0
        for target in (daily[day_key], monthly[month_key]):
            target["energyKwh"] += energy_kwh
            target["costYuan"] += cost_yuan
            target["peakKw"] = max(target["peakKw"], load_kw)
            target["loadTotal"] += load_kw
            target["hours"] += 1
            target["demoHours"] += 1 if row.get("is_demo") else 0
            if row.get("batch_id") is not None:
                target["sourceBatches"].add(int(row["batch_id"]))

    def finalize(key, value, label):
        hours = value["hours"]
        return {
            label: key,
            "energyKwh": round(value["energyKwh"], 2),
            "costYuan": round(value["costYuan"], 2),
            "peakKw": round(value["peakKw"], 2),
            "averageKw": round(value["loadTotal"] / hours, 2) if hours else 0,
            "hours": hours,
            "demo": bool(value["demoHours"]),
            "sourceBatches": sorted(value["sourceBatches"]),
        }

    daily_rows = [finalize(key, daily[key], "date") for key in sorted(daily)[-limit_days:]]
    monthly_rows = [finalize(key, monthly[key], "month") for key in sorted(monthly)[-limit_months:]]
    return {
        "daily": daily_rows,
        "monthly": monthly_rows,
        "latestDay": daily_rows[-1] if daily_rows else None,
        "latestMonth": monthly_rows[-1] if monthly_rows else None,
        "source": "enterprise_interval",
        "sourceLabel": "企业导入小时数据",
        "unit": "kWh / 元 / kW",
        "calculation": "小时电量 = 负荷(kW) × 1小时；分析费用 = 小时电量(kWh) × 价格(元/MWh) ÷ 1000",
        "formalSettlement": False,
        "updatedAt": now(),
        "rowCount": len(rows),
        "hasData": bool(rows),
    }


def datasets(uid, full=False):
    rows = interval_rows(uid)
    grouped = defaultdict(list)
    for row in rows:
        grouped[row["timestamp"][:10]].append(row)
    full_days = [d for d, rs in grouped.items() if len(rs) == 24]
    missing = [{"date": d, "missingHours": sorted(set(range(24)) - {int(r["timestamp"][11:13]) for r in rs})} for d, rs in grouped.items() if len(rs) != 24]
    with connect() as conn:
        batches = [dict(r) for r in conn.execute("SELECT id,filename,digest,status,row_count,issues,is_demo,created_at FROM import_batch WHERE user_id=? ORDER BY id DESC" + ("" if full else " LIMIT 12"), (uid,))]
    for b in batches:
        b["issues"] = json.loads(b["issues"])
        with connect() as conn:
            meta = conn.execute('SELECT payload FROM import_metadata WHERE batch_id=?', (b['id'],)).fetchone()
        b['metadata'] = json.loads(meta['payload']) if meta else {'source': '历史导入/合成演示', 'intervalMinutes': 60}
    return {"rows": len(rows), "completeDays": len(full_days), "dateStart": rows[0]["timestamp"] if rows else None,
            "dateEnd": rows[-1]["timestamp"] if rows else None, "missingDays": missing, "batches": batches,
            "demoRows": sum(r["is_demo"] for r in rows), "timezone": "Asia/Shanghai", "intervalMinutes": 60,
            "negativePrices": sum(r["price_yuan_mwh"] < 0 for r in rows),
            "optionalCoverage": {k: sum(r[k] is not None for r in rows) for k in COLUMNS[3:]}}


def complete_history(uid):
    grouped = defaultdict(list)
    for r in interval_rows(uid):
        grouped[r["timestamp"][:10]].append(r)
    return [(d, rs) for d, rs in sorted(grouped.items()) if len(rs) == 24]


def evaluate(history):
    results = []
    for method in ("上一完整日", "近7完整日同小时均值"):
        ep, el, high_ep = [], [], []
        for idx in range(3, len(history)):
            train = history[max(0, idx - (1 if method == "上一完整日" else 7)):idx]
            actual = history[idx][1]
            threshold = sorted(r["price_yuan_mwh"] for r in actual)[17]
            for h in range(24):
                p = sum(day[1][h]["price_yuan_mwh"] for day in train) / len(train)
                l = sum(day[1][h]["load_kw"] for day in train) / len(train)
                ep.append(p - actual[h]["price_yuan_mwh"])
                el.append(l - actual[h]["load_kw"])
                if actual[h]["price_yuan_mwh"] >= threshold:
                    high_ep.append(ep[-1])
        if ep:
            results.append({"method": method, "testHours": len(ep), "priceMAE": round(sum(map(abs, ep)) / len(ep), 2),
                            "priceRMSE": round(math.sqrt(sum(e*e for e in ep)/len(ep)), 2),
                            "loadMAE": round(sum(map(abs, el))/len(el), 2),
                            "highPriceMAE": round(sum(map(abs, high_ep))/len(high_ep), 2)})
    return results


def legacy_forecast(uid):
    history = complete_history(uid)
    if not history:
        return {"status": "DATA_REQUIRED", "slots": [], "model": "等待企业分时数据", "note": "请导入至少一个完整日的小时价格和负荷；日级市场均价不能直接生成企业分时预测。", "evaluation": []}
    metrics = evaluate(history)
    method = min(metrics, key=lambda x: x["priceMAE"])["method"] if metrics else "近7完整日同小时均值"
    days = history[-1:] if method == "上一完整日" else history[-7:]
    slots = []
    for h in range(24):
        rs = [day[1][h] for day in days]
        p = sum(r["price_yuan_mwh"] for r in rs) / len(rs)
        l = sum(r["load_kw"] for r in rs) / len(rs)
        last = rs[-1]
        slots.append({"slot": f"{h:02}:00", "predictedPrice": round(p, 4), "predictedLoad": round(l, 4),
                      "durationHours": 1, "contractKwh": last["contract_kwh"], "contractPrice": last["contract_price_yuan_mwh"]})
    sorted_prices = sorted(s["predictedPrice"] for s in slots)
    for s in slots:
        s["band"] = "低价" if s["predictedPrice"] <= sorted_prices[5] else "高价" if s["predictedPrice"] >= sorted_prices[18] else "中间价"
    last_date = date.fromisoformat(history[-1][0])
    # Model selection also uses historical validation rows; include their source
    # provenance and demo flag, not just the final lookback window.
    demo = any(r["is_demo"] for day in history for r in day[1])
    return {"status": "DEMO" if demo else "REFERENCE", "model": method, "modelVersion": "hourly-baseline-v2",
            "forecastDate": (last_date + timedelta(days=1)).isoformat(), "trainedThrough": last_date.isoformat(),
            "staleDays": (datetime.now(CHINA).date() - last_date).days, "isDemo": demo,
            "note": "按历史截止日预测下一日；高低价为预测分组，不是政策峰谷时段。测试结果用于方法选择，尚无独立留出期验收。",
            "slots": slots, "evaluation": metrics,
            "trainingBatchIds": sorted({r["batch_id"] for day in days for r in day[1]}),
            "evidenceBatchIds": sorted({r["batch_id"] for day in history for r in day[1]})}


def forecast(uid):
    import decision
    return decision.forecast(uid)


def readiness(uid, p=None, fc=None):
    p = p or profile(uid)["values"]
    fc = fc or forecast(uid)
    checks = [
        ("企业与计量点", bool(p["name"] and p["meter"] and p["settlementPoint"])),
        ("数据使用已获授权", p["dataAuthorized"]),
        ("购电与规则口径已确认", p["ruleVerified"] and bool(p["ruleReference"]) and p["purchaseMethod"] != "待确认"),
        ("生产设备约束已确认", p["constraintsConfirmed"]),
        ("企业审核责任人", bool(p["reviewer"])),
        ("完整小时价格和负荷", bool(fc["slots"])),
        ("数据时间覆盖规划日", bool(fc["slots"]) and fc.get("staleDays", 100) <= 1),
    ]
    with connect() as conn:
        bill = conn.execute("SELECT count(*) FROM bill_reconciliation WHERE user_id=? AND status='CONFIRMED'", (uid,)).fetchone()[0]
    checks.append(("历史账单已完成复核", bool(bill)))
    return [{"label": k, "passed": bool(v)} for k, v in checks]


def legacy_calculate(uid):
    """24-hour MILP; fixed contract volume only changes settlement constants."""
    fc = forecast(uid)
    pr = profile(uid)
    p = pr["values"]
    result = {"status": "DATA_REQUIRED", "slots": [], "baselineCost": None, "optimizedCost": None,
              "saving": None, "savingRate": None, "forecast": fc, "profileRevision": pr["revision"],
              "profile": p, "readiness": readiness(uid, p, fc), "assumptions": [], "violations": []}
    if not fc["slots"]:
        result["message"] = fc["note"]
        return result
    try:
        import numpy as np
        from scipy.optimize import Bounds, LinearConstraint, milp
    except ImportError:
        raise Problem("优化求解器尚未安装，请运行 start.ps1 安装项目依赖", 503)
    slots = fc["slots"]
    prices = np.array([s["predictedPrice"] / 1000 for s in slots])
    baseline = np.array([s["predictedLoad"] for s in slots])
    kw, duration = p["processKw"], p["duration"]
    original = np.zeros(24)
    original[p["baselineStart"]:p["baselineStart"] + duration] = kw
    fixed = baseline - original
    forbidden = {int(h) for h in p["forbiddenHours"].split(",") if h}
    starts = [h for h in range(p["windowStart"], p["windowEnd"] - duration + 1)
              if not any(t in forbidden for t in range(h, h + duration))] if kw else [p["baselineStart"]]
    if min(fixed) < -1e-7 or not starts:
        result.update(status="INFEASIBLE", message="工序功率大于原时段总负荷，或允许时窗被禁运行小时全部占用", violations=["检查工序原计划、功率、连续时长与禁运行小时"])
        return result
    contract_constant = np.zeros(24)
    if p["settlementModel"] == "fixed_contract_difference":
        if any(s["contractKwh"] is None or s["contractPrice"] is None for s in slots):
            result.update(status="DATA_REQUIRED", message="合约差额分析需要每小时合约电量与价格；请补齐 CSV 合约列")
            return result
        contract_constant = np.array([s["contractKwh"] * (s["contractPrice"] - s["predictedPrice"]) / 1000 for s in slots])
    # c[24], d[24], stored energy[25], charge mode binary[24], process start binary[n].
    n = 97 + len(starts)
    objective = np.zeros(n)
    objective[:24] = prices
    objective[24:48] = -prices + p["degradationYuanKwh"]
    lower, upper, integral = np.zeros(n), np.full(n, np.inf), np.zeros(n)
    power = p["storagePowerKw"] if p["storageEnabled"] else 0
    capacity = p["capacityKwh"] if p["storageEnabled"] else 0
    eta = math.sqrt(p["roundtripEfficiency"] / 100)
    initial = capacity * p["socInitial"] / 100
    upper[:48] = power
    lower[48:73] = capacity * p["socMin"] / 100
    upper[48:73] = capacity * p["socMax"] / 100
    lower[48] = upper[48] = initial
    lower[72] = upper[72] = initial
    upper[73:] = 1
    integral[73:] = 1
    A, lo, hi = [], [], []
    def constraint(entries, low, high):
        row = np.zeros(n)
        for i, v in entries:
            row[i] += v
        A.append(row); lo.append(low); hi.append(high)
    constraint([(97 + j, 1) for j in range(len(starts))], 1, 1)
    for h in range(24):
        constraint([(48+h+1, 1), (48+h, -1), (h, -eta), (24+h, 1/eta)], 0, 0)
        constraint([(h, 1), (73+h, -power)], -np.inf, 0)
        constraint([(24+h, 1), (73+h, power)], -np.inf, power)
        process = [(97+j, kw) for j, start in enumerate(starts) if start <= h < start+duration]
        constraint([(h, 1), (24+h, -1)] + process, -fixed[h], p["gridLimitKw"] - fixed[h])
    for j, start in enumerate(starts):
        objective[97+j] = kw * sum(prices[start:start+duration])
    solved = milp(objective, integrality=integral, bounds=Bounds(lower, upper),
                  constraints=LinearConstraint(np.array(A), lo, hi), options={"time_limit": 15, "mip_rel_gap": 0.00001})
    if not solved.success or solved.x is None:
        result.update(status="INFEASIBLE" if solved.status == 2 else "SOLVER_LIMIT",
                      message="无法在当前并网上限、工序时窗和储能条件下生成可行计划" if solved.status == 2 else "求解未完成，请缩小范围或重试",
                      violations=["请检查固定负荷是否超过并网功率上限", "请核对工序允许时窗与储能功率/SOC边界"])
        return result
    x = solved.x
    chosen = starts[int(np.argmax(x[97:]))]
    process = np.array([kw if chosen <= h < chosen + duration else 0 for h in range(24)])
    charging, discharging = x[:24], x[24:48]
    grid = fixed + process + charging - discharging
    maintenance = p["maintenanceYuanDay"] if p["storageEnabled"] else 0
    baseline_cost = float(sum(baseline * prices + contract_constant) + maintenance)
    wear = discharging * p["degradationYuanKwh"]
    hourly_cost = grid * prices + contract_constant + wear
    total = float(sum(hourly_cost) + maintenance)
    checks = {
        "工序电量守恒": abs(float(sum(process - original))) < 1e-5,
        "无反向送电且满足并网功率": min(grid) >= -1e-5 and max(grid) <= p["gridLimitKw"] + 1e-5,
        "充放电互斥": bool(np.all(charging * discharging < 1e-5)),
        "日末储能恢复初始电量": abs(x[72] - initial) < 1e-5,
        "SOC与功率边界": bool(min(x[48:73]) >= capacity*p["socMin"]/100-1e-5 and max(x[48:73]) <= capacity*p["socMax"]/100+1e-5 and max(charging) <= power+1e-5 and max(discharging) <= power+1e-5),
    }
    checks = {key: bool(value) for key, value in checks.items()}
    if not all(checks.values()):
        result.update(status="INVALID", message="数值复核未通过，已拒绝输出调度方案", violations=[k for k,v in checks.items() if not v])
        return result
    result.update(status="FEASIBLE", planDate=fc["forecastDate"], isDemo=fc["isDemo"], solver="SciPy HiGHS MILP",
                  baselineCost=round(baseline_cost, 2), optimizedCost=round(total, 2), saving=round(baseline_cost-total, 2),
                  savingRate=round((baseline_cost-total)/baseline_cost*100, 2) if baseline_cost > 0 else None,
                  processStart=chosen if kw else None, checks=checks,
                  breakdown={"gridEnergyCost": round(float(sum(grid*prices)), 2), "contractDifference": round(float(sum(contract_constant)), 2),
                             "degradationCost": round(float(sum(wear)), 2), "maintenanceCost": maintenance,
                             "chargeKwh": round(float(sum(charging)), 4), "dischargeKwh": round(float(sum(discharging)), 4)},
                  assumptions=["每个时段为1小时：电量(kWh)=功率(kW)×1小时；电费=电量×元/MWh÷1000",
                               "工序负荷已包含在原计划负荷中，只移动工序，不减少产量；其他负荷保持原曲线",
                               "储能日末恢复初始SOC，计入往返效率、放电寿命折损和日运维费用",
                               "购电为分析场景：" + ("固定合约电量×合约价+(实际购电量-合约电量)×现货价" if p["settlementModel"] == "fixed_contract_difference" else "全电量按分时参考价测算"),
                               "不含未录入的输配电、需量、税费等正式账单项目；固定合约复制最近完整日曲线，不优化合约交易量",
                               "模拟成本差额需与执行计量及正式账单复核；日高低价分组不等于政策峰谷时段"])
    result["slots"] = [{**s, "baselineLoad": round(float(baseline[h]), 4), "adjustedLoad": round(float(grid[h]), 4),
                         "processKw": float(process[h]), "charge": round(float(charging[h]), 4), "discharge": round(float(discharging[h]), 4),
                         "soc": round(float(x[49+h]/capacity*100), 3) if capacity else None,
                         "contractDifference": round(float(contract_constant[h]), 4), "wearCost": round(float(wear[h]), 4),
                         "cost": round(float(hourly_cost[h]), 4)} for h,s in enumerate(slots)]
    return result


def calculate(uid):
    import decision
    return decision.calculate(uid)


def bills(uid, full=False):
    with connect() as conn:
        rows = [dict(r) for r in conn.execute("SELECT * FROM bill_reconciliation WHERE user_id=? ORDER BY id DESC" + ("" if full else " LIMIT 30"), (uid,))]
    for row in rows:
        row["items"] = json.loads(row["items"])
    return rows


def decimal_money(v, label, negative=False):
    number(v, label, -1e12 if negative else 0, 1e12)
    return Decimal(str(v)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def create_bill(uid, data):
    start, end = date.fromisoformat(data.get("periodStart", "")), date.fromisoformat(data.get("periodEnd", ""))
    if end < start or (end-start).days > 366:
        raise Problem("账期起止日期无效或超过一年")
    evidence = text(data.get("evidence", ""), 1000)
    if not evidence:
        raise Problem("请填写合同/账单编号、来源和计量单位作为核对依据")
    items = data.get("items")
    if not isinstance(items, list) or not 1 <= len(items) <= 40:
        raise Problem("请录入1至40个费用项目")
    output, calculated, official = [], Decimal(0), Decimal(0)
    for item in items:
        if not isinstance(item, dict):
            raise Problem("费用项目格式无效")
        name = text(item.get("name", ""), 100)
        if not name:
            raise Problem("费用项目名称不能为空")
        quantity = Decimal(str(number(item.get("quantity"), "计费数量", 0, 1e10)))
        rate = Decimal(str(number(item.get("unitPrice"), "单价", -1e8, 1e8)))
        expected = (quantity * rate).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
        actual = decimal_money(item.get("officialAmount"), "账单金额", True)
        calculated += expected; official += actual
        output.append({"name": name, "quantity": float(quantity), "unit": text(item.get("unit", "kWh"), 30),
                       "unitPrice": float(rate), "calculated": float(expected), "officialAmount": float(actual), "difference": float(expected-actual)})
    tolerance = decimal_money(data.get("tolerance", 1), "容差")
    diff = calculated-official
    with connect() as conn:
        bill_id = conn.execute("""INSERT INTO bill_reconciliation(user_id,period_start,period_end,evidence,items,calculated_total,official_total,difference,tolerance,status,created_at)
           VALUES(?,?,?,?,?,?,?,?,?,'PENDING',?)""", (uid, start.isoformat(), end.isoformat(), evidence, json.dumps(output, ensure_ascii=False),
              float(calculated), float(official), float(diff), float(tolerance), now())).lastrowid
        audit(conn, uid, "BILL_CALCULATED", bill_id, {"difference": float(diff)})
    return bills(uid)[0]


def confirm_bill(uid, data):
    bill_id = integer(data.get("id"), "账单ID", 1, 1e12)
    with connect() as conn:
        b = conn.execute("SELECT * FROM bill_reconciliation WHERE user_id=? AND id=?", (uid, bill_id)).fetchone()
        if not b:
            raise Problem("账单不存在", 404)
        if b["status"] != "PENDING":
            raise Problem("该账单已经复核", 409)
        items = json.loads(b["items"])
        if any(abs(i["difference"]) > b["tolerance"] + 1e-8 for i in items) or abs(b["difference"]) > b["tolerance"] + 1e-8:
            raise Problem("逐项差异或总差异超过容差，请修正依据后重新核算", 409)
        if data.get("confirmed") is not True:
            raise Problem("需要确认已核对合同、计量与正式账单")
        conn.execute("UPDATE bill_reconciliation SET status='CONFIRMED',confirmed_at=? WHERE id=?", (now(), bill_id))
        audit(conn, uid, "BILL_CONFIRMED", bill_id, {"officialTotal": b["official_total"], "confirmedBy": uid})
    return {"ok": True}


def plans(uid, full=False):
    with connect() as conn:
        rows = [dict(r) for r in conn.execute("SELECT * FROM business_plan WHERE user_id=? ORDER BY id DESC" + ("" if full else " LIMIT 30"), (uid,))]
    for r in rows:
        r["snapshot"] = json.loads(r["snapshot"])
        r["execution"] = json.loads(r["execution"]) if r["execution"] else None
    return rows


def save_plan(uid):
    snap = calculate(uid)
    if snap["status"] != "FEASIBLE":
        raise Problem(snap.get("message", "方案不可行，不能保存"), 409)
    with connect() as conn:
        pid = conn.execute("INSERT INTO business_plan(user_id,plan_date,snapshot,created_at) VALUES(?,?,?,?)",
                           (uid, snap["planDate"], json.dumps(snap, ensure_ascii=False), now())).lastrowid
        audit(conn, uid, "PLAN_DRAFTED", pid, {"simulatedSaving": snap["saving"], "isDemo": snap["isDemo"], "profileRevision": snap["profileRevision"]})
    return {"id": pid, "plan": snap}


def review_plan(uid, data):
    pid = integer(data.get("id"), "方案ID", 1, 1e12)
    action = data.get("action")
    if action not in ("APPROVED", "REJECTED"):
        raise Problem("审核动作无效")
    note = text(data.get("note", ""), 1000)
    if not note:
        raise Problem("请填写生产、设备和费用口径审核意见")
    current = profile(uid)
    checks = readiness(uid)
    with connect() as conn:
        row = conn.execute("SELECT * FROM business_plan WHERE id=? AND user_id=?", (pid, uid)).fetchone()
        if not row:
            raise Problem("方案不存在", 404)
        if row["status"] != "DRAFT":
            raise Problem("仅草案可审核，每个草案只能审核一次", 409)
        snap = json.loads(row["snapshot"])
        if action == "APPROVED":
            blockers = [c["label"] for c in checks if not c["passed"]]
            if current["revision"] != snap["profileRevision"]:
                blockers.append("企业参数已变化，请重新计算并保存方案")
            if forecast(uid).get("evidenceBatchIds") != snap["forecast"].get("evidenceBatchIds"):
                blockers.append("分时数据已更新，请重新生成方案")
            if blockers:
                raise Problem("审核未通过：" + "；".join(blockers), 409)
        changed = conn.execute("UPDATE business_plan SET status=?,review_note=?,reviewed_at=? WHERE id=? AND user_id=? AND status='DRAFT'",
                     (action, note, now(), pid, uid)).rowcount
        if not changed:
            raise Problem("方案状态已改变，请刷新", 409)
        audit(conn, uid, "PLAN_"+action, pid, {"note": note, "reviewer": current["values"]["reviewer"], "operatorId": uid})
    return {"ok": True}


def execute_plan(uid, data):
    pid = integer(data.get("id"), "方案ID", 1, 1e12)
    energy = number(data.get("actualKwh"), "实际用电量")
    note = text(data.get("note", ""), 1000)
    if not note:
        raise Problem("请填写实际执行情况与计量来源")
    execution = {"actualKwh": energy, "note": note, "recordedAt": now(), "operatorId": data.get('operatorId', uid), "actualSaving": None,
                 "explanation": "执行电量是人工登记值。节省尚未核验，需要同账期正式账单与经确认的反事实基准。"}
    with connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        row = conn.execute("SELECT snapshot,status,input_fingerprint FROM business_plan WHERE id=? AND user_id=?", (pid, uid)).fetchone()
        if not row:
            raise Problem("方案不存在", 404)
        if row["status"] != "APPROVED":
            raise Problem("只能登记已审核通过方案的执行结果", 409)
        import governance
        if row['input_fingerprint'] != governance.current_fingerprint(uid):
            raise Problem('执行前复核失败：输入版本已变化', 409)
        import telemetry
        if telemetry.guard_violations(uid):
            raise Problem('执行前复核失败：关键设备缺数、过期、故障或越限', 409)
        snap = json.loads(row["snapshot"])
        execution["expectedKwh"] = round(sum(s["adjustedLoad"] for s in snap["slots"]), 4)
        execution["energyDeviationKwh"] = round(energy - execution["expectedKwh"], 4)
        if conn.execute("UPDATE business_plan SET status='EXECUTED',execution=? WHERE id=? AND user_id=? AND status='APPROVED'",
                        (json.dumps(execution, ensure_ascii=False), pid, uid)).rowcount != 1:
            raise Problem("方案状态已改变，请刷新", 409)
        audit(conn, uid, "PLAN_EXECUTED", pid, execution)
    return {"ok": True}


def workflow(uid, plan=None):
    import governance
    p = profile(uid)
    fc = forecast(uid)
    return {"profile": p, "datasets": datasets(uid), "readiness": readiness(uid, p["values"], fc),
            "energySummary": energy_summary(uid),
            "plans": plans(uid), "bills": bills(uid), "alerts": governance.refresh_alerts(uid, plan), "team": governance.team(uid),
            "savings": governance.list_payloads(uid, 'saving_verification'),
            "boundary": "首期山西企业辅助决策；候选方案由企业人员审核执行，系统不连接交易申报或设备控制。"}


def events(uid, full=False):
    with connect() as conn:
        rows = [dict(r) for r in conn.execute("SELECT * FROM enterprise_event WHERE user_id=? ORDER BY id DESC" + ("" if full else " LIMIT 80"), (uid,))]
    for r in rows:
        r["detail"] = json.loads(r["detail"])
    return rows


def seed_demo(uid):
    if interval_rows(uid):
        raise Problem("当前空间已有分时数据。请在新注册的演示账号中加载样例，避免混合真实数据", 409)
    raw = io.StringIO()
    writer = csv.writer(raw)
    writer.writerow(COLUMNS)
    today = datetime.now(CHINA).date()
    for d in range(21):
        day = today-timedelta(days=21-d)
        for h in range(24):
            price = 340 + 145*math.sin((h-10)*math.pi/12) + 25*math.sin(d*0.8) + (18 if h in (17,18,19) else 0)
            load = 550 + 55*math.sin(h*math.pi/12) + 12*math.cos(d) + (100 if 16 <= h < 18 else 0)
            writer.writerow([f"{day.isoformat()}T{h:02}:00", round(price,2), round(load,2), round(18+6*math.sin(h*math.pi/12),2),
                             round(max(0, 70*math.sin((h-6)*math.pi/12)),2), 300, 350])
    saved = import_csv(uid, {"csv": raw.getvalue(), "filename": "演示_合成小时数据_非真实企业.csv"}, True)
    save_profile(uid, {**DEFAULT_PROFILE, "name": "演示工业企业", "industry": "制造业（合成样例）", "meter": "DEMO-001", "settlementPoint": "演示计量点",
                      "purchaseMethod": "演示售电代理", "ruleReference": "教学场景：固定合约+现货差额，仅用于模拟，不代表山西正式规则", "reviewer": "演示审核人",
                      "ruleVerified": True, "dataAuthorized": True, "constraintsConfirmed": True, "processKw": 100,
                      "storageEnabled": True, "storageParametersConfirmed": True, "storageMaxCycles": 2,
                      "storageUnavailableHours": [], "tasks": [], "settlementModel": "fixed_contract_difference"})
    bill = create_bill(uid, {"periodStart": today.isoformat(), "periodEnd": today.isoformat(), "evidence": "DEMO-BILL：合成账单，仅用于演示核对流程",
                            "items": [{"name": "演示购电费", "quantity": 10000, "unit": "kWh", "unitPrice": 0.4, "officialAmount": 4000}], "tolerance": 1})
    return {"import": saved, "billId": bill["id"], "message": "已载入21天合成数据和待复核演示账单，请在账单页面确认后体验审核流程。"}


def context(uid, plan_id=None):
    fc = forecast(uid)
    selected = None
    if plan_id is not None:
        pid = integer(plan_id, "方案ID", 1, 1e12)
        with connect() as conn:
            selected = conn.execute("SELECT * FROM business_plan WHERE id=? AND user_id=?", (pid, uid)).fetchone()
        if not selected:
            raise Problem("所选方案不存在", 404)
    plan = json.loads(selected["snapshot"]) if selected else calculate(uid)
    import governance
    plan = {k:v for k,v in plan.items() if k != 'scenarios'}
    fc = plan['forecast']
    rows = interval_rows(uid)
    recent = rows[-96:]
    import telemetry
    device_summary = telemetry.summary(uid)
    alert_summary = governance.alerts(uid)
    event_rows = events(uid)
    renewable_total = sum(float(row.get('renewable_kw') or 0) for row in recent)
    load_total = sum(float(row.get('load_kw') or 0) for row in recent)
    return {"enterprise": {"values": plan['profile'], "revision": plan['profileRevision']}, "forecast": fc, "optimization": plan,
            "planId": selected["id"] if selected else None, "planStatus": selected["status"] if selected else "PREVIEW",
            "billSummary": [{k:b[k] for k in ("id","period_start","period_end","official_total","difference","status")} for b in bills(uid)[:3]],
            "readiness": readiness(uid), "dataQuality": datasets(uid),
            "recentIntervals": recent,
            "devices": device_summary,
            "alerts": alert_summary,
            "events": event_rows[:30],
            "weather": {"status": "NOT_CONNECTED", "message": "当前企业空间尚未接入天气服务"},
            "energyIndicators": {"recentRenewableKw": round(renewable_total, 2), "recentLoadKw": round(load_total, 2),
                                 "renewableShare": round(renewable_total / load_total * 100, 2) if load_total else None},
            "fieldEvidence": governance.evidence(uid, selected['id'] if selected else None),
            "evidence": [{"label": "模型", "value": plan.get("forecast", fc).get("modelVersion", "等待数据")},
                         {"label": "来源批次", "value": str(plan.get("forecast", fc).get("evidenceBatchIds", []))},
                         {"label": "企业参数版本", "value": str(plan.get("profileRevision", 0))},
                         {"label": "方案", "value": f"#{selected['id']}" if selected else "当前预览"}]}


def energy_query(uid, payload):
    """Permission-scoped read model for the natural-language assistant."""
    payload = payload if isinstance(payload, dict) else {}
    metric = text(payload.get('metric', '负荷'), 60) or '负荷'
    region = text(payload.get('region', '全国'), 60) or '全国'
    time_range = text(payload.get('timeRange', '今日'), 60) or '今日'
    fc = forecast(uid)
    slots = fc.get('slots', []) if isinstance(fc, dict) else []
    if metric in ('价格', '电价'):
        series = [{'time': row.get('slot'), 'value': row.get('predictedPrice'), 'unit': '元/MWh'} for row in slots]
    elif metric in ('新能源', '清洁能源'):
        series = [{'time': row.get('slot'), 'value': row.get('renewableKw'), 'unit': 'kW'} for row in slots]
    else:
        series = [{'time': row.get('slot'), 'value': row.get('predictedLoad'), 'unit': 'kW'} for row in slots]
    import governance
    alert_data = governance.alerts(uid)
    rows = interval_rows(uid)
    return {
        'queryId': 'AQ-' + datetime.now(CHINA).strftime('%Y%m%d%H%M%S'),
        'scope': {'region': region, 'timeRange': time_range, 'metric': metric},
        'series': series,
        'alerts': alert_data,
        'dataQuality': datasets(uid),
        'energySummary': energy_summary(uid),
        'forecast': {'model': fc.get('modelVersion'), 'forecastDate': fc.get('forecastDate'), 'staleDays': fc.get('staleDays')},
        'source': {'rows': len(rows), 'updatedAt': now(), 'permission': '当前企业工作区'},
        'confidence': 0.86 if series else 0.32,
    }


def get_endpoint(path, uid, query):
    import governance
    result = governance.get_endpoint(uid, path, query)
    if result is not None: return result
    if path == "/api/workflow": return workflow(uid)
    if path == "/api/profile": return profile(uid)
    if path == "/api/datasets": return datasets(uid)
    if path == "/api/energy/summary": return energy_summary(uid)
    if path == "/api/forecast": return forecast(uid)
    if path == "/api/optimize": return calculate(uid)
    if path == "/api/plans": return {"plans": plans(uid)}
    if path == "/api/bills": return {"bills": bills(uid)}
    if path == "/api/events": return {"events": events(uid)}
    if path == "/api/report":
        with connect() as conn: governance.log(conn, uid, 'REPORT_EXPORTED', uid, {})
        import telemetry
        device_report = telemetry.summary(uid)
        for item in device_report.get("devices", []):
            # Reports may show operational evidence, but never credential material.
            item.pop("token_hash", None)
            item.pop("token_expires", None)
        return {"generatedAt": now(), "enterprise": profile(uid), "plans": plans(uid, True), "bills": bills(uid, True), "quality": datasets(uid, True),
                "devices": device_report,
                "alerts": governance.alerts(uid), "stressRuns": governance.list_payloads(uid, 'stress_run'),
                "savings": governance.list_payloads(uid, 'saving_verification'), "longTerm": governance.list_payloads(uid, 'long_term_plan'),
                "rules": governance.list_payloads(uid, 'settlement_rule'),
                "events": events(uid, True), "scope": "首期辅助决策，模拟差额与实际节省分别记录，实际节省尚需反事实基准和正式账单核验。"}
    if path == "/api/template":
        return {"filename": "企业分时数据模板.csv", "csv": ",".join(COLUMNS)+"\n"}
    if path == "/api/import-source":
        bid = integer(query.get("id", [0])[0], "导入批次", 1, 1e12)
        with connect() as conn:
            row = conn.execute("SELECT filename,raw_csv,digest FROM import_batch WHERE user_id=? AND id=?", (uid,bid)).fetchone()
        if not row: raise Problem("原始文件不存在",404)
        with connect() as conn:
            governance.log(conn, uid, 'SOURCE_EXPORTED', bid, {'filename': row['filename']})
            metadata = conn.execute('SELECT payload FROM import_metadata WHERE batch_id=?',(bid,)).fetchone()
        return {**dict(row), 'metadata': json.loads(metadata['payload']) if metadata else {}}
    raise Problem("接口不存在", 404)


def post_endpoint(path, uid, data):
    import governance
    result = governance.post_endpoint(uid, path, data)
    if result is not None: return result
    if path == "/api/profile": return save_profile(uid, data)
    if path == "/api/import": return import_csv(uid, data)
    if path == "/api/demo": return seed_demo(uid)
    if path == "/api/plans": return save_plan(uid)
    if path == "/api/plans/review": return review_plan(uid, data)
    if path == "/api/plans/execute": return execute_plan(uid, data)
    if path == "/api/bills": return create_bill(uid, data)
    if path == "/api/bills/confirm": return confirm_bill(uid, data)
    raise Problem("接口不存在", 404)
