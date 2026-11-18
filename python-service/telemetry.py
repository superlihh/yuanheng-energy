"""Read-only device observations, independent from forecasts and billing inputs.

The data-channel/device separation is informed by OpenEMS and Node-RED designs.
No code from these projects is copied, no fieldbus/control client runs here.
"""
from __future__ import annotations

import hashlib
import json
import math
import re
import secrets
from datetime import datetime, timedelta

import business as b

STATES = {'RUNNING', 'IDLE', 'FAULT', 'MAINTENANCE', 'OFFLINE'}
KINDS = {'METER', 'PLC', 'STORAGE'}
FIELDS = {'powerKw', 'energyKwh', 'soc', 'temperatureC', 'state'}


def device(uid, key, conn):
    row = conn.execute('SELECT * FROM device_registry WHERE owner_id=? AND device_id=?', (uid, key)).fetchone()
    if not row:
        raise b.Problem('设备不存在或无权访问', 404)
    result = dict(row)
    result['config'] = json.loads(result.pop('payload'))
    return result


def log(conn, uid, kind, key, detail, gateway=False):
    if gateway:
        detail = {**detail, 'actorId': None, 'role': 'DEVICE_GATEWAY', 'deviceId': key}
        conn.execute('INSERT INTO enterprise_event(user_id,event_type,entity_id,detail,created_at) VALUES(?,?,?,?,?)',
                     (uid, kind, key, json.dumps(detail, ensure_ascii=False), b.now()))
    else:
        b.audit(conn, uid, kind, key, detail)


def save_device(uid, data, demo=False):
    key = b.text(data.get('deviceId', ''), 60)
    if not re.fullmatch(r'[A-Za-z0-9_.:-]{1,60}', key):
        raise b.Problem('设备ID使用1至60位字母、数字、下划线、点、冒号或横线')
    name = b.text(data.get('name', ''), 100)
    kind = data.get('kind')
    if not name or not isinstance(kind,str) or kind not in KINDS:
        raise b.Problem('设备名称必填，类型须为电表、PLC状态或储能')
    config = {k: b.text(data.get(k, ''), 200) for k in ('line', 'equipmentId', 'source')}
    for key_name in ('enabled', 'enforce'):
        if not isinstance(data.get(key_name, key_name == 'enabled'), bool):
            raise b.Problem('设备启用和执行前检查须为布尔值')
        config[key_name] = data.get(key_name, key_name == 'enabled')
    for key_name, default, low, high in [('staleSeconds', 300, 30, 86400), ('ratedPowerKw', 200, .001, 1e7),
                                        ('socMin', 20, 0, 100), ('socMax', 90, 0, 100), ('temperatureMaxC', 60, -50, 300)]:
        config[key_name] = b.number(data.get(key_name, default), key_name, low, high)
    if config['socMin'] > config['socMax']:
        raise b.Problem('SOC下限不能大于上限')
    with b.connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        previous = conn.execute('SELECT kind,mode FROM device_registry WHERE owner_id=? AND device_id=?', (uid, key)).fetchone()
        mode = previous['mode'] if previous else ('DEMO' if demo else 'REAL')
        if previous and previous['kind'] != kind:
            raise b.Problem('已有设备不能改变类型，请使用新设备ID')
        conn.execute('''INSERT INTO device_registry(owner_id,device_id,name,kind,mode,payload,created_at,updated_at)
                        VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(owner_id,device_id) DO UPDATE SET
                        name=excluded.name,payload=excluded.payload,revision=revision+1,updated_at=excluded.updated_at''',
                     (uid, key, name, kind, mode, json.dumps(config, ensure_ascii=False), b.now(), b.now()))
        log(conn, uid, 'DEVICE_CONFIGURED', key, {'mode': mode, 'config': config})
    return {'ok': True, 'deviceId': key, 'mode': mode}


def guard_config(uid):
    with b.connect() as conn:
        rows = conn.execute('SELECT device_id,revision,payload FROM device_registry WHERE owner_id=? AND mode="REAL" ORDER BY device_id', (uid,)).fetchall()
    return [{'deviceId': r['device_id'], 'revision': r['revision']} for r in rows
            if json.loads(r['payload'])['enabled'] and json.loads(r['payload'])['enforce']]


def normalized_points(points, kind):
    if not isinstance(points, list) or not 1 <= len(points) <= 500:
        raise b.Problem('每批需要1至500条设备观测')
    result = []
    for point in points:
        if not isinstance(point, dict) or set(point) - {'timestamp', 'values', 'quality'}:
            raise b.Problem('观测字段为timestamp、values、quality')
        try:
            when = datetime.fromisoformat(point['timestamp'].replace('Z', '+00:00'))
            if when.tzinfo is None:
                raise ValueError('必须带时区')
            when = when.astimezone(b.CHINA)
        except (ValueError, KeyError, TypeError, AttributeError):
            raise b.Problem('timestamp使用带时区的ISO时间，如2026-10-22T08:00:00+08:00')
        if when > datetime.now(b.CHINA) + timedelta(minutes=5):
            raise b.Problem('设备时间超前超过5分钟，请检查时钟')
        quality = point.get('quality', 'GOOD')
        values = point.get('values')
        if not isinstance(quality,str) or quality not in ('GOOD', 'UNCERTAIN', 'BAD') or not isinstance(values, dict) or not values or set(values) - FIELDS:
            raise b.Problem('质量码或指标无效；指标为powerKw、energyKwh、soc、temperatureC、state')
        cleaned = {}
        for key, value in values.items():
            if key == 'state':
                if not isinstance(value,str) or value not in STATES:
                    raise b.Problem('设备运行状态无效')
                cleaned[key] = value
            else:
                low, high = (-1e7 if kind == 'STORAGE' else 0, 1e7) if key == 'powerKw' else (0, 100) if key == 'soc' else (-100, 500) if key == 'temperatureC' else (0, 1e12)
                cleaned[key] = b.number(value, key, low, high)
        required = {'powerKw', 'soc'} if kind == 'STORAGE' else {'powerKw'} if kind == 'METER' else {'state'}
        if not required.issubset(cleaned):
            raise b.Problem('此设备类型缺少必需指标：' + ','.join(sorted(required)))
        result.append({'timestamp': when.isoformat(timespec='microseconds'), 'quality': quality, 'values': cleaned})
    return result


def ingest(uid, key, data, gateway=False):
    with b.connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        registered = device(uid, key, conn)
        if not registered['config']['enabled']:
            raise b.Problem('设备已停用', 409)
        points = normalized_points(data.get('points'), registered['kind'])
        source = b.text(data.get('source', registered['config']['source']), 200)
        raw = json.dumps({'source': source, 'points': points}, ensure_ascii=False, sort_keys=True)
        digest = hashlib.sha256(raw.encode()).hexdigest()
        previous = conn.execute('SELECT id FROM device_ingest_batch WHERE owner_id=? AND device_id=? AND digest=?', (uid, key, digest)).fetchone()
        if previous:
            return {'status': 'DUPLICATE', 'batchId': previous['id'], 'inserted': 0, 'mode': registered['mode']}
        batch = conn.execute('INSERT INTO device_ingest_batch(owner_id,device_id,digest,source,raw_payload,row_count,received_at) VALUES(?,?,?,?,?,?,?)',
                             (uid, key, digest, source, raw, len(points), b.now())).lastrowid
        inserted = 0
        for point in points:
            values = json.dumps(point['values'], sort_keys=True, ensure_ascii=False)
            existing = conn.execute('SELECT quality,values_json FROM device_sample WHERE owner_id=? AND device_id=? AND timestamp=?', (uid, key, point['timestamp'])).fetchone()
            if existing:
                if existing['quality'] != point['quality'] or existing['values_json'] != values:
                    raise b.Problem('相同设备和时刻已有不同观测，整批拒绝，不覆盖历史', 409)
                continue
            conn.execute('INSERT INTO device_sample VALUES(?,?,?,?,?,?,?)', (uid, key, point['timestamp'], point['quality'], values, batch, b.now()))
            inserted += 1
        log(conn, uid, 'DEVICE_TELEMETRY_IMPORTED', key, {'batchId': batch, 'digest': digest, 'inserted': inserted, 'mode': registered['mode']}, gateway)
    return {'status': 'ACCEPTED', 'batchId': batch, 'inserted': inserted, 'mode': registered['mode']}


def snapshot(uid, key, conn):
    row = device(uid, key, conn)
    has_token = bool(row.pop('token_hash'))
    row['gatewayConfigured'] = has_token
    latest = conn.execute('SELECT * FROM device_sample WHERE owner_id=? AND device_id=? ORDER BY timestamp DESC LIMIT 1', (uid, key)).fetchone()
    problems = []
    if latest:
        row['latest'] = {'timestamp': latest['timestamp'], 'quality': latest['quality'], 'values': json.loads(latest['values_json']), 'batchId': latest['batch_id'], 'receivedAt': latest['received_at']}
        age = max(0, (datetime.now(b.CHINA) - datetime.fromisoformat(latest['timestamp'])).total_seconds())
        row['ageSeconds'] = round(age, 1)
        if age > row['config']['staleSeconds']:
            problems.append(('STALE', '遥测已过期', age, row['config']['staleSeconds'], '秒'))
        if latest['quality'] != 'GOOD':
            problems.append(('QUALITY', '最新遥测质量未通过', latest['quality'], 'GOOD', ''))
        v, cfg = row['latest']['values'], row['config']
        if v.get('state') in ('FAULT', 'OFFLINE', 'MAINTENANCE'):
            problems.append(('STATE', '设备故障、离线或检修', v['state'], '可用状态', ''))
        if abs(v.get('powerKw', 0)) > cfg['ratedPowerKw']:
            problems.append(('POWER', '功率超过额定值', v['powerKw'], cfg['ratedPowerKw'], 'kW'))
        if v.get('soc') is not None and not cfg['socMin'] <= v['soc'] <= cfg['socMax']:
            problems.append(('SOC', 'SOC超出确认范围', v['soc'], [cfg['socMin'], cfg['socMax']], '%'))
        if v.get('temperatureC') is not None and v['temperatureC'] > cfg['temperatureMaxC']:
            problems.append(('TEMPERATURE', '温度超过确认阈值', v['temperatureC'], cfg['temperatureMaxC'], '℃'))
    else:
        row['latest'] = None
        row['ageSeconds'] = None
        problems.append(('NO_DATA', '尚无设备遥测', None, '有效观测', ''))
    row['issues'] = [{'code': code, 'message': message, 'value': value, 'threshold': threshold, 'unit': unit} for code, message, value, threshold, unit in problems]
    row['status'] = 'DISABLED' if not row['config']['enabled'] else 'NO_DATA' if not latest else 'STALE' if any(x[0] == 'STALE' for x in problems) else 'WARNING' if problems else 'ONLINE'
    return row


def summary(uid):
    with b.connect() as conn:
        keys = [r[0] for r in conn.execute('SELECT device_id FROM device_registry WHERE owner_id=? ORDER BY device_id', (uid,))]
        devices = [snapshot(uid, key, conn) for key in keys]
    return {'devices': devices, 'counts': {'total': len(devices), 'online': sum(d['status'] == 'ONLINE' for d in devices),
            'attention': sum(d['status'] not in ('ONLINE', 'DISABLED') for d in devices), 'demo': sum(d['mode'] == 'DEMO' for d in devices)}}


def history(uid, key):
    with b.connect() as conn:
        registered = snapshot(uid, key, conn)
        rows = conn.execute('SELECT timestamp,quality,values_json,batch_id FROM device_sample WHERE owner_id=? AND device_id=? ORDER BY timestamp DESC LIMIT 240', (uid, key)).fetchall()
        batches = [dict(r) for r in conn.execute('SELECT id,digest,source,row_count,received_at FROM device_ingest_batch WHERE owner_id=? AND device_id=? ORDER BY id DESC LIMIT 20', (uid, key))]
    return {'device': registered, 'points': [{'timestamp': r['timestamp'], 'quality': r['quality'], 'values': json.loads(r['values_json']), 'batchId': r['batch_id']} for r in reversed(rows)], 'batches': batches}


def guard_violations(uid):
    return [d['name'] + '：' + i['message'] for d in summary(uid)['devices']
            if d['mode'] == 'REAL' and d['config']['enabled'] and d['config']['enforce'] for i in d['issues']]


def alert_candidates(uid):
    result = []
    for item in summary(uid)['devices']:
        if not item['config']['enabled']:
            continue
        for issue in item['issues']:
            result.append({'key': 'DEVICE:' + item['device_id'] + ':' + issue['code'], 'version': 'device:' + item['device_id'] + ':' + str(item['revision']),
                'category': 'STORAGE' if item['kind'] == 'STORAGE' else 'DATA',
                'level': 'BLOCKING' if item['mode'] == 'REAL' and item['config']['enforce'] else 'IMPORTANT',
                'title': ('【设备演示】' if item['mode'] == 'DEMO' else '') + item['name'] + '：' + issue['message'],
                'details': {'field': 'device.' + issue['code'], 'value': issue['value'], 'threshold': issue['threshold'], 'unit': issue['unit'],
                    'date': datetime.now(b.CHINA).date().isoformat(), 'meter': item['config']['equipmentId'], 'planId': None, 'batchIds': [],
                    'deviceId': item['device_id'], 'deviceBatchId': item['latest']['batchId'] if item['latest'] else None,
                    'deviceRevision': item['revision'], 'mode': item['mode'], 'entry': 'devices'}})
    return result


def rotate_token(uid, key):
    token = 'ppt_' + secrets.token_urlsafe(32)
    expires = (datetime.now(b.CHINA) + timedelta(days=90)).isoformat(timespec='seconds')
    with b.connect() as conn:
        row = device(uid, key, conn)
        if row['mode'] != 'REAL':
            raise b.Problem('演示设备不能配置真实网关凭据', 409)
        conn.execute('UPDATE device_registry SET token_hash=?,token_expires=? WHERE owner_id=? AND device_id=?', (hashlib.sha256(token.encode()).hexdigest(), expires, uid, key))
        log(conn, uid, 'DEVICE_TOKEN_ROTATED', key, {'expiresAt': expires})
    return {'token': token, 'expiresAt': expires, 'deviceId': key, 'note': '仅本次显示。凭据只能向此设备上报观测，不能读取企业数据或下发控制。'}


def gateway_ingest(authorization, data):
    digest = hashlib.sha256(authorization[7:].strip().encode()).hexdigest() if authorization.startswith('Bearer ') else ''
    with b.connect() as conn:
        row = conn.execute('SELECT owner_id,device_id,token_expires FROM device_registry WHERE token_hash=?', (digest,)).fetchone()
    if not row or not row['token_expires'] or row['token_expires'] <= b.now():
        raise b.Problem('设备凭据无效或过期', 401)
    if data.get('deviceId') not in (None, row['device_id']):
        raise b.Problem('设备凭据不能向其他设备上报', 403)
    return ingest(row['owner_id'], row['device_id'], data, gateway=True)


def seed_demo(uid):
    if summary(uid)['devices']:
        raise b.Problem('此空间已有设备，请在空设备空间载入演示，避免混合现场与模拟观测', 409)
    now = datetime.now(b.CHINA).replace(microsecond=0)
    for key, name, kind, power in [('CUT-01', '切割下料机', 'PLC', 80), ('FURNACE-01', '连续热处理炉', 'PLC', 120),
                                  ('CNC-01', '精加工设备', 'PLC', 60), ('ESS-01', '车间储能', 'STORAGE', 100), ('METER-01', '车间总进线电表', 'METER', 800)]:
        save_device(uid, {'deviceId': key, 'name': name, 'kind': kind, 'line': '流水线A', 'equipmentId': key, 'source': '合成台架演示',
                         'enforce': False, 'ratedPowerKw': power, 'staleSeconds': 3600}, demo=True)
        points = []
        for i in range(60):
            value = {'powerKw': round(power * (.65 + .1 * math.sin(i / 6)), 2), 'state': 'RUNNING', 'temperatureC': round(35 + 3 * math.sin(i / 8), 1)}
            if kind == 'STORAGE':
                value['soc'] = round(45 + 10 * math.sin(i / 10), 1)
            if key == 'FURNACE-01' and i == 59:
                value['state'] = 'MAINTENANCE'
            points.append({'timestamp': (now - timedelta(minutes=59 - i)).isoformat(), 'values': value})
        ingest(uid, key, {'source': '合成台架演示', 'points': points})
    return summary(uid)
