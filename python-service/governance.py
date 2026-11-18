"""Workspace authorization, immutable versions, alert tasks and evidence workflows."""
from __future__ import annotations

import contextvars
import base64
import copy
import csv
import hashlib
import io
import json
import secrets
from collections import defaultdict
from datetime import date, datetime, timedelta
from xml.etree import ElementTree as XML
from zipfile import ZipFile, BadZipFile

import business as b
import decision as d

ACTOR = contextvars.ContextVar('actor', default=None)
ROLES = {'OWNER','ANALYST','APPROVER','FINANCE','PRODUCTION','DEVICE','VIEWER'}
RULE_DEFAULTS = {'priceHigh':1000,'loadHighKw':1800,'maxSpotExposurePercent':70,'maxStaleDays':1,
                 'gridWarningPercent':95,'executionDeviationPercent':10}


def migrate(conn):
    cols = {r[1] for r in conn.execute('PRAGMA table_info(business_plan)')}
    for name,kind in {'parent_id':'INTEGER','created_by':'INTEGER','decided_by':'INTEGER',
                      'version_no':'INTEGER NOT NULL DEFAULT 1','input_fingerprint':'TEXT','changes':'TEXT',
                      'change_reason':'TEXT','submitted_at':'TEXT'}.items():
        if name not in cols: conn.execute(f'ALTER TABLE business_plan ADD COLUMN {name} {kind}')
    conn.execute("INSERT OR IGNORE INTO workspace_member(owner_id,user_id,role) SELECT id,id,'OWNER' FROM app_user")
    conn.execute('UPDATE business_plan SET created_by=user_id WHERE created_by IS NULL')


def identity(user):
    with b.connect() as conn:
        conn.execute("INSERT OR IGNORE INTO workspace_member(owner_id,user_id,role) VALUES(?,?,'OWNER')",(user['id'],user['id']))
        selection=conn.execute('SELECT owner_id FROM workspace_selection WHERE user_id=?',(user['id'],)).fetchone()
        owner=selection[0] if selection else user['id']
        member=conn.execute('SELECT role FROM workspace_member WHERE owner_id=? AND user_id=? AND active=1',(owner,user['id'])).fetchone()
        if not member:
            # Revocation removes access immediately and returns the account to its own space.
            owner=user['id']
            conn.execute('DELETE FROM workspace_selection WHERE user_id=?',(user['id'],))
            member=conn.execute('SELECT role FROM workspace_member WHERE owner_id=? AND user_id=? AND active=1',(owner,user['id'])).fetchone()
            if not member: raise b.Problem('账号权限已停用',403)
    result={**user,'workspaceId':owner,'workspaceRole':member['role']}
    ACTOR.set(result)
    return result


def actor(uid):
    a=ACTOR.get()
    # Internal test/jobs without an HTTP identity run as the workspace owner.
    return a if a and a.get('workspaceId')==uid else {'id':uid,'workspaceId':uid,'workspaceRole':'OWNER','username':str(uid)}


def require(uid,*roles):
    a=actor(uid)
    if a['workspaceRole'] not in roles: raise b.Problem('当前企业角色无此操作权限',403)
    return a


def log(conn,uid,kind,entity,detail):
    b.audit(conn,uid,kind,entity,{**detail,'actorId':actor(uid)['id'],'role':actor(uid)['workspaceRole']})


def authorize(uid,path):
    if path.startswith('/api/team') or path in ('/api/ai/feedback','/api/plans/review'): return
    roles=('OWNER','ANALYST')
    if path.startswith('/api/bills') or path=='/api/savings/verify': roles=('OWNER','FINANCE')
    elif path=='/api/plans/review': roles=('OWNER','APPROVER')
    elif path.startswith('/api/alerts'): roles=('OWNER','ANALYST','APPROVER','FINANCE','PRODUCTION','DEVICE')
    elif path in ('/api/plans/execute',): roles=('OWNER','ANALYST')
    elif path.startswith('/api/rules'): roles=('OWNER','FINANCE','APPROVER')
    elif path.startswith('/api/devices') or path == '/api/telemetry': roles=('OWNER','ANALYST','DEVICE')
    elif path == '/api/profile': roles=('OWNER','ANALYST','PRODUCTION')
    require(uid,*roles)


def team(uid):
    a=actor(uid)
    with b.connect() as conn:
        members=[dict(r) for r in conn.execute('SELECT m.user_id,m.role,m.active,u.username FROM workspace_member m JOIN app_user u ON u.id=m.user_id WHERE owner_id=?',(uid,))]
        memberships=[dict(r) for r in conn.execute('SELECT m.owner_id,m.role,u.username AS owner FROM workspace_member m JOIN app_user u ON u.id=m.owner_id WHERE m.user_id=? AND m.active=1',(a['id'],))]
    return {'current':a,'members':members,'memberships':memberships}


def team_action(uid,path,data):
    a=actor(uid)
    if path=='/api/team/invite':
        require(uid,'OWNER')
        role=data.get('role')
        if role not in ROLES-{'OWNER'}: raise b.Problem('请选择分析、批准、财务、生产、设备或只读角色')
        raw=secrets.token_urlsafe(24)
        with b.connect() as conn:
            conn.execute('INSERT INTO workspace_invite VALUES(?,?,?,?,?,NULL,?)',
                         (hashlib.sha256(raw.encode()).hexdigest(),uid,role,a['id'],(datetime.now(b.CHINA)+timedelta(days=1)).isoformat(timespec='seconds'),b.now()))
            log(conn,uid,'MEMBER_INVITED',role,{'role':role})
        return {'inviteCode':raw,'expiresInHours':24,'role':role}
    if path=='/api/team/join':
        digest=hashlib.sha256(str(data.get('code','')).strip().encode()).hexdigest()
        with b.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            invite=conn.execute('SELECT * FROM workspace_invite WHERE token_hash=?',(digest,)).fetchone()
            if not invite or invite['used_by'] is not None or invite['expires_at']<b.now(): raise b.Problem('邀请码已过期或使用',409)
            conn.execute('INSERT INTO workspace_member VALUES(?,?,?,1) ON CONFLICT(owner_id,user_id) DO UPDATE SET role=excluded.role,active=1',(invite['owner_id'],a['id'],invite['role']))
            conn.execute('UPDATE workspace_invite SET used_by=? WHERE token_hash=?',(a['id'],digest))
            conn.execute('INSERT OR REPLACE INTO workspace_selection VALUES(?,?)',(a['id'],invite['owner_id']))
            log(conn,invite['owner_id'],'MEMBER_JOINED',a['id'],{'role':invite['role']})
        return {'ok':True}
    if path=='/api/team/switch':
        owner=b.integer(data.get('workspaceId'),'企业空间',1,10**12)
        with b.connect() as conn:
            if not conn.execute('SELECT 1 FROM workspace_member WHERE owner_id=? AND user_id=? AND active=1',(owner,a['id'])).fetchone(): raise b.Problem('无此企业访问权限',403)
            conn.execute('INSERT OR REPLACE INTO workspace_selection VALUES(?,?)',(a['id'],owner))
        return {'ok':True}
    if path=='/api/team/revoke':
        require(uid,'OWNER');member=b.integer(data.get('userId'),'成员',1,10**12)
        if member==uid: raise b.Problem('不能撤销企业所有者')
        with b.connect() as conn:
            conn.execute('UPDATE workspace_member SET active=0 WHERE owner_id=? AND user_id=?',(uid,member))
            log(conn,uid,'MEMBER_REVOKED',member,{})
        return {'ok':True}
    raise b.Problem('团队接口不存在',404)


def validate_profile(data):
    extra={'storageParametersConfirmed':data.get('storageParametersConfirmed',False),
           'storageMaxCycles':b.number(data.get('storageMaxCycles',2),'每日等效循环上限',0,20),
           'storageUnavailableHours':data.get('storageUnavailableHours',[]),'tasks':data.get('tasks',[])}
    if not isinstance(extra['storageParametersConfirmed'],bool): raise b.Problem('储能参数确认必须为布尔值')
    if not isinstance(extra['storageUnavailableHours'],list) or any(type(h) is not int or not 0<=h<=23 for h in extra['storageUnavailableHours']): raise b.Problem('储能停用小时应为0至23整数数组')
    if not isinstance(extra['tasks'],list) or len(extra['tasks'])>8: raise b.Problem('首期支持最多8个连续工序')
    cleaned=[]
    for task in extra['tasks']:
        item={k:b.text(task.get(k,''),100) for k in ('id','name')}
        item.update({k:b.text(task.get(k,''),100) for k in ('line','equipmentId','orderNo','quantityUnit')})
        item['quantity']=b.number(task.get('quantity',1),'本次固定生产任务数量',0.001,1e9)
        if not item['id'] or not item['name']: raise b.Problem('工序ID及名称必填')
        item['powerKw']=b.number(task.get('powerKw'),'工序功率',0.001,1e7)
        for k,lo,hi in (('duration',1,24),('baselineStart',0,23),('windowStart',0,23),('windowEnd',1,24)):
            item[k]=b.integer(task.get(k),k,lo,hi)
        if item['baselineStart']+item['duration']>24 or item['windowEnd']-item['windowStart']<item['duration']: raise b.Problem('工序时长超出日界或允许窗口')
        for key in ('forbiddenHours','predecessors'):
            if not isinstance(task.get(key,[]),list): raise b.Problem(key+'应为数组')
            item[key]=task.get(key,[])
        if any(type(h) is not int or not 0<=h<=23 for h in item['forbiddenHours']): raise b.Problem('工序禁运行小时无效')
        cleaned.append(item)
    ids=[t['id'] for t in cleaned]
    if len(ids)!=len(set(ids)): raise b.Problem('工序ID不能重复')
    graph={t['id']:t['predecessors'] for t in cleaned}
    def visit(key,seen):
        if key not in graph or key in seen: raise b.Problem('工序先后关系有环或引用了未知ID')
        for prev in graph[key]: visit(prev,seen|{key})
    for key in ids: visit(key,set())
    extra['tasks']=cleaned
    return extra


def save_profile(uid,data):
    return b.save_profile(uid,data)


def excel_records(encoded):
    """Read canonical columns from the first worksheet without executing formulas."""
    try:
        raw=base64.b64decode(encoded,validate=True)
        if len(raw)>1_800_000: raise b.Problem('Excel文件不能超过1.8MB')
        with ZipFile(io.BytesIO(raw)) as archive:
            if sum(x.file_size for x in archive.infolist())>20_000_000: raise b.Problem('Excel解压后超过20MB')
            ns={'s':'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
            shared=[]
            if 'xl/sharedStrings.xml' in archive.namelist():
                root=XML.fromstring(archive.read('xl/sharedStrings.xml'))
                shared=[''.join(t.text or '' for t in x.findall('.//s:t',ns)) for x in root.findall('s:si',ns)]
            book=XML.fromstring(archive.read('xl/workbook.xml'))
            sheet=book.find('s:sheets/s:sheet',ns)
            if sheet is None: raise b.Problem('Excel没有工作表')
            relation=sheet.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')
            rels=XML.fromstring(archive.read('xl/_rels/workbook.xml.rels'))
            target=next((r.get('Target') for r in rels if r.get('Id')==relation),None)
            if not target: raise b.Problem('工作表关系不存在')
            target=target.lstrip('/') if target.startswith('/') else 'xl/'+target
            if '..' in target: raise b.Problem('工作表路径无效')
            root=XML.fromstring(archive.read(target))
            values=[]
            for row in root.findall('s:sheetData/s:row',ns):
                output={}
                for cell in row.findall('s:c',ns):
                    if cell.find('s:f',ns) is not None: raise b.Problem('请将Excel公式转为已确认的数值后导入，系统不使用可能过期的缓存结果')
                    key=''.join(x for x in cell.get('r','') if x.isalpha())
                    value=cell.find('s:v',ns);value=value.text if value is not None else ''
                    kind=cell.get('t')
                    if kind=='s': value=shared[int(value)]
                    elif kind=='inlineStr': value=''.join(t.text or '' for t in cell.findall('.//s:t',ns))
                    elif kind=='b': raise b.Problem('时序表不接受布尔单元格')
                    output[key]=value
                if output: values.append(output)
                if len(values)>10001: raise b.Problem('Excel最多10000条时序记录')
            if len(values)<2: raise b.Problem('Excel没有数据行')
            header=values[0]
            if not set(b.COLUMNS[:3]).issubset(header.values()): raise b.Problem('首个工作表表头应包含timestamp、price_yuan_mwh、load_kw')
            prop=book.find('s:workbookPr',ns);epoch=datetime(1904,1,1) if prop is not None and prop.get('date1904') in ('1','true') else datetime(1899,12,30)
            result=[]
            for row in values[1:]:
                item={name:row.get(col,'') for col,name in header.items() if name in b.COLUMNS}
                ts=item.get('timestamp','')
                if ts and ts.replace('.','',1).isdigit(): item['timestamp']=(epoch+timedelta(seconds=round(float(ts)*86400))).isoformat(timespec='seconds')
                result.append(item)
        return raw,result
    except (BadZipFile,KeyError,ValueError,IndexError,XML.ParseError) as exc:
        raise b.Problem('Excel格式无效：'+str(exc))


def import_data(uid,data):
    raw=data.get('csv','')
    if not isinstance(raw,str) or len(raw.encode('utf-8'))>1_800_000: raise b.Problem('原始文件不能超过1.8MB')
    original=None;binary=None
    if data.get('format')=='xlsx':
        binary,records=excel_records(data.get('base64',''))
        original=base64.b64encode(binary).decode()
        data={**data,'records':records}
    # JSON record imports and CSV use the same canonical validation and atomic publishing.
    if data.get('format') in ('json','xlsx'):
        records=data.get('records')
        if not isinstance(records,list) or not records or len(records)>10000: raise b.Problem('JSON需包含1至10000条记录')
        stream=io.StringIO();writer=csv.DictWriter(stream,fieldnames=b.COLUMNS,extrasaction='raise');writer.writeheader()
        try: writer.writerows(records)
        except (ValueError,TypeError): raise b.Problem('JSON字段必须使用导入数据字典')
        raw=stream.getvalue()
        if original is None:
            original=data.get('rawJson',json.dumps(records,ensure_ascii=False))
            try:
                if json.loads(original)!=records: raise b.Problem('JSON原文件与记录内容不一致')
            except (ValueError,TypeError): raise b.Problem('JSON原文件格式无效')
    if original is None: original=raw
    if binary is None and len(original.encode('utf-8'))>1_800_000: raise b.Problem('原始文件不能超过1.8MB')
    meta=data.get('metadata',{})
    if not isinstance(meta,dict): raise b.Problem('数据元信息格式无效')
    meta={**{'source':'人工导入','timezone':'Asia/Shanghai','intervalMinutes':60,'priceUnit':'元/MWh','loadUnit':'kW',
              'meter':b.profile(uid)['values']['meter'],'authorization':'待确认','mappingVersion':'canonical-v2'},**meta}
    for key in ('source','timezone','meter','authorization','mappingVersion','validFrom','validTo'):
        if key in meta: meta[key]=b.text(meta[key],500)
    if meta['timezone']!='Asia/Shanghai' or meta['priceUnit']!='元/MWh' or meta['loadUnit']!='kW':
        raise b.Problem('请明确转换为Asia/Shanghai、元/MWh和kW；不猜测单位')
    interval=meta['intervalMinutes']
    if interval not in (15,60): raise b.Problem('仅接受60分钟或完整15分钟区间')
    normalized=raw
    issues=[]
    if interval==15:
        grouped=defaultdict(list);seen=set()
        try:
            for n,row in enumerate(csv.DictReader(io.StringIO(raw.lstrip('\ufeff'))),2):
                t=datetime.fromisoformat(row['timestamp'])
                if t.tzinfo: t=t.astimezone(b.CHINA).replace(tzinfo=None)
                if t.minute not in (0,15,30,45) or t.second or t.microsecond or t in seen: raise b.Problem('15分钟时间戳无效或重复')
                seen.add(t);item={'timestamp':t}
                for key in b.COLUMNS[1:]:
                    v=row.get(key,'')
                    item[key]=None if v is None or not v.strip() else b.number(v,key,-100000 if key in ('price_yuan_mwh','contract_price_yuan_mwh','temperature_c') else 0,1e8)
                if item['price_yuan_mwh'] is None or item['load_kw'] is None: raise b.Problem('价格及负荷必填')
                if (item['contract_kwh'] is None)!=(item['contract_price_yuan_mwh'] is None): raise b.Problem('合同电量和价格须成对')
                grouped[t.replace(minute=0)].append(item)
            stream=io.StringIO();writer=csv.writer(stream);writer.writerow(b.COLUMNS)
            for hour,rs in sorted(grouped.items()):
                if len(rs)!=4: raise b.Problem(hour.isoformat()+'缺少15分钟区间，整批隔离')
                load=sum(r['load_kw'] for r in rs)/4
                price=sum(r['load_kw']*r['price_yuan_mwh'] for r in rs)/sum(r['load_kw'] for r in rs) if load else sum(r['price_yuan_mwh'] for r in rs)/4
                extras=[]
                for key in ('temperature_c','renewable_kw'):
                    extras.append(sum(r[key] for r in rs)/4 if all(r[key] is not None for r in rs) else '')
                if any(r['contract_kwh'] is not None for r in rs) and not all(r['contract_kwh'] is not None for r in rs): raise b.Problem('同一小时合同字段部分缺失')
                c=sum(r['contract_kwh'] for r in rs) if rs[0]['contract_kwh'] is not None else None
                # Effective hourly contract price preserves the original quarter-hour contract difference.
                cp=(sum(r['contract_kwh']*(r['contract_price_yuan_mwh']-r['price_yuan_mwh']) for r in rs)/c+price) if c else (rs[0]['contract_price_yuan_mwh'] if c==0 else None)
                writer.writerow([hour.isoformat(timespec='minutes'),price,load,*extras,c,cp])
            normalized=stream.getvalue()
        except (ValueError,KeyError,TypeError,b.Problem) as exc: issues=[{'line':0,'message':str(exc)}]
    if issues:
        with b.connect() as conn:
            batch=conn.execute("INSERT INTO import_batch(user_id,filename,digest,raw_csv,status,row_count,issues,created_at) VALUES(?,?,?,?,'REJECTED',0,?,?)",(uid,b.text(data.get('filename','interval.csv'),180),hashlib.sha256(raw.encode()).hexdigest(),raw,json.dumps(issues,ensure_ascii=False),b.now())).lastrowid
            log(conn,uid,'IMPORT_REJECTED',batch,{'issues':issues})
        result={'batchId':batch,'status':'REJECTED','rows':0,'issues':issues}
    else:
        result=b.import_csv(uid,{**data,'csv':normalized})
    meta.update(aggregation='hourly-energy-and-cost-preserving-v1' if interval==15 else None,receivedAt=b.now(),
                originalFormat=data.get('format','csv'),rawEncoding='base64' if binary else 'utf8',normalizedDigest=hashlib.sha256(normalized.encode()).hexdigest())
    with b.connect() as conn:
        conn.execute('INSERT INTO import_metadata VALUES(?,?)',(result['batchId'],json.dumps(meta,ensure_ascii=False)))
        conn.execute('UPDATE import_batch SET raw_csv=?,digest=? WHERE id=?',(original,hashlib.sha256(binary if binary else original.encode()).hexdigest(),result['batchId']))
    return result


def plan_row(uid,pid,conn=None):
    if conn is None:
        with b.connect() as connection: return plan_row(uid,pid,connection)
    row=conn.execute('SELECT * FROM business_plan WHERE user_id=? AND id=?',(uid,pid)).fetchone()
    if not row: raise b.Problem('方案不存在或无权访问',404)
    return dict(row)


def current_fingerprint(uid):
    return d.fingerprint(b.profile(uid),d.forecast(uid))


def draft(uid,data,snapshot=None):
    require(uid,'OWNER','ANALYST')
    parent=None
    if data.get('parentId'):
        parent=plan_row(uid,b.integer(data['parentId'],'父方案',1,10**12))
    reason=b.text(data.get('reason','首次生成'),1000)
    if not reason: raise b.Problem('请填写修改/生成原因')
    if snapshot is None:
        compared=d.calculate(uid);code=data.get('scenario','S4')
        snapshot=next((s for s in compared['scenarios'] if s['code']==code),None)
        if snapshot is None: raise b.Problem('未知方案类型')
        snapshot={**snapshot,'readiness':compared['readiness'],'scenarios':compared['scenarios']}
    if snapshot['status']!='FEASIBLE': raise b.Problem(snapshot.get('message','方案不可行，不能保存'),409)
    if snapshot['baselineCost'] is None: raise b.Problem('原计划基准未核实，不能进入审核',409)
    previous=json.loads(parent['snapshot']) if parent else None
    changes={key:{'before':previous['profile'].get(key),'after':v} for key,v in snapshot['profile'].items() if previous and previous['profile'].get(key)!=v}
    if previous and previous.get('code')!=snapshot.get('code'): changes['scenario']={'before':previous.get('code'),'after':snapshot.get('code')}
    if snapshot.get('calculationKind'): changes['calculationKind']=snapshot['calculationKind']
    with b.connect() as conn:
        pid=conn.execute("INSERT INTO business_plan(user_id,plan_date,snapshot,created_at,parent_id,created_by,version_no,input_fingerprint,changes,change_reason) VALUES(?,?,?,?,?,?,?,?,?,?)",
                         (uid,snapshot['planDate'],json.dumps(snapshot,ensure_ascii=False),b.now(),parent['id'] if parent else None,actor(uid)['id'],
                          parent['version_no']+1 if parent else 1,snapshot['inputFingerprint'],json.dumps(changes,ensure_ascii=False),reason)).lastrowid
        log(conn,uid,'PLAN_DRAFTED',pid,{'parentId':parent['id'] if parent else None,'fingerprint':snapshot['inputFingerprint'],'reason':reason,'changes':changes})
    return {'id':pid,'plan':snapshot}


def review(uid,data):
    a=actor(uid);pid=b.integer(data.get('id'),'方案ID',1,10**12);action=data.get('action')
    note=b.text(data.get('note',''),1000)
    if not note: raise b.Problem('请填写审核/提交意见')
    if action not in ('SUBMITTED','IN_REVIEW','APPROVED','RETURNED','REJECTED'): raise b.Problem('审核动作无效')
    if action=='SUBMITTED': require(uid,'OWNER','ANALYST')
    else: require(uid,'OWNER','APPROVER')
    fc=d.forecast(uid);fingerprint=d.fingerprint(b.profile(uid),fc)
    readiness=b.readiness(uid,fc=fc)
    alerts=refresh_alerts(uid)
    with b.connect() as conn:
        conn.execute('BEGIN IMMEDIATE');row=plan_row(uid,pid,conn)
        allowed={'SUBMITTED':('DRAFT',),'IN_REVIEW':('SUBMITTED',),'APPROVED':('SUBMITTED','IN_REVIEW'),
                 'RETURNED':('SUBMITTED','IN_REVIEW'),'REJECTED':('SUBMITTED','IN_REVIEW')}
        if row['status'] not in allowed[action]: raise b.Problem('方案状态已变化或不允许该流转，请刷新',409)
        if action!='SUBMITTED' and row['created_by']==a['id']: raise b.Problem('提交人与审核批准人必须分离，请邀请批准人',403)
        if action in ('SUBMITTED','APPROVED'):
            import telemetry
            device_blockers = telemetry.guard_violations(uid)
            if device_blockers: raise b.Problem('设备执行前检查未通过：'+'；'.join(device_blockers),409)
            if json.loads(row['snapshot']).get('calculationKind','').startswith('STRESS_'):
                raise b.Problem('压力情景子版本仅供评估。请将已确认的新条件录入正式输入，重新计算普通子版本后提交审核',409)
            if current_fingerprint(uid)!=fingerprint: raise b.Problem('数据在审核期间发生变化，请刷新重试',409)
            blockers=[c['label'] for c in readiness if not c['passed']]
            if row['input_fingerprint']!=fingerprint: blockers.append('输入版本已变化，请生成子版本')
            blockers += [r['title'] for r in alerts['records'] if r['level']=='BLOCKING' and r['status'] in ('OPEN','ACKNOWLEDGED','IN_PROGRESS') and r['details'].get('planId') in (None,pid)]
            if blockers: raise b.Problem('当前版本被阻止：'+'；'.join(dict.fromkeys(blockers)),409)
        conn.execute('UPDATE business_plan SET status=?,review_note=?,reviewed_at=?,decided_by=?,submitted_at=COALESCE(submitted_at,?) WHERE id=? AND user_id=? AND status=?',
                     (action,note,b.now(),a['id'] if action!='SUBMITTED' else None,b.now(),pid,uid,row['status']))
        log(conn,uid,'PLAN_'+action,pid,{'note':note,'fingerprint':row['input_fingerprint'],'from':row['status']})
    return {'ok':True}


def execute(uid,data):
    require(uid,'OWNER','ANALYST');row=plan_row(uid,b.integer(data.get('id'),'方案ID',1,10**12))
    if json.loads(row['snapshot']).get('calculationKind','').startswith('STRESS_'):
        raise b.Problem('压力情景不能登记为正式执行版本，请按已确认输入重新计算审核',409)
    if row['input_fingerprint']!=current_fingerprint(uid): raise b.Problem('执行前复核失败：输入版本已失效，须生成子版本重新审核',409)
    if row['plan_date']!=datetime.now(b.CHINA).date().isoformat(): raise b.Problem('仅可登记今日批准版本；历史回放请使用压力测试或报告',409)
    alerts=refresh_alerts(uid)
    if any(r['level']=='BLOCKING' and r['status'] in ('OPEN','ACKNOWLEDGED','IN_PROGRESS') and r['details'].get('planId') in (None,row['id']) for r in alerts['records']):
        raise b.Problem('存在相关阻断预警，禁止登记执行',409)
    return b.execute_plan(uid,{**data,'operatorId':actor(uid)['id']})


def rules(uid):
    with b.connect() as conn: row=conn.execute('SELECT * FROM alert_rule WHERE owner_id=?',(uid,)).fetchone()
    return {'revision':row['revision'] if row else 0,'values':{**RULE_DEFAULTS,**(json.loads(row['payload']) if row else {})}}


def alert_candidates(uid,plan=None):
    pr=b.profile(uid);fc=d.forecast(uid);p=pr['values'];rule=rules(uid)
    version=d.fingerprint(pr,fc)+':'+str(rule['revision'])
    result=[]
    def add(key,category,level,title,field,value,threshold=None,unit='',plan_id=None,version_key=None,**more):
        result.append({'key':key,'version':version_key or version,'category':category,'level':level,'title':title,
                       'details':{'field':field,'value':value,'threshold':threshold,'unit':unit,'planId':plan_id,
                                  'date':fc.get('forecastDate'),'meter':p['meter'],'batchIds':fc.get('evidenceBatchIds',[]),
                                  'profileRevision':pr['revision'],'ruleRevision':rule['revision'],**more}})
    if not fc['slots']:
        add('DATA_REQUIRED','DATA','BLOCKING','缺少完整小时价格和负荷','forecast.slots',len(fc['slots']),24,'小时',entry='data')
    elif fc.get('staleDays',0)>rule['values']['maxStaleDays']:
        add('STALE_DATA','DATA','BLOCKING','分时数据已过期','forecast.staleDays',fc['staleDays'],rule['values']['maxStaleDays'],'天',entry='data')
    if fc['slots']:
        highest=max(fc['slots'],key=lambda s:s['predictedPrice'])
        if highest['predictedPrice']>rule['values']['priceHigh']:
            add('PRICE_HIGH','PRICE','IMPORTANT','预测价格超过阈值','forecast.slots.predictedPrice',highest['predictedPrice'],rule['values']['priceHigh'],'元/MWh',hour=highest['hour'],entry='forecast',nature='预测值')
        highload=max(fc['slots'],key=lambda s:s['predictedLoad'])
        if highload['predictedLoad']>rule['values']['loadHighKw']:
            add('LOAD_HIGH','LOAD','IMPORTANT','预测负荷超过企业提醒阈值','forecast.slots.predictedLoad',highload['predictedLoad'],rule['values']['loadHighKw'],'kW',hour=highload['hour'],entry='forecast')
        if p['settlementModel']=='fixed_contract_difference':
            if any(s.get('contractKwh') is None for s in fc['slots']):
                add('CONTRACT_MISSING','CONTRACT','BLOCKING','当前结算口径缺少合同字段','contractKwh',None,entry='data')
            else:
                demand=sum(s['predictedLoad'] for s in fc['slots'])
                if demand>0:
                    exposure=sum(max(0,s['predictedLoad']-s['contractKwh']) for s in fc['slots'])/demand*100
                    if exposure>rule['values']['maxSpotExposurePercent']:
                        add('SPOT_EXPOSURE','CONTRACT','IMPORTANT','模拟现货敞口超过阈值','contractExposurePercent',round(exposure,3),rule['values']['maxSpotExposurePercent'],'%',entry='optimization')
    ds=b.datasets(uid)
    if ds['missingDays']: add('INCOMPLETE_DAYS','DATA','IMPORTANT','部分日期缺少时段，已排除预测','datasets.missingDays',ds['missingDays'],entry='data')
    with b.connect() as conn:
        latest=conn.execute('SELECT * FROM import_batch WHERE user_id=? ORDER BY id DESC LIMIT 1',(uid,)).fetchone()
        if latest and latest['status']=='REJECTED':
            add('IMPORT_FAILED','DATA','IMPORTANT','最近导入批次被隔离','import.status','REJECTED',version_key='batch:'+str(latest['id']),batchId=latest['id'],entry='data')
        for row in conn.execute("SELECT id,plan_date,status,input_fingerprint,execution FROM business_plan WHERE user_id=? AND status IN ('SUBMITTED','IN_REVIEW','APPROVED','EXECUTED')",(uid,)):
            if row['status']!='EXECUTED' and (row['input_fingerprint']!=d.fingerprint(pr,fc) or row['plan_date']<datetime.now(b.CHINA).date().isoformat()):
                add('STALE_PLAN:'+str(row['id']),'VERSION','BLOCKING','方案 #'+str(row['id'])+' 输入或日期已失效','plan.inputFingerprint',row['input_fingerprint'],plan_id=row['id'],entry='plans')
            if row['execution']:
                execution=json.loads(row['execution']);expected=execution.get('expectedKwh')
                if expected and abs(execution['actualKwh']-expected)/expected*100>rule['values']['executionDeviationPercent']:
                    add('EXECUTION:'+str(row['id']),'EXECUTION','IMPORTANT','实际购电量偏差超过阈值','execution.energyDeviationKwh',execution['actualKwh']-expected,
                        expected*rule['values']['executionDeviationPercent']/100,'kWh',plan_id=row['id'],entry='plans')
        for row in conn.execute("SELECT id,difference,tolerance,items FROM bill_reconciliation WHERE user_id=? AND status='PENDING'",(uid,)):
            diffs=[abs(i['difference']) for i in json.loads(row['items'])]
            exceeds=max([abs(row['difference'])]+diffs)>row['tolerance']+1e-8
            add('BILL:'+str(row['id']),'BILL','IMPORTANT' if exceeds else 'GENERAL','账单 #'+str(row['id'])+(' 逐项差异超过容差' if exceeds else ' 待人工复核'),
                'bill.maxDifference',max([abs(row['difference'])]+diffs),row['tolerance'],'元',version_key='bill:'+str(row['id']),billId=row['id'],entry='bills')
        for row in conn.execute('SELECT id,plan_id,payload FROM stress_run WHERE owner_id=? ORDER BY id DESC LIMIT 20',(uid,)):
            stress=json.loads(row['payload'])
            if stress['candidate']['status']!='FEASIBLE':
                add('STRESS:'+str(row['id']),'FEASIBILITY','IMPORTANT','压力测试 #'+str(row['id'])+' 不可执行','stress.violations',stress['candidate']['violations'],
                    plan_id=row['plan_id'],version_key='stress:'+str(row['id']),entry='plans',stressId=row['id'])
    if plan and plan.get('status') not in ('FEASIBLE','DATA_REQUIRED'):
        add('PLAN_INFEASIBLE','FEASIBILITY','BLOCKING','当前候选方案约束不可行','plan.violations',plan.get('violations',[]),entry='optimization')
    if plan and plan.get('status')=='FEASIBLE':
        peak=max(s['adjustedLoad'] for s in plan['slots'])
        if peak>p['gridLimitKw']*rule['values']['gridWarningPercent']/100:
            add('GRID_MARGIN','LOAD','IMPORTANT','购电功率接近并网上限','slots.adjustedLoad',peak,p['gridLimitKw'],'kW',entry='optimization')
        # Validate known values only. Missing SOC is not a zero SOC reading.
        for s in plan['slots']:
            errors=[]
            if s.get('soc') is not None and not p['socMin']-1e-4<=s['soc']<=p['socMax']+1e-4: errors.append('SOC越限')
            if s['charge']*s['discharge']>1e-4: errors.append('充放电同时发生')
            if max(s['charge'],s['discharge'])>p['storagePowerKw']+1e-4: errors.append('功率越限')
            if errors: add('STORAGE:'+str(s['hour']),'STORAGE','BLOCKING','储能动作未通过安全复核','slots',s,entry='optimization',violations=errors)
    import telemetry
    result.extend(telemetry.alert_candidates(uid))
    return result


def refresh_alerts(uid,plan=None):
    if plan is None: plan=d.calculate(uid)
    candidates=alert_candidates(uid,plan)
    keys={(c['key'],c['version']) for c in candidates}
    with b.connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        for c in candidates:
            row=conn.execute('SELECT * FROM alert_record WHERE owner_id=? AND alert_key=? AND version_key=?',(uid,c['key'],c['version'])).fetchone()
            details=json.dumps(c['details'],ensure_ascii=False)
            if row:
                conn.execute('UPDATE alert_record SET details=?,updated_at=? WHERE id=? AND details<>?',(details,b.now(),row['id'],details))
                if row['status']=='RESOLVED':
                    conn.execute("UPDATE alert_record SET status='OPEN',closed_at=NULL,resolution=NULL,updated_at=? WHERE id=?",(b.now(),row['id']))
                    log(conn,uid,'ALERT_REOPENED',row['id'],{'reason':'条件再次出现'})
                continue
            due=(datetime.now(b.CHINA)+timedelta(hours=1 if c['level']=='BLOCKING' else 24)).isoformat(timespec='seconds')
            aid=conn.execute('INSERT INTO alert_record(owner_id,alert_key,version_key,category,level,title,details,due_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
                             (uid,c['key'],c['version'],c['category'],c['level'],c['title'],details,due,b.now(),b.now())).lastrowid
            log(conn,uid,'ALERT_OPENED',aid,c)
        for row in conn.execute("SELECT * FROM alert_record WHERE owner_id=? AND status IN ('OPEN','ACKNOWLEDGED','IN_PROGRESS')",(uid,)):
            if (row['alert_key'],row['version_key']) not in keys:
                conn.execute("UPDATE alert_record SET status='RESOLVED',closed_at=?,resolution='条件解除或输入版本已变化',updated_at=? WHERE id=?",(b.now(),b.now(),row['id']))
                log(conn,uid,'ALERT_AUTO_RESOLVED',row['id'],{'reason':'条件解除或输入版本已变化'})
    return alerts(uid)


def alerts(uid):
    with b.connect() as conn:
        records=[dict(r) for r in conn.execute('SELECT * FROM alert_record WHERE owner_id=? ORDER BY id DESC',(uid,))]
        actions=[dict(r) for r in conn.execute('SELECT * FROM alert_action WHERE owner_id=? ORDER BY id DESC',(uid,))]
    for r in records: r['details']=json.loads(r['details'])
    active=[r for r in records if r['status'] in ('OPEN','ACKNOWLEDGED','IN_PROGRESS')]
    return {'records':records,'actions':actions,'rules':rules(uid),'counts':{'active':len(active),'blocking':sum(r['level']=='BLOCKING' for r in active),
            'resolved':sum(r['status']=='RESOLVED' for r in records),'ignored':sum(r['status'] in ('IGNORED','FALSE_POSITIVE') for r in records)}}


def alert_action(uid,data):
    require(uid,'OWNER','ANALYST','APPROVER','FINANCE')
    action=data.get('action');note=b.text(data.get('note',''),1000);aid=b.integer(data.get('id'),'预警ID',1,10**12)
    if action not in ('ACKNOWLEDGE','ASSIGN','START','RESOLVE','IGNORE','FALSE_POSITIVE'): raise b.Problem('预警动作无效')
    if not note: raise b.Problem('请填写处置意见或原因')
    current=refresh_alerts(uid)
    live=next((r for r in current['records'] if r['id']==aid),None)
    if not live: raise b.Problem('预警不存在',404)
    if live['status']=='RESOLVED' and action=='RESOLVE': return current
    if live['status'] in ('RESOLVED','IGNORED','FALSE_POSITIVE'): raise b.Problem('预警已关闭，不能重复处置',409)
    if action=='RESOLVE': raise b.Problem('触发条件仍存在；修正数据或条件后刷新，系统核验后自动标记已解决',409)
    if action in ('IGNORE','FALSE_POSITIVE') and live['level']=='BLOCKING': raise b.Problem('阻断预警必须解除触发条件，不能通过忽略绕过',409)
    states={'ACKNOWLEDGE':'ACKNOWLEDGED','START':'IN_PROGRESS','IGNORE':'IGNORED','FALSE_POSITIVE':'FALSE_POSITIVE'}
    assigned=b.text(data.get('assignedTo',''),100)
    if action=='ASSIGN' and not assigned: raise b.Problem('请填写责任人')
    with b.connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        changed=conn.execute('UPDATE alert_record SET status=?,assigned_to=?,updated_at=?,closed_at=?,resolution=? WHERE id=? AND owner_id=? AND status=?',
                     (states.get(action,live['status']),assigned if action=='ASSIGN' else live['assigned_to'],b.now(),b.now() if action in ('IGNORE','FALSE_POSITIVE') else None,
                      note if action in ('IGNORE','FALSE_POSITIVE') else None,aid,uid,live['status'])).rowcount
        if changed!=1: raise b.Problem('预警已被他人处理，请刷新',409)
        conn.execute('INSERT INTO alert_action(owner_id,alert_id,actor_id,action,note,created_at) VALUES(?,?,?,?,?,?)',(uid,aid,actor(uid)['id'],action,note,b.now()))
        log(conn,uid,'ALERT_'+action,aid,{'note':note,'assignedTo':assigned})
    return alerts(uid)


def stress_run(uid,data):
    require(uid,'OWNER','ANALYST')
    row=plan_row(uid,b.integer(data.get('planId'),'方案ID',1,10**12))
    snap=json.loads(row['snapshot'])
    result=d.stress(snap,data)
    child=None
    if result['mode']=='REOPTIMIZE' and result['candidate']['status']=='FEASIBLE':
        if row['input_fingerprint']!=current_fingerprint(uid): raise b.Problem('原输入已变化，请先按当前数据生成子版本',409)
        # Carry the original evidence fingerprint; perturbations are explicitly versioned assumptions.
        child=draft(uid,{'parentId':row['id'],'reason':f"压力情景：价格{result['priceDelta']:+}元/MWh，基础负荷{result['baseLoadPercent']:+}%"},result['candidate'])['id']
    with b.connect() as conn:
        sid=conn.execute('INSERT INTO stress_run(owner_id,plan_id,actor_id,payload,child_id,created_at) VALUES(?,?,?,?,?,?)',
                         (uid,row['id'],actor(uid)['id'],json.dumps(result,ensure_ascii=False),child,b.now())).lastrowid
        log(conn,uid,'STRESS_CALCULATED',sid,{'planId':row['id'],'mode':result['mode'],'childId':child,'status':result['candidate']['status']})
    return {'id':sid,'childId':child,**result}


def verify_saving(uid,data):
    """Narrow, auditable daily cost scope; no invented monthly attribution."""
    a=require(uid,'OWNER','FINANCE');row=plan_row(uid,b.integer(data.get('planId'),'方案ID',1,10**12))
    if row['status']!='EXECUTED': raise b.Problem('需要先登记已批准版本的实际执行',409)
    execution=json.loads(row['execution']);snap=json.loads(row['snapshot'])
    if a['id']==execution['operatorId']: raise b.Problem('执行登记与财务核验人员必须分离',403)
    bill_id=b.integer(data.get('billId'),'正式账单',1,10**12)
    bill=next((x for x in b.bills(uid,True) if x['id']==bill_id),None)
    if not bill or bill['status']!='CONFIRMED': raise b.Problem('需要本企业已复核的正式账单',409)
    if bill['period_start']!=row['plan_date'] or bill['period_end']!=row['plan_date']:
        raise b.Problem('当前核验支持与方案同一天、相同费用范围的日结算账单；整月账单需先完成整账期基准建模',409)
    if data.get('scopeConfirmed') is not True: raise b.Problem('请确认账单仅包含本计算口径的电能、固定合同差额、储能寿命与日运维，排除项已明确')
    for key in ('baselineEvidence','meterEvidence','excludedFactors'):
        if not b.text(data.get(key,''),2000): raise b.Problem('反事实基准依据、实际计量来源及产量/天气等排除因素必须齐全')
    rows=data.get('actualIntervals')
    if not isinstance(rows,list) or len(rows)!=24: raise b.Problem('需要24小时实际负荷、价格、充放电和反事实用电曲线')
    fc=copy.deepcopy(snap['forecast']);actual_grid=[];baseline_grid=[];charge=[];discharge=[]
    p=snap['profile'];energy=p['capacityKwh']*p['socInitial']/100 if p['storageEnabled'] else 0
    energy0=energy;states=[energy];seen=set()
    rows=sorted(rows,key=lambda x:x.get('hour',-1))
    for h,item in enumerate(rows):
        if item.get('hour')!=h or h in seen: raise b.Problem('实际数据必须包含0至23时，不能重复')
        seen.add(h)
        g=b.number(item.get('gridKw'),'实际购电功率');bg=b.number(item.get('baselineGridKw'),'经确认的反事实购电功率')
        price=b.number(item.get('price'),'同口径实际结算参考价格',-100000,100000)
        c=b.number(item.get('chargeKw'),'实际充电功率');dis=b.number(item.get('dischargeKw'),'实际放电功率')
        if g>p['gridLimitKw'] or bg>p['gridLimitKw']: raise b.Problem('实际或反事实并网功率越限')
        if c*dis>1e-5 or (not p['storageEnabled'] and max(c,dis)>0) or max(c,dis)>p['storagePowerKw']:
            raise b.Problem('实际储能互斥/功率校验失败')
        if p['storageEnabled']:
            eta=(p['roundtripEfficiency']/100)**0.5;energy+=c*eta-dis/eta
            if not p['capacityKwh']*p['socMin']/100-1e-5<=energy<=p['capacityKwh']*p['socMax']/100+1e-5: raise b.Problem('实际SOC越限')
        states.append(energy)
        actual_grid.append(g);baseline_grid.append(bg);charge.append(c);discharge.append(dis)
        fc['slots'][h]['predictedPrice']=price
        if p['settlementModel']=='fixed_contract_difference':
            fc['slots'][h]['contractKwh']=b.number(item.get('contractKwh'),'实际合同交割电量')
            fc['slots'][h]['contractPrice']=b.number(item.get('contractPrice'),'实际合同价格',-100000,100000)
    if abs(energy-energy0)>1e-3: raise b.Problem('实际日末SOC未恢复，本口径下不能直接归因差额')
    if abs(sum(actual_grid)-execution['actualKwh'])>0.01: raise b.Problem('逐时电量合计与执行登记不一致')
    _,_,actual=d.cost_slots(fc,p,actual_grid,charge,discharge,snap['taskStarts'],states)
    _,_,counter=d.cost_slots(fc,p,baseline_grid,[0]*24,[0]*24,{t['id']:t['baselineStart'] for t in d.tasks(p)})
    if abs(actual-bill['official_total'])>bill['tolerance']+1e-8: raise b.Problem('实际曲线复算金额与正式账单不符，禁止登记实际节省',409)
    saving=round(counter-bill['official_total'],2)
    payload={**data,'counterfactualCost':counter,'actualCalculatedCost':actual,'officialCost':bill['official_total'],
             'actualSaving':saving,'isDemo':snap.get('isDemo',False),'scope':'日级电能+固定合同差额+寿命+运维；反事实储能空闲',
             'baselineConfirmedBy':a['id'],'sourcePlanFingerprint':row['input_fingerprint']}
    with b.connect() as conn:
        conn.execute('BEGIN IMMEDIATE')
        if conn.execute('SELECT 1 FROM saving_verification WHERE owner_id=? AND plan_id=?',(uid,row['id'])).fetchone(): raise b.Problem('该版本已有核验记录，不能覆盖',409)
        sid=conn.execute('INSERT INTO saving_verification(owner_id,plan_id,bill_id,payload,actual_saving,actor_id,created_at) VALUES(?,?,?,?,?,?,?)',
                         (uid,row['id'],bill_id,json.dumps(payload,ensure_ascii=False),saving,a['id'],b.now())).lastrowid
        log(conn,uid,'ACTUAL_SAVING_VERIFIED',sid,{'planId':row['id'],'billId':bill_id,'actualSaving':saving,'scope':payload['scope']})
    return {'id':sid,**payload}


def long_term(uid,data):
    require(uid,'OWNER','ANALYST')
    month=b.text(data.get('month',''),7)
    try: datetime.strptime(month,'%Y-%m')
    except ValueError: raise b.Problem('请输入规划月份 YYYY-MM')
    demand=b.number(data.get('demandKwh'),'月度需求电量',1,1e12)
    budget=b.number(data.get('budgetYuan'),'月度预算',0,1e12)
    contract=b.number(data.get('contractPrice'),'合同情景单价',-100000,100000)
    risk=b.number(data.get('maxSpotExposurePercent',50),'最大现货敞口',0,100)
    prices={k:b.number(data.get(k),k,-100000,100000) for k in ('spotLow','spotBase','spotHigh')}
    if not prices['spotLow']<=prices['spotBase']<=prices['spotHigh']: raise b.Problem('现货低/中/高情景价格顺序有误')
    source=b.text(data.get('evidence',''),1500)
    if not source: raise b.Problem('请填写月度用电、合同及价格情景依据')
    result=[]
    for ratio in (0,25,50,75,100):
        costs={k:round(demand*(ratio/100*contract+(1-ratio/100)*v)/1000,2) for k,v in prices.items()}
        result.append({'contractCoveragePercent':ratio,'spotExposurePercent':100-ratio,'costs':costs,
                       'withinRisk':100-ratio<=risk,'withinBudget':costs['spotHigh']<=budget})
    payload={**data,'results':result,'profileRevision':b.profile(uid)['revision'],
             'note':'独立月度预算情景，仅含电能费；未建模分时交割/交易资格/输配电/税费，无情景概率，不推算年收益或储能投资回报。'}
    with b.connect() as conn:
        pid=conn.execute('INSERT INTO long_term_plan(owner_id,actor_id,payload,created_at) VALUES(?,?,?,?)',(uid,actor(uid)['id'],json.dumps(payload,ensure_ascii=False),b.now())).lastrowid
        log(conn,uid,'LONG_TERM_SCENARIO',pid,{'month':month,'evidence':source})
    return {'id':pid,**payload}


def list_payloads(uid,table):
    if table not in ('long_term_plan','stress_run','saving_verification','settlement_rule'): raise ValueError(table)
    with b.connect() as conn:
        rows=[dict(r) for r in conn.execute(f'SELECT * FROM {table} WHERE owner_id=? ORDER BY id DESC',(uid,))]
    for row in rows: row['payload']=json.loads(row['payload'])
    return rows


def rule_action(uid,data):
    action=data.get('action','CREATE')
    if action=='APPROVE':
        require(uid,'OWNER','APPROVER');rid=b.integer(data.get('id'),'规则版本ID',1,10**12)
        if not b.text(data.get('note',''),1000): raise b.Problem('规则审核意见不能为空')
        with b.connect() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row=conn.execute('SELECT * FROM settlement_rule WHERE owner_id=? AND id=?',(uid,rid)).fetchone()
            if not row: raise b.Problem('规则不存在',404)
            if row['created_by']==actor(uid)['id']: raise b.Problem('规则录入人与批准人必须分离',403)
            if row['status']!='DRAFT': raise b.Problem('规则版本已审核',409)
            conn.execute("UPDATE settlement_rule SET status='APPROVED',approved_by=? WHERE id=?",(actor(uid)['id'],rid))
            log(conn,uid,'RULE_APPROVED',rid,{'note':b.text(data.get('note',''),1000)})
        return {'ok':True}
    require(uid,'OWNER','FINANCE')
    payload={key:b.text(data.get(key,''),2000) for key in ('name','region','meter','source','validFrom','validTo','scope','formula')}
    if not all(payload.values()): raise b.Problem('规则名称、地区、计量点、有效期、来源、费用范围和公式说明必填')
    if date.fromisoformat(payload['validFrom'])>date.fromisoformat(payload['validTo']): raise b.Problem('规则有效期不正确')
    with b.connect() as conn:
        rid=conn.execute('INSERT INTO settlement_rule(owner_id,payload,created_by,created_at) VALUES(?,?,?,?)',(uid,json.dumps(payload,ensure_ascii=False),actor(uid)['id'],b.now())).lastrowid
        log(conn,uid,'RULE_DRAFTED',rid,payload)
    return {'id':rid,'note':'规则文件与公式说明仅作版本留档；复杂地区结算公式需经专项适配和账单验证，系统不会执行任意公式代码。'}


def evidence(uid,pid=None):
    snap=json.loads(plan_row(uid,pid)['snapshot']) if pid else d.calculate(uid)
    fc=snap['forecast'];p=snap['profile']
    records=[]
    for key,unit,value in [('baselineCost','元',snap['baselineCost']),('optimizedCost','元',snap['optimizedCost']),('saving','元',snap['saving']),('gridLimitKw','kW',p['gridLimitKw'])]:
        records.append({'id':f'E-{pid or "preview"}-{key}','label':key,'value':value,'field':('profile.' if key=='gridLimitKw' else '')+key,
                        'unit':unit,'date':snap.get('planDate'),'meter':p['meter'],'batchIds':fc.get('evidenceBatchIds',[]),
                        'profileRevision':snap['profileRevision'],'forecastVersion':fc.get('modelVersion'),'costModelVersion':d.VERSION,
                        'planId':pid,'calculationId':snap.get('inputFingerprint')})
    common={k:v for k,v in records[0].items() if k not in ('id','label','value','field','unit')}
    for task in d.tasks(p):
        key=task['id']
        records.append({**common,'id':f'E-{pid or "preview"}-task-{key}','label':task['name']+'排程',
                        'field':f'taskStarts.{key}','value':snap.get('taskStarts',{}).get(key),'unit':'北京时间起始小时',
                        'originalStart':task['baselineStart'],'durationHours':task['duration'],'powerKw':task['powerKw'],
                        'equipmentId':task.get('equipmentId'),'predecessors':task.get('predecessors',[])})
    for slot in snap.get('slots',[]):
        hour=slot['hour']
        records.append({**common,'id':f'E-{pid or "preview"}-price-{hour}','label':f'{hour:02d}:00预测价格',
                        'field':f'forecast.slots[{hour}].predictedPrice','value':slot['predictedPrice'],'unit':'元/MWh'})
    return records


def log_ai(uid,pid,question,answer,evidence_records,mode,model):
    with b.connect() as conn:
        xid=conn.execute('INSERT INTO ai_exchange(owner_id,actor_id,plan_id,question,answer,evidence,mode,model,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
                          (uid,actor(uid)['id'],pid,question,answer,json.dumps(evidence_records,ensure_ascii=False),mode,model,b.now())).lastrowid
        log(conn,uid,'AI_EXPLAINED',xid,{'planId':pid,'mode':mode,'evidenceIds':[e.get('id') for e in evidence_records]})
    return xid


def get_endpoint(uid,path,query):
    if path=='/api/devices':
        import telemetry
        return telemetry.summary(uid)
    if path=='/api/telemetry':
        import telemetry
        return telemetry.history(uid,b.text(query.get('deviceId',[''])[0],60))
    if path=='/api/team': return team(uid)
    if path=='/api/alerts': return refresh_alerts(uid)
    if path=='/api/long-term': return {'plans':list_payloads(uid,'long_term_plan')}
    if path=='/api/stress': return {'runs':list_payloads(uid,'stress_run')}
    if path=='/api/savings': return {'records':list_payloads(uid,'saving_verification')}
    if path=='/api/rules': return {'rules':list_payloads(uid,'settlement_rule')}
    if path=='/api/evidence': return {'records':evidence(uid,b.integer(query['planId'][0],'方案ID',1,10**12) if query.get('planId') else None)}
    if path=='/api/ai/history':
        with b.connect() as conn:
            rows=[dict(r) for r in conn.execute('SELECT * FROM ai_exchange WHERE owner_id=? ORDER BY id DESC LIMIT 50',(uid,))]
        for r in rows: r['evidence']=json.loads(r['evidence'])
        return {'records':rows}
    return None


def post_endpoint(uid,path,data):
    authorize(uid,path)
    if path.startswith('/api/devices') or path=='/api/telemetry':
        import telemetry
        if path=='/api/devices': return telemetry.save_device(uid,data)
        if path=='/api/devices/demo': return telemetry.seed_demo(uid)
        if path=='/api/devices/token':
            require(uid,'OWNER')
            return telemetry.rotate_token(uid,b.text(data.get('deviceId',''),60))
        if path=='/api/telemetry': return telemetry.ingest(uid,b.text(data.get('deviceId',''),60),data)
    if path.startswith('/api/team/'): return team_action(uid,path,data)
    if path=='/api/profile': return save_profile(uid,data)
    if path=='/api/import': return import_data(uid,data)
    if path=='/api/plans': return draft(uid,data)
    if path=='/api/plans/review': return review(uid,data)
    if path=='/api/plans/execute': return execute(uid,data)
    if path=='/api/stress': return stress_run(uid,data)
    if path=='/api/savings/verify': return verify_saving(uid,data)
    if path=='/api/long-term': return long_term(uid,data)
    if path=='/api/rules': return rule_action(uid,data)
    if path=='/api/alerts/action': return alert_action(uid,data)
    if path=='/api/alerts/refresh': return refresh_alerts(uid)
    if path=='/api/alerts/rules':
        require(uid,'OWNER');values={key:b.number(data.get(key,value),key,-100000 if key=='priceHigh' else 0,1e9) for key,value in RULE_DEFAULTS.items()}
        with b.connect() as conn:
            conn.execute('INSERT INTO alert_rule(owner_id,payload,updated_at) VALUES(?,?,?) ON CONFLICT(owner_id) DO UPDATE SET payload=excluded.payload,revision=revision+1,updated_at=excluded.updated_at',(uid,json.dumps(values),b.now()))
            log(conn,uid,'ALERT_RULE_UPDATED',uid,values)
        return rules(uid)
    if path=='/api/ai/feedback':
        with b.connect() as conn:
            changed=conn.execute('UPDATE ai_exchange SET feedback=? WHERE owner_id=? AND id=?',(b.text(data.get('feedback',''),1000),uid,b.integer(data.get('id'),'问答编号',1,10**12))).rowcount
            if not changed: raise b.Problem('问答记录不存在',404)
            log(conn,uid,'AI_FEEDBACK',data['id'],{'feedback':data.get('feedback','')})
        return {'ok':True}
    return None
