import csv
import json
import math
import random
from datetime import date, timedelta

START = date(2026, 10, 15)
DAYS = 21
random.seed(20261105)

SUNNY = [-95, -105, -112, -108, -88, -52, -12, 58, 108, 92, 8, -208, -246, -236, -152, 18, 92, 138, 168, 158, 108, 62, 18, -38]
CLOUDY = [-78, -88, -95, -92, -75, -46, -12, 48, 88, 74, 14, -28, -42, -34, -12, 26, 78, 118, 138, 128, 92, 55, 16, -28]
FRONT = [-68, -78, -86, -82, -64, -40, -12, 52, 92, 78, 32, 8, 4, 12, 10, 38, 88, 132, 158, 148, 104, 62, 22, -22]

KINDS = ["sunny", "sunny", "sunny", "sunny", "cloudy",
         "front", "front", "cloudy", "sunny", "sunny",
         "sunny", "sunny", "cloudy", "front", "front",
         "cloudy", "sunny", "sunny", "sunny", "cloudy", "sunny"]
COLD = set(range(17, 21))
STRONG_PV = {2, 3, 9, 10, 17}

BASE = [442, 442, 442, 442, 442, 442, 465, 505, 528, 528, 528, 528, 478, 520, 520, 520, 520, 528, 528, 565, 565, 508, 475, 455]
PROC = {8: 130, 9: 130, 10: 130, 13: 90, 14: 90, 15: 90, 16: 90, 17: 55, 18: 55}

rows = []
for i in range(DAYS):
    day = START + timedelta(days=i)
    kind = KINDS[i]
    is_cold = i in COLD
    is_weekend = day.weekday() >= 5
    shape = SUNNY if kind == "sunny" else CLOUDY if kind == "cloudy" else FRONT
    level = 205 + i * 0.5 if kind == "sunny" else 305 if kind == "cloudy" else 345
    if is_cold:
        level += 25
    if is_weekend:
        level -= 18
    temp_mean = 15.0 - 0.42 * i + {"sunny": 0.6, "cloudy": -0.6, "front": -2.5}[kind] + (0.4 if is_cold else 0)
    temp_amp = {"sunny": 6.5, "cloudy": 4.5, "front": 3.2}[kind]
    pv_peak = 14 if kind == "front" else 26 if kind == "cloudy" else 72 - 0.7 * i
    for h in range(24):
        price = level + shape[h]
        if i in STRONG_PV and h in (11, 12, 13):
            price -= 30
        price += random.uniform(-8, 8)
        load = BASE[h] + PROC.get(h, 0)
        if is_weekend:
            load += -38 if 7 <= h <= 21 else -15
        if is_cold:
            load += 12
        load += random.uniform(-12, 12)
        temp = temp_mean + temp_amp * math.sin(math.pi * (h - 8.5) / 12) + random.uniform(-0.7, 0.7)
        pv = max(0.0, pv_peak * math.sin(math.pi * (h - 6) / 12) + random.uniform(-2.5, 2.5)) if 6 <= h <= 18 else 0.0
        rows.append({
            "date": day, "hour": h,
            "price": round(price, 2), "load": round(load, 2),
            "temp": round(temp, 2), "pv": round(pv, 2),
            "contract_kwh": 300, "contract_price": 350,
        })

with open("企业分时数据_21天.csv", "w", newline="", encoding="utf-8") as f:
    w = csv.writer(f)
    w.writerow(["timestamp", "price_yuan_mwh", "load_kw", "temperature_c", "renewable_kw", "contract_kwh", "contract_price_yuan_mwh"])
    for r in rows:
        w.writerow([f"{r['date'].isoformat()}T{r['hour']:02d}:00", r["price"], r["load"], r["temp"], r["pv"], r["contract_kwh"], r["contract_price"]])

profile = {
    "name": "晋中示范制造企业（虚拟）", "industry": "制造业（虚拟数据）",
    "purchaseMethod": "虚拟售电代理", "meter": "VIRTUAL-METER-001", "settlementPoint": "虚拟计量点001",
    "ruleReference": "教学演示：固定合约+现货差额口径，不代替山西正式结算规则", "reviewer": "虚拟审核人",
    "ruleVerified": True, "dataAuthorized": True, "constraintsConfirmed": True,
    "gridLimitKw": 1000,
    "processName": "熔炼/粗加工", "processKw": 130, "duration": 3, "baselineStart": 8,
    "windowStart": 6, "windowEnd": 15, "forbiddenHours": "",
    "storageEnabled": True, "capacityKwh": 800, "storagePowerKw": 200,
    "socInitial": 50, "socMin": 10, "socMax": 90, "roundtripEfficiency": 92,
    "degradationYuanKwh": 0.08, "maintenanceYuanDay": 30,
    "storageParametersConfirmed": True, "storageMaxCycles": 2, "storageUnavailableHours": [],
    "settlementModel": "fixed_contract_difference",
}
with open("企业约束与储能参数.json", "w", encoding="utf-8") as f:
    json.dump(profile, f, ensure_ascii=False, indent=2)

tasks = [
    {"id": "t1", "name": "熔炼/粗加工", "line": "流水线A", "equipmentId": "EQ-A1", "orderNo": "ORD-20261104-01",
     "quantity": 120, "quantityUnit": "件", "powerKw": 130, "duration": 3, "baselineStart": 8,
     "windowStart": 6, "windowEnd": 15, "forbiddenHours": [], "predecessors": []},
    {"id": "t2", "name": "精加工", "line": "流水线A", "equipmentId": "EQ-A2", "orderNo": "ORD-20261104-01",
     "quantity": 120, "quantityUnit": "件", "powerKw": 90, "duration": 4, "baselineStart": 13,
     "windowStart": 10, "windowEnd": 20, "forbiddenHours": [], "predecessors": ["t1"]},
    {"id": "t3", "name": "包装与质检", "line": "流水线A", "equipmentId": "EQ-A3", "orderNo": "ORD-20261104-01",
     "quantity": 120, "quantityUnit": "件", "powerKw": 55, "duration": 2, "baselineStart": 17,
     "windowStart": 15, "windowEnd": 22, "forbiddenHours": [], "predecessors": ["t2"]},
]
with open("生产任务参数.json", "w", encoding="utf-8") as f:
    json.dump(tasks, f, ensure_ascii=False, indent=2)

last = [r for r in rows if r["date"] == START + timedelta(days=DAYS - 1)]
eta = math.sqrt(0.92)
charge_h = {13, 14}
discharge_h = {19, 20}
actual = []
energy = 800 * 0.5
for r in last:
    c = 150.0 if r["hour"] in charge_h else 0.0
    d = 138.0 if r["hour"] in discharge_h else 0.0
    grid = round(r["load"] + c - d, 2)
    if c:
        energy += c * eta
    if d:
        energy -= d / eta
    actual.append({
        "hour": r["hour"], "price": r["price"], "gridKw": grid,
        "baselineGridKw": r["load"], "chargeKw": c, "dischargeKw": d,
        "contractKwh": 300, "contractPrice": 350,
    })
bill = {
    "planDate": (START + timedelta(days=DAYS - 1)).isoformat(),
    "socStartKwh": 400.0, "socEndKwh": round(energy, 6),
    "executionEnergyKwh": round(sum(a["gridKw"] for a in actual), 4),
    "actualIntervals": actual,
}
with open("账单核对_24小时实际曲线_2026-11-04.json", "w", encoding="utf-8") as f:
    json.dump(bill, f, ensure_ascii=False, indent=2)

def daily_cost(items):
    grid_cost = sum(a["gridKw"] * a["price"] / 1000 for a in items)
    contract = sum(300 * (350 - a["price"]) / 1000 for a in items)
    wear = sum(a["dischargeKw"] for a in items) * 0.08
    return round(grid_cost + contract + wear + 30, 2)

print("rows:", len(rows))
print("negative price hours:", sum(1 for r in rows if r["price"] < 0))
print("price range:", min(r["price"] for r in rows), "-", max(r["price"] for r in rows))
print("load range:", min(r["load"] for r in rows), "-", max(r["load"] for r in rows))
print("temp range:", min(r["temp"] for r in rows), "-", max(r["temp"] for r in rows))
print("pv max:", max(r["pv"] for r in rows))
print("executionEnergyKwh:", bill["executionEnergyKwh"])
print("socEndKwh:", bill["socEndKwh"])
print("suggestedOfficialAmount:", daily_cost(actual))
