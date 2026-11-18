"""Independent S0-S4 calculations. Money is calculated here, never by the LLM."""
from __future__ import annotations

import copy
import hashlib
import json
import math
from concurrent.futures import ThreadPoolExecutor
from datetime import date, datetime, timedelta

import business as b

VERSION = 'enterprise-milp-v4'
SOLVER = ThreadPoolExecutor(max_workers=1, thread_name_prefix='dispatch-solver')
UNPRICED = ['输配电费', '需量/基本电费', '政府性基金及税费', '未确认的正式结算调整']


def fingerprint(pr, fc):
    value = {'profile': pr, 'batchIds': fc.get('evidenceBatchIds', []),
             'deviceGuardConfig': fc.get('deviceGuardConfig', []),
             'forecastDate': fc.get('forecastDate'), 'model': fc.get('modelVersion'), 'dataRevision': fc.get('dataRevision'),
             'slots': fc.get('slots', []), 'costModel': VERSION}
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def forecast(uid):
    import forecasting
    import telemetry
    device_guards = telemetry.guard_config(uid)
    history = b.complete_history(uid)
    if not history:
        return {'status': 'DATA_REQUIRED', 'slots': [], 'model': '等待企业分时数据',
                'note': '至少导入一个完整小时日；公开日均价不能用于企业小时调度。',
                'evaluation': [], 'holdoutEvaluation': [], 'evidenceBatchIds': [], 'deviceGuardConfig': device_guards}
    result = forecasting.cached(history)
    with b.connect() as conn:
        revision = conn.execute("SELECT COALESCE(max(id),0) FROM import_batch WHERE user_id=? AND status='ACCEPTED'",(uid,)).fetchone()[0]
    values = sorted(s['predictedPrice'] for s in result['slots'])
    for h,s in enumerate(result['slots']):
        s['hour'] = h
        s['band'] = '低价' if s['predictedPrice'] <= values[5] else '高价' if s['predictedPrice'] >= values[18] else '中间价'
    latest = date.fromisoformat(history[-1][0])
    demo = any(r['is_demo'] for _, rs in history for r in rs)
    return {**result, 'deviceGuardConfig': device_guards, 'dataRevision': revision, 'status': 'DEMO' if demo else 'REFERENCE', 'isDemo': demo,
            'trainedThrough': latest.isoformat(), 'staleDays': (datetime.now(b.CHINA).date()-latest).days,
            'note': '按历史截止日预测下一日。满14日后分开方法选择期与独立测试期；高低价分组不等于政策峰谷。',
            'evidenceBatchIds': sorted({r['batch_id'] for _, rs in history for r in rs})}


def tasks(p):
    if p.get('tasks'):
        return p['tasks']
    if not p['processKw']:
        return []
    return [{'id': 'main', 'name': p['processName'], 'powerKw': p['processKw'], 'duration': p['duration'],
             'baselineStart': p['baselineStart'], 'windowStart': p['windowStart'], 'windowEnd': p['windowEnd'],
             'forbiddenHours': [int(h) for h in p['forbiddenHours'].split(',') if h], 'predecessors': []}]


def original_process(p):
    result = [0.0]*24
    for t in tasks(p):
        for h in range(t['baselineStart'], t['baselineStart']+t['duration']):
            result[h] += t['powerKw']
    return result


def task_violations(p, starts):
    errors = []
    for t in tasks(p):
        start = starts[t['id']]
        if start < t['windowStart'] or start+t['duration'] > t['windowEnd'] or any(h in t['forbiddenHours'] for h in range(start, start+t['duration'])):
            errors.append(t['name']+'不满足允许时窗/禁运行时段')
        for previous in t.get('predecessors', []):
            parent = next(x for x in tasks(p) if x['id'] == previous)
            if starts[previous]+parent['duration'] > start:
                errors.append(t['name']+'不满足前置工序 '+parent['name'])
    equipment={t.get('equipmentId') for t in tasks(p) if t.get('equipmentId')}
    for resource in equipment:
        for h in range(24):
            if sum(t.get('equipmentId')==resource and starts[t['id']]<=h<starts[t['id']]+t['duration'] for t in tasks(p))>1:
                errors.append(f'设备{resource}在{h:02d}:00被多个工序占用')
    return errors


def cost_slots(fc, p, grid, charge, discharge, starts, stored=None):
    """One hour duration; aggregation preserves 15-minute energy/cost upstream."""
    output = []
    for h, s in enumerate(fc['slots']):
        contract = 0.0
        if p['settlementModel'] == 'fixed_contract_difference':
            if s.get('contractKwh') is None or s.get('contractPrice') is None:
                raise b.Problem('缺少每小时合同电量或合同价格')
            contract = s['contractKwh']*(s['contractPrice']-s['predictedPrice'])/1000
        wear = discharge[h]*p['degradationYuanKwh']
        output.append({**s, 'baselineLoad': s['predictedLoad'], 'adjustedLoad': round(grid[h], 6),
                       'processKw': sum(t['powerKw'] for t in tasks(p) if starts[t['id']] <= h < starts[t['id']]+t['duration']),
                       'charge': round(charge[h], 6), 'discharge': round(discharge[h], 6),
                       'soc': round(stored[h+1]/p['capacityKwh']*100, 6) if stored is not None and p['storageEnabled'] else None,
                       'contractDifference': round(contract, 6), 'wearCost': round(wear, 6),
                       'cost': round(grid[h]*s['predictedPrice']/1000+contract+wear, 6)})
    maintenance = p['maintenanceYuanDay'] if p['storageEnabled'] else 0
    breakdown = {'gridEnergyCost': round(sum(grid[h]*s['predictedPrice']/1000 for h,s in enumerate(fc['slots'])), 2),
                 'contractDifference': round(sum(x['contractDifference'] for x in output), 2),
                 'degradationCost': round(sum(x['wearCost'] for x in output), 2), 'maintenanceCost': maintenance,
                 'chargeKwh': round(sum(charge), 4), 'dischargeKwh': round(sum(discharge), 4),
                 'storageLossKwh': round(sum(charge)-sum(discharge), 4), 'otherConfirmedCost': 0,
                 'unpricedItems': UNPRICED}
    return output, breakdown, round(sum(s['cost'] for s in output)+maintenance, 2)


def empty_result(fc, pr, code, label):
    return {'code': code, 'label': label, 'status': 'DATA_REQUIRED', 'slots': [], 'cost': None,
            'baselineCost': None, 'optimizedCost': None, 'saving': None, 'savingRate': None,
            'missingFields': [], 'violations': [], 'forecast': fc, 'profile': pr['values'],
            'profileRevision': pr['revision'], 'inputFingerprint': fingerprint(pr, fc),
            'costModelVersion': VERSION, 'planDate': fc.get('forecastDate'), 'isDemo': fc.get('isDemo', False),
            'assumptions': ['电量=kW×1小时，电费=kWh×元/MWh÷1000。',
                            '各方案使用同一预测、已有固定合同与费用范围；合同量未优化。',
                            '原计划储能为空闲且日末恢复初始SOC；已有日固定运维费计入所有场景。',
                            '未确认的输配电、需量、税费不计入本次模拟；模拟差额不是正式账单节省。']}


def solve(fc, pr, code='S4', price_shift=0, base_load_percent=0, time_limit=8):
    p = pr['values']
    label = {'S0': '原计划基准', 'S1': '固定合同分析', 'S2': '移峰方案', 'S3': '储能方案', 'S4': '联合组合'}[code]
    result = empty_result(fc, pr, code, label)
    if len(fc.get('slots', [])) != 24:
        result.update(message='价格与负荷完整小时日不足', missingFields=['24小时价格', '24小时企业负荷'])
        return result
    if p['settlementModel'] == 'fixed_contract_difference' and any(s.get('contractKwh') is None or s.get('contractPrice') is None for s in fc['slots']):
        result.update(message='当前费用口径需要完整合同曲线', missingFields=['contract_kwh', 'contract_price_yuan_mwh'])
        return result
    if code == 'S1':
        if any(s.get('contractKwh') is None or s.get('contractPrice') is None for s in fc['slots']):
            result.update(message='缺少合同曲线；不能将未知合同量作为0', missingFields=['contract_kwh', 'contract_price_yuan_mwh'])
            return result
        if p['settlementModel'] != 'fixed_contract_difference':
            result.update(status='NOT_APPLICABLE', message='请先确认固定合同差额分析口径；无法与不同费用口径直接比较')
            return result
    if code == 'S3' and not p['storageEnabled']:
        result.update(status='NOT_APPLICABLE', message='企业未启用可用储能')
        return result
    if code == 'S2' and not tasks(p):
        result.update(status='NOT_APPLICABLE', message='没有已配置的可调工序')
        return result
    if p['storageEnabled'] and code in ('S3', 'S4') and not p.get('storageParametersConfirmed', False):
        result.update(message='请确认真实储能参数；默认示例参数不能作为设备依据', missingFields=['storageParametersConfirmed'])
        return result
    import numpy as np
    from scipy.optimize import Bounds, LinearConstraint, milp
    source = copy.deepcopy(fc)
    original = original_process(p)
    fixed = np.array([s['predictedLoad']-original[h] for h,s in enumerate(source['slots'])])
    if min(fixed) < -1e-5:
        result.update(status='INFEASIBLE', message='原计划工序功率合计超过该时段总负荷', violations=['原负荷必须已包含各工序'])
        return result
    fixed *= 1+base_load_percent/100
    for h,s in enumerate(source['slots']):
        s['predictedLoad'] = float(fixed[h]+original[h])
        s['predictedPrice'] += price_shift
    result['forecast'] = source
    starts0 = {t['id']: t['baselineStart'] for t in tasks(p)}
    if code in ('S0', 'S1'):
        grid = fixed+np.array(original)
        violations = task_violations(p, starts0)
        if min(grid) < 0 or max(grid) > p['gridLimitKw']+1e-5:
            violations.append('原计划并网功率越限')
        if violations:
            result.update(status='INFEASIBLE', message='原计划本身未通过约束校验，基准金额不可靠', violations=violations)
            return result
        rows, breakdown, total = cost_slots(source, p, grid, [0]*24, [0]*24, starts0)
    else:
        # c24,d24,E25,z24, then binary start variables for each task.
        starts_by_task = {}
        for t in tasks(p):
            allowed = [h for h in range(t['windowStart'], t['windowEnd']-t['duration']+1)
                       if not set(range(h,h+t['duration'])) & set(t['forbiddenHours'])]
            starts_by_task[t['id']] = allowed if code in ('S2','S4') else [t['baselineStart']]
            if not starts_by_task[t['id']]:
                result.update(status='INFEASIBLE', message=t['name']+'没有满足时窗的开始时刻', violations=[t['name']])
                return result
        variables, offset = {}, 97
        for t in tasks(p):
            variables[t['id']] = [(offset+i,h) for i,h in enumerate(starts_by_task[t['id']])]
            offset += len(variables[t['id']])
        n = offset
        objective, lower, upper, integer = np.zeros(n), np.zeros(n), np.full(n,np.inf), np.zeros(n)
        active = p['storageEnabled'] and code in ('S3','S4')
        power, capacity = (p['storagePowerKw'],p['capacityKwh']) if active else (0,0)
        eta = math.sqrt(p['roundtripEfficiency']/100)
        initial = capacity*p['socInitial']/100
        upper[:48] = power
        lower[48:73],upper[48:73] = capacity*p['socMin']/100,capacity*p['socMax']/100
        lower[48] = upper[48] = lower[72] = upper[72] = initial
        upper[73:],integer[73:] = 1,1
        prices = np.array([s['predictedPrice']/1000 for s in source['slots']])
        objective[:24],objective[24:48] = prices,-prices+p['degradationYuanKwh']
        matrix,lo,hi = [],[],[]
        def constraint(items,low,high):
            row=np.zeros(n)
            for i,v in items: row[i]+=v
            matrix.append(row);lo.append(low);hi.append(high)
        for t in tasks(p):
            constraint([(i,1) for i,h in variables[t['id']]],1,1)
            for i,start in variables[t['id']]:
                objective[i] = t['powerKw']*sum(prices[start:start+t['duration']])
            for prev in t.get('predecessors',[]):
                parent=next(x for x in tasks(p) if x['id']==prev)
                constraint([(i,h) for i,h in variables[t['id']]]+[(i,-h) for i,h in variables[prev]],parent['duration'],np.inf)
        for h in range(24):
            constraint([(49+h,1),(48+h,-1),(h,-eta),(24+h,1/eta)],0,0)
            constraint([(h,1),(73+h,-power)],-np.inf,0)
            constraint([(24+h,1),(73+h,power)],-np.inf,power)
            processes=[(i,t['powerKw']) for t in tasks(p) for i,start in variables[t['id']] if start<=h<start+t['duration']]
            constraint([(h,1),(24+h,-1)]+processes,-fixed[h],p['gridLimitKw']-fixed[h])
            for equipment in {t.get('equipmentId') for t in tasks(p) if t.get('equipmentId')}:
                occupation=[(i,1) for t in tasks(p) if t.get('equipmentId')==equipment for i,start in variables[t['id']] if start<=h<start+t['duration']]
                constraint(occupation,0,1)
        if p.get('storageMaxCycles') is not None and capacity:
            constraint([(24+h,1/eta) for h in range(24)],0,capacity*p['storageMaxCycles'])
        for h in p.get('storageUnavailableHours',[]) if active else []:
            upper[h]=upper[24+h]=0
        solved=SOLVER.submit(milp,objective,integrality=integer,bounds=Bounds(lower,upper),
                    constraints=LinearConstraint(np.array(matrix),lo,hi),options={'time_limit':time_limit,'mip_rel_gap':1e-6}).result()
        if not solved.success or solved.x is None:
            result.update(status='INFEASIBLE' if solved.status==2 else 'SOLVER_LIMIT',
                          message='当前时窗、前置工序、并网功率或储能边界无可用解' if solved.status==2 else '求解未完成，不输出确定金额',
                          violations=['检查任务先后/禁运行时段', '检查并网限额和固定负荷', '检查储能功率与可用窗口'])
            return result
        x=solved.x
        starts0={t['id']:max(variables[t['id']],key=lambda pair:x[pair[0]])[1] for t in tasks(p)}
        process=np.array([sum(t['powerKw'] for t in tasks(p) if starts0[t['id']]<=h<starts0[t['id']]+t['duration']) for h in range(24)])
        grid=fixed+process+x[:24]-x[24:48]
        violations=task_violations(p,starts0)
        if min(grid)<-1e-4 or max(grid)>p['gridLimitKw']+1e-4 or max(x[:24]*x[24:48])>1e-4:
            violations.append('并网功率或充放电互斥数值校验失败')
        if violations:
            result.update(status='INVALID',message='求解结果数值复核失败',violations=violations)
            return result
        rows,breakdown,total=cost_slots(source,p,grid,x[:24],x[24:48],starts0,x[48:73] if active else None)
    result.update(status='FEASIBLE',message='合同量未优化，仅复算已确认的固定合同曲线' if code=='S1' else '已按当前约束独立计算',
                  cost=total,optimizedCost=total,slots=rows,breakdown=breakdown,taskStarts=starts0,
                  processStart=next(iter(starts0.values()),None),checks={'工序时窗及先后关系':True,'并网及储能约束':True},solver='SciPy HiGHS MILP')
    return result


def calculate(uid):
    fc,pr=forecast(uid),b.profile(uid)
    results=[solve(fc,pr,code) for code in ('S0','S1','S2','S3','S4')]
    baseline=results[0]['cost']
    for s in results:
        s['baselineCost']=baseline
        if baseline is not None and s['cost'] is not None:
            s['saving']=round(baseline-s['cost'],2)
            s['savingRate']=round(s['saving']/baseline*100,2) if baseline>0 else None
    combined=copy.deepcopy(results[-1])
    combined.update(scenarios=results,readiness=b.readiness(uid,pr['values'],fc))
    return combined


def stress(snapshot, data):
    price=b.number(data.get('priceDelta',0),'价格绝对扰动',-10000,10000)
    load=b.number(data.get('baseLoadPercent',0),'基础负荷扰动',-90,200)
    mode=data.get('mode','FIXED')
    if mode not in ('FIXED','REOPTIMIZE'): raise b.Problem('未知压力测试模式')
    fc=copy.deepcopy(snapshot['forecast']);p=snapshot['profile'];pr={'values':p,'revision':snapshot['profileRevision']}
    baseline=solve(fc,pr,'S0',price,load)
    if mode=='REOPTIMIZE':
        candidate=solve(fc,pr,snapshot.get('code','S4'),price,load)
    else:
        candidate=copy.deepcopy(snapshot);candidate.pop('scenarios',None)
        original=original_process(p)
        delta=[(s['predictedLoad']-original[h])*load/100 for h,s in enumerate(fc['slots'])]
        grid=[s['adjustedLoad']+delta[h] for h,s in enumerate(snapshot['slots'])]
        for h,s in enumerate(fc['slots']):
            s['predictedLoad']+=delta[h];s['predictedPrice']+=price
        violations=[f'{h:02d}:00 并网功率 {v:.2f} kW 超出0至{p["gridLimitKw"]}' for h,v in enumerate(grid) if v < -1e-4 or v > p['gridLimitKw']+1e-4]
        if violations:
            candidate.update(status='INFEASIBLE',cost=None,optimizedCost=None,saving=None,slots=[],violations=violations)
        else:
            rows,breakdown,total=cost_slots(fc,p,grid,[s['charge'] for s in snapshot['slots']],
                                          [s['discharge'] for s in snapshot['slots']],snapshot['taskStarts'])
            for h,s in enumerate(rows): s['soc']=snapshot['slots'][h]['soc']
            candidate.update(slots=rows,breakdown=breakdown,cost=total,optimizedCost=total,forecast=fc)
    candidate.update(baselineCost=baseline['cost'],saving=round(baseline['cost']-candidate['cost'],2) if baseline['cost'] is not None and candidate['cost'] is not None else None,
                     savingRate=None,calculationKind='STRESS_'+mode,stressAssumptions={'priceDelta':price,'baseLoadPercent':load})
    return {'mode':mode,'priceDelta':price,'baseLoadPercent':load,'baseline':baseline,'candidate':candidate,
            'note':'基础负荷按比例变化，工序任务保持；基准与候选采用相同扰动。压力子版本仅供评估；采纳前须将已确认条件录入正式输入，重新计算普通子版本并审核。'}
