"""Chronological model selection and a separate, frozen-method holdout.

Every fold constructs features and preprocessing from its past only. Weather and
renewable observations are lagged; no target-day measurements enter a forecast.
"""
from __future__ import annotations

import copy
import json
import math
from datetime import date, timedelta
from functools import lru_cache

import numpy as np

PREVIOUS = '上一完整日'
MEAN = '近7完整日同小时均值'
RIDGE = '时序岭回归'
MULTI = '多源时序岭回归'
VERSION = 'chronological-ridge-v3'


def features(history, target_date, multi):
    last = history[-1][1]
    week_day = (date.fromisoformat(target_date) - timedelta(days=7)).isoformat()
    week = next((rs for d, rs in reversed(history) if d == week_day), last)
    lookback = history[-7:]
    dow = date.fromisoformat(target_date).weekday()
    names = ['前日同小时电价', '前日同小时负荷', '前周同小时电价', '前周同小时负荷',
             '近7完整日电价均值', '近7完整日负荷均值', '前日电价均值', '前日负荷均值',
             '小时正弦', '小时余弦', '二次小时正弦', '二次小时余弦', '周内正弦', '周内余弦', '周末']
    if multi:
        names += ['前日同小时气温', '前日同小时新能源', '前日气温缺失', '前日新能源缺失']
    output = []
    for h in range(24):
        row = [last[h]['price_yuan_mwh'], last[h]['load_kw'], week[h]['price_yuan_mwh'], week[h]['load_kw'],
               np.mean([rs[h]['price_yuan_mwh'] for _, rs in lookback]), np.mean([rs[h]['load_kw'] for _, rs in lookback]),
               np.mean([r['price_yuan_mwh'] for r in last]), np.mean([r['load_kw'] for r in last]),
               math.sin(h*math.pi/12), math.cos(h*math.pi/12), math.sin(h*math.pi/6), math.cos(h*math.pi/6),
               math.sin(dow*2*math.pi/7), math.cos(dow*2*math.pi/7), float(dow >= 5)]
        if multi:
            row += [last[h].get('temperature_c') if last[h].get('temperature_c') is not None else np.nan,
                    last[h].get('renewable_kw') if last[h].get('renewable_kw') is not None else np.nan,
                    float(last[h].get('temperature_c') is None), float(last[h].get('renewable_kw') is None)]
        output.append(row)
    return np.array(output, dtype=float), names


def predict(history, target_date, method):
    if method in (PREVIOUS, MEAN):
        days = history[-1:] if method == PREVIOUS else history[-7:]
        return np.array([[np.mean([rs[h][k] for _, rs in days]) for k in ('price_yuan_mwh', 'load_kw')]
                         for h in range(24)]), []
    multi = method == MULTI
    xs, ys = [], []
    # Fit at most 90 days. Samples require an actual previous calendar day.
    start = max(1, len(history) - 90)
    for idx in range(start, len(history)):
        if (date.fromisoformat(history[idx][0]) - date.fromisoformat(history[idx-1][0])).days != 1:
            continue
        x, names = features(history[max(0, idx-7):idx], history[idx][0], multi)
        xs.extend(x)
        ys.extend([[r['price_yuan_mwh'], r['load_kw']] for r in history[idx][1]])
    if len(xs) < 48:
        raise ValueError('连续训练小时不足48条')
    x, y = np.array(xs), np.array(ys)
    # All missing-value fills, scales and coefficients come from training rows.
    count = np.sum(np.isfinite(x), axis=0)
    fill = np.divide(np.nansum(x, axis=0), count, out=np.zeros(x.shape[1]), where=count > 0)
    x = np.where(np.isfinite(x), x, fill)
    mean, scale = x.mean(axis=0), x.std(axis=0)
    scale[scale < 1e-9] = 1
    x = (x - mean) / scale
    center = y.mean(axis=0)
    # Fixed regularization; holdout errors never tune alpha or select methods.
    weights = np.linalg.solve(x.T @ x + 10 * np.eye(x.shape[1]), x.T @ (y-center))
    target, names = features(history[-7:], target_date, multi)
    target = np.where(np.isfinite(target), target, fill)
    predicted = (target-mean)/scale @ weights + center
    predicted[:, 1] = np.maximum(0, predicted[:, 1])
    importance = [{'feature': name, 'priceWeight': round(float(abs(weights[i, 0])), 4),
                   'loadWeight': round(float(abs(weights[i, 1])), 4)} for i, name in enumerate(names)]
    importance.sort(key=lambda v: v['priceWeight'], reverse=True)
    return predicted, importance


def metric(folds, method):
    if not folds:
        return None
    price, load, high, details = [], [], [], []
    for day, predicted, actual in folds:
        ep, el = predicted[:, 0] - actual[:, 0], predicted[:, 1] - actual[:, 1]
        price.extend(ep.tolist()); load.extend(el.tolist())
        threshold = np.sort(actual[:, 0])[17]
        high.extend(ep[actual[:, 0] >= threshold].tolist())
        details.append({'date': day, 'priceMAE': round(float(np.mean(abs(ep))), 3),
                        'loadMAE': round(float(np.mean(abs(el))), 3)})
    return {'method': method, 'testHours': len(price), 'testDays': len(folds),
            'priceMAE': round(float(np.mean(np.abs(price))), 3),
            'priceRMSE': round(float(np.sqrt(np.mean(np.square(price)))), 3),
            'loadMAE': round(float(np.mean(np.abs(load))), 3),
            'highPriceMAE': round(float(np.mean(np.abs(high))), 3), 'daily': details}


def run(history):
    n = len(history)
    if not n:
        return {'slots': [], 'evaluation': [], 'holdoutEvaluation': []}
    enough = n >= 14
    holdout_days = min(7, max(3, math.ceil(n * .2))) if enough else 0
    holdout_start = n - holdout_days
    validation_days = min(7, max(3, math.ceil(holdout_start * .2))) if enough else max(0, n-3)
    validation_start = holdout_start - validation_days
    # Candidate availability is decided before seeing holdout-day values.
    initial = history[:validation_start]
    continuous = sum((date.fromisoformat(initial[i][0])-date.fromisoformat(initial[i-1][0])).days == 1
                     for i in range(1, len(initial)))
    methods = [PREVIOUS, MEAN]
    optional = {k: sum(r.get(k) is not None for _, rs in initial for r in rs)
                for k in ('temperature_c', 'renewable_kw')}
    if enough and continuous >= 2:
        methods.append(RIDGE)
        if any(value >= len(initial)*24*.5 for value in optional.values()):
            methods.append(MULTI)
    validation, test, stored = [], [], {}
    failures = []
    for method in methods:
        folds = []
        try:
            for idx in range(validation_start, n):
                if idx < 1:
                    continue
                prediction, _ = predict(history[:idx], history[idx][0], method)
                actual = np.array([[r['price_yuan_mwh'], r['load_kw']] for r in history[idx][1]])
                folds.append((history[idx][0], prediction, actual))
            val = [f for f in folds if f[0] < history[holdout_start][0]] if holdout_days else folds
            held = [f for f in folds if f[0] >= history[holdout_start][0]] if holdout_days else []
            stored[method] = {'validation': val, 'holdout': held}
            if val:
                validation.append(metric(val, method))
            if held:
                test.append(metric(held, method))
        except (ValueError, np.linalg.LinAlgError) as exc:
            failures.append({'method': method, 'reason': str(exc)})
    price_method = min(validation, key=lambda m: m['priceMAE'])['method'] if validation else MEAN
    load_method = min(validation, key=lambda m: m['loadMAE'])['method'] if validation else MEAN
    target_day = (date.fromisoformat(history[-1][0])+timedelta(days=1)).isoformat()
    price_prediction, price_importance = predict(history, target_day, price_method)
    load_prediction, load_importance = predict(history, target_day, load_method)
    price_errors = [abs(float(p[h, 0]-a[h, 0])) for _, p, a in stored.get(price_method, {}).get('validation', []) for h in range(24)]
    load_errors = [abs(float(p[h, 1]-a[h, 1])) for _, p, a in stored.get(load_method, {}).get('validation', []) for h in range(24)]
    price_q = float(np.quantile(price_errors, .9, method='higher')) if price_errors else None
    load_q = float(np.quantile(load_errors, .9, method='higher')) if load_errors else None
    slots = []
    for h in range(24):
        p, l = float(price_prediction[h, 0]), float(load_prediction[h, 1])
        last = history[-1][1][h]
        slots.append({'slot': f'{h:02}:00', 'predictedPrice': round(p, 4), 'predictedLoad': round(l, 4),
                      'priceLow': round(p-price_q, 4) if price_q is not None else None,
                      'priceHigh': round(p+price_q, 4) if price_q is not None else None,
                      'loadLow': round(max(0, l-load_q), 4) if load_q is not None else None,
                      'loadHigh': round(l+load_q, 4) if load_q is not None else None,
                      'durationHours': 1, 'contractKwh': last['contract_kwh'], 'contractPrice': last['contract_price_yuan_mwh']})
    # Holdout plots use the methods frozen on validation; rolling refits use only prior days.
    points = []
    pf = stored.get(price_method, {}).get('holdout', [])
    lf = stored.get(load_method, {}).get('holdout', [])
    for (day, pp, actual), (_, lp, _) in zip(pf, lf):
        for h in range(24):
            points.append({'timestamp': f'{day}T{h:02}:00', 'predictedPrice': round(float(pp[h,0]), 4),
                           'actualPrice': float(actual[h,0]), 'predictedLoad': round(float(lp[h,1]), 4),
                           'actualLoad': float(actual[h,1])})
    selected = next((m for m in test if m['method'] == price_method), None)
    baseline = next((m for m in test if m['method'] == MEAN), None)
    improvement = round((baseline['priceMAE']-selected['priceMAE'])/baseline['priceMAE']*100, 2) if baseline and baseline['priceMAE'] else None
    return {'slots': slots, 'model': price_method, 'loadModel': load_method, 'modelVersion': VERSION,
            'forecastDate': target_day, 'evaluation': validation, 'holdoutEvaluation': test, 'holdoutPoints': points,
            'validation': {'status': 'INDEPENDENT_HOLDOUT' if holdout_days else 'INSUFFICIENT_HISTORY',
                           'trainStart': history[0][0], 'initialTrainEnd': history[max(0, validation_start-1)][0],
                           'selectionStart': history[validation_start][0] if validation_days else None,
                           'selectionEnd': history[holdout_start-1][0] if validation_days else None,
                           'holdoutStart': history[holdout_start][0] if holdout_days else None,
                           'holdoutEnd': history[-1][0] if holdout_days else None,
                           'holdoutDays': holdout_days, 'improvementVsMeanPercent': improvement,
                           'protocol': '验证期分别选择电价/负荷方法；留出期锁定方法，逐日仅用此前数据重新拟合。固定岭惩罚10，不按留出误差调参。'},
            'uncertainty': {'priceAbsoluteErrorP90': round(price_q,4) if price_q is not None else None,
                            'loadAbsoluteErrorP90': round(load_q,4) if load_q is not None else None,
                            'note': '误差带为验证期绝对误差90%经验分位，非统计置信区间或收益保证。'},
            'features': {'availability': '仅使用预测日前已知的历史数据；气温/新能源采用前日同小时值，不读取目标日实测。',
                         'optionalTrainingCoverage': optional, 'priceImportance': price_importance, 'loadImportance': load_importance,
                         'importanceNote': '绝对标准化回归系数用于描述模型依赖，不代表因果关系。',
                         'calendarGapDays': sum((date.fromisoformat(history[i][0])-date.fromisoformat(history[i-1][0])).days > 1 for i in range(1,n)),
                         'gapNote': '回归训练跳过缺少前一日的样本；前周同日缺失时以前日同小时代理。基线按完整日样本取值。'},
            'candidateFailures': failures}


@lru_cache(maxsize=12)
def _cached(payload):
    return run(json.loads(payload))


def cached(history):
    # Value-based key includes every row and batch; changing data cannot reuse an old result.
    return copy.deepcopy(_cached(json.dumps(history, ensure_ascii=False, sort_keys=True)))
