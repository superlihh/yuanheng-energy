"""Business invariants and authenticated HTTP workflows, using a temporary DB."""
import json
import base64
import io
from zipfile import ZipFile
import math
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'python-service'))
import business as b
import service


class WorkflowTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        service.DB_PATH = b.DB_PATH = Path(cls.tmp.name) / 'test.db'
        service.OPENAI_API_KEY = ''
        service.init_db()
        cls.server = service.ThreadingHTTPServer(('127.0.0.1', 0), service.Handler)
        cls.url = 'http://127.0.0.1:' + str(cls.server.server_port)
        cls.thread = threading.Thread(target=cls.server.serve_forever, daemon=True)
        cls.thread.start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.thread.join()
        import gc
        gc.collect()
        cls.tmp.cleanup()

    def setUp(self):
        self.token = None
        self.user = self.register('owner_' + self._testMethodName)

    def call(self, path, body=None, token='current'):
        headers = {'Content-Type': 'application/json'}
        active = self.token if token == 'current' else token
        if active:
            headers['Authorization'] = 'Bearer ' + active
        req = urllib.request.Request(self.url + path, headers=headers,
            data=None if body is None else json.dumps(body).encode(), method='GET' if body is None else 'POST')
        try:
            with urllib.request.urlopen(req, timeout=40) as res:
                return res.status, json.loads(res.read())
        except urllib.error.HTTPError as exc:
            return exc.code, json.loads(exc.read())

    def register(self, username):
        code, data = self.call('/api/auth/register', {'username': username[:40], 'password': 'test-Password123'}, token=None)
        self.assertEqual(code, 201, data)
        self.token = data['token']
        return data['user']

    def demo(self):
        code, data = self.call('/api/demo', {})
        self.assertEqual(code, 200, data)
        return data

    def confirm(self, bill_id):
        self.assertEqual(self.call('/api/bills/confirm', {'id': bill_id, 'confirmed': True})[0], 200)

    def plan(self):
        code, data = self.call('/api/plans', {})
        self.assertEqual(code, 200, data)
        return data

    def colleague(self, role='APPROVER'):
        owner_token=self.token
        code,invite=self.call('/api/team/invite',{'role':role})
        self.assertEqual(code,200,invite)
        self.register('staff_'+str(self.user['id'])+'_'+role)
        code,result=self.call('/api/team/join',{'code':invite['inviteCode']})
        self.assertEqual(code,200,result)
        colleague_token=self.token
        self.token=owner_token
        return colleague_token

    def submit(self, pid):
        code,result=self.call('/api/plans/review',{'id':pid,'action':'SUBMITTED','note':'确认本次输入与生产约束'})
        self.assertEqual(code,200,result)

    def test_empty_account_and_auth_status(self):
        self.assertEqual(self.call('/api/dashboard', token=None)[0], 401)
        self.assertEqual(self.call('/api/dashboard', token='invalid')[0], 401)
        code, data = self.call('/api/dashboard')
        self.assertEqual(code, 200)
        self.assertIsNone(data['optimization']['saving'])
        self.assertEqual(data['forecast']['slots'], [])
        self.assertEqual(self.call('/api/auth/login', {'username': self.user['username'], 'password': 'wrong'})[0], 401)
        self.assertEqual(self.call('/api/auth/logout', {})[0], 200)
        self.assertEqual(self.call('/api/auth/me')[0], 401)

    def test_production_and_device_roles_have_separate_write_scopes(self):
        production = self.colleague('PRODUCTION')
        device = self.colleague('DEVICE')
        profile = self.call('/api/profile')[1]['values']
        profile.update({'name': '生产角色测试企业', 'meter': 'M-ROLE', 'settlementPoint': 'P-ROLE', 'reviewer': '生产负责人'})
        self.assertEqual(self.call('/api/profile', profile, token=production)[0], 200)
        self.assertEqual(self.call('/api/devices', {
            'deviceId': 'ROLE-METER-01', 'name': '角色测试电表', 'kind': 'METER',
            'line': '流水线A', 'equipmentId': 'ROLE-METER-01', 'source': '测试网关',
            'enabled': True, 'enforce': False, 'ratedPowerKw': 100, 'staleSeconds': 300,
            'socMin': 10, 'socMax': 90, 'temperatureMaxC': 60
        }, token=device)[0], 200)
        self.assertEqual(self.call('/api/devices', {
            'deviceId': 'ROLE-METER-02', 'name': '不应登记的电表', 'kind': 'METER',
            'enabled': True, 'enforce': False, 'ratedPowerKw': 100, 'staleSeconds': 300,
            'socMin': 10, 'socMax': 90, 'temperatureMaxC': 60
        }, token=production)[0], 403)

    def test_bad_import_is_atomic_and_preserves_original(self):
        day = datetime.now(b.CHINA).date().isoformat()
        raw = 'timestamp,price_yuan_mwh,load_kw\n'+f'{day}T00:00,100,500\n{day}T01:00,nan,500\n{day}T00:00,100,500\n'
        code, result = self.call('/api/import', {'filename': 'bad.csv', 'csv': raw})
        self.assertEqual(code, 200)
        self.assertEqual(result['status'], 'REJECTED')
        self.assertEqual(self.call('/api/datasets')[1]['rows'], 0)
        original = self.call(f"/api/import-source?id={result['batchId']}")[1]
        self.assertEqual(original['raw_csv'], raw)
        self.assertEqual(len(original['digest']), 64)

    def test_partial_day_and_negative_prices(self):
        day = datetime.now(b.CHINA).date().isoformat()
        raw = f'timestamp,price_yuan_mwh,load_kw\n{day}T00:00,-50,500\n'
        self.assertEqual(self.call('/api/import', {'csv': raw})[1]['status'], 'ACCEPTED')
        ds = self.call('/api/datasets')[1]
        self.assertEqual(ds['negativePrices'], 1)
        self.assertEqual(len(ds['missingDays'][0]['missingHours']), 23)
        self.assertFalse(self.call('/api/forecast')[1]['slots'])
        self.assertEqual(self.call('/api/import', {'csv': raw})[1]['status'], 'REJECTED')
        self.assertEqual(self.call('/api/demo', {})[0], 409)

    def test_milp_energy_soc_and_cost_balance(self):
        self.demo()
        code, p = self.call('/api/optimize')
        self.assertEqual(code, 200, p)
        self.assertEqual(p['status'], 'FEASIBLE')
        self.assertEqual(len(p['slots']), 24)
        self.assertTrue(p['isDemo'])
        self.assertTrue(all(p['checks'].values()))
        self.assertTrue(p['forecast']['evaluation'])
        self.assertGreater(p['forecast']['evaluation'][0]['testHours'],0)
        self.assertEqual(p['forecast']['validation']['status'],'INDEPENDENT_HOLDOUT')
        self.assertLess(p['forecast']['validation']['selectionEnd'],p['forecast']['validation']['holdoutStart'])
        profile = p['profile']; eta = math.sqrt(profile['roundtripEfficiency']/100)
        energy = profile['capacityKwh']*profile['socInitial']/100
        original = energy
        total_load = sum(s['baselineLoad'] for s in p['slots'])
        process_energy = sum(s['processKw'] for s in p['slots'])
        self.assertAlmostEqual(process_energy, profile['duration']*profile['processKw'], places=3)
        for s in p['slots']:
            self.assertLess(s['charge']*s['discharge'], 0.001)
            energy += s['charge']*eta - s['discharge']/eta
            self.assertAlmostEqual(energy/profile['capacityKwh']*100, s['soc'], delta=.002)
            self.assertGreaterEqual(s['adjustedLoad'], -0.001)
            self.assertLessEqual(s['adjustedLoad'], profile['gridLimitKw']+.001)
        self.assertAlmostEqual(energy, original, delta=.01)
        net = sum(s['charge']-s['discharge'] for s in p['slots'])
        self.assertAlmostEqual(sum(s['adjustedLoad'] for s in p['slots'])-total_load, net, delta=.01)
        self.assertAlmostEqual(sum(s['cost'] for s in p['slots'])+p['breakdown']['maintenanceCost'], p['optimizedCost'], delta=.02)
        self.assertAlmostEqual(p['baselineCost']-p['optimizedCost'], p['saving'], delta=.02)

    def test_review_then_execute_state_machine(self):
        demo = self.demo(); saved = self.plan(); pid = saved['id']
        self.assertEqual(self.call('/api/plans/execute', {'id':pid, 'actualKwh':100, 'note':'meter'})[0],409)
        review = {'id':pid, 'action':'APPROVED', 'note':'已核对生产设备与费用依据'}
        self.assertEqual(self.call('/api/plans/review', review)[0],409)
        self.confirm(demo['billId'])
        self.submit(pid)
        self.assertEqual(self.call('/api/plans/review', review)[0],403)
        reviewer=self.colleague()
        self.assertEqual(self.call('/api/plans/review', review,token=reviewer)[0],200)
        self.assertEqual(self.call('/api/plans/review', review,token=reviewer)[0],409)
        energy = sum(r['adjustedLoad'] for r in saved['plan']['slots'])+25
        self.assertEqual(self.call('/api/plans/execute', {'id':pid,'actualKwh':energy,'note':'测试计量来源，偏差25kWh'})[0],200)
        plan = self.call('/api/plans')[1]['plans'][0]
        self.assertEqual(plan['status'],'EXECUTED')
        self.assertIsNone(plan['execution']['actualSaving'])
        self.assertAlmostEqual(plan['execution']['energyDeviationKwh'],25,places=3)

    def test_profile_revision_blocks_old_draft(self):
        demo=self.demo(); self.confirm(demo['billId']); pid=self.plan()['id']
        reviewer=self.colleague();self.submit(pid)
        profile=self.call('/api/profile')[1]['values']; profile['processKw']=90
        self.assertEqual(self.call('/api/profile',profile)[0],200)
        code,result=self.call('/api/plans/review',{'id':pid,'action':'APPROVED','note':'review'},token=reviewer)
        self.assertEqual(code,409)
        self.assertIn('版本已变化',result['message'])
        code,data=self.call('/api/ask',{'question':'为什么安排工序','planId':pid})
        self.assertEqual(code,200)
        self.assertEqual(data['mode'],'fallback')
        self.assertTrue(all(e['planId']==pid and e['calculationId'] for e in data['evidence']))
        self.assertIn('合成数据演示',data['answer'])

    def test_new_data_blocks_old_draft(self):
        demo=self.demo();self.confirm(demo['billId']); pid=self.plan()['id']
        reviewer=self.colleague();self.submit(pid)
        day=datetime.now(b.CHINA).date().isoformat()
        raw=f'timestamp,price_yuan_mwh,load_kw,contract_kwh,contract_price_yuan_mwh\n{day}T00:00,100,500,300,350\n'
        self.assertEqual(self.call('/api/import',{'csv':raw,'replaceExisting':True})[1]['status'],'ACCEPTED')
        code,data=self.call('/api/plans/review',{'id':pid,'action':'APPROVED','note':'review'},token=reviewer)
        self.assertEqual(code,409)
        self.assertIn('版本已变化',data['message'])

    def test_bill_rounding_and_no_offsetting(self):
        day=datetime.now(b.CHINA).date().isoformat()
        base={'periodStart':day,'periodEnd':day,'evidence':'invoice-test','tolerance':1}
        body={**base,'items':[{'name':'费用A','quantity':1,'unitPrice':100,'officialAmount':90}, {'name':'费用B','quantity':1,'unitPrice':100,'officialAmount':110}]}
        code,data=self.call('/api/bills',body)
        self.assertEqual(code,200)
        self.assertEqual(data['difference'],0)
        self.assertEqual(self.call('/api/bills/confirm',{'id':data['id'],'confirmed':True})[0],409)
        body={**base,'items':[{'name':'rounding','quantity':1,'unitPrice':1.005,'officialAmount':1.01}]}
        data=self.call('/api/bills',body)[1]
        self.assertEqual(data['calculated_total'],1.01)
        self.confirm(data['id'])

    def test_enterprise_ownership_on_every_record(self):
        demo=self.demo();saved=self.plan(); owner_token=self.token
        bid=demo['import']['batchId']; pid=saved['id']
        self.register('other_'+self._testMethodName[:25])
        self.assertEqual(self.call(f'/api/import-source?id={bid}')[0],404)
        self.assertEqual(self.call('/api/ask',{'question':'解释方案','planId':pid})[0],404)
        self.assertEqual(self.call('/api/plans/review',{'id':pid,'action':'REJECTED','note':'x'})[0],404)
        self.assertEqual(self.call('/api/bills/confirm',{'id':demo['billId'],'confirmed':True})[0],404)
        self.assertEqual(self.call('/api/report')[1]['plans'],[])
        self.assertEqual(self.call('/api/dashboard')[1]['workflow']['datasets']['rows'],0)
        self.assertTrue(self.call('/api/plans',token=owner_token)[1]['plans'])

    def test_infeasible_constraints_refuse_saving(self):
        self.demo()
        p=self.call('/api/profile')[1]['values'];p['gridLimitKw']=1
        self.assertEqual(self.call('/api/profile',p)[0],200)
        plan=self.call('/api/optimize')[1]
        self.assertEqual(plan['status'],'INFEASIBLE')
        self.assertEqual(plan['slots'],[])
        self.assertIsNone(plan['saving'])
        self.assertEqual(self.call('/api/plans',{})[0],409)

    def test_numeric_validation_and_report(self):
        self.assertEqual(self.call('/api/profile',{'capacityKwh':float('nan')})[0],400)
        day=datetime.now(b.CHINA).date().isoformat()
        self.assertEqual(self.call('/api/bills',{'periodStart':day,'periodEnd':day,'evidence':'x','items':['wrong']})[0],400)
        self.assertEqual(self.call('/api/ask',{'question':'x','history':{}})[0],400)
        self.demo();self.plan()
        code,report=self.call('/api/report')
        self.assertEqual(code,200)
        self.assertEqual(len(report['plans']),1)
        self.assertTrue(report['quality']['batches'][0]['digest'])
        self.assertTrue(report['events'])
        self.assertNotIn('password_hash',json.dumps(report))

    def test_idle_assets_and_negative_price_dispatch(self):
        self.demo()
        p=self.call('/api/profile')[1]['values']
        p.update(processKw=0,storageEnabled=False)
        self.assertEqual(self.call('/api/profile',p)[0],200)
        plan=self.call('/api/optimize')[1]
        self.assertEqual(plan['saving'],0)
        self.assertIsNone(plan['processStart'])
        code,answer=self.call('/api/ask',{'question':'为什么建议移峰'})
        self.assertEqual(code,200)
        self.assertIn('尚未启用',answer['answer'])
        # All hours negative: storage may absorb losses, but cannot create or
        # deplete opening energy, export power, or charge and discharge at once.
        with b.connect() as conn:
            conn.execute('UPDATE enterprise_interval SET price_yuan_mwh=-200 WHERE user_id=?',(self.user['id'],))
        p['storageEnabled']=True
        self.call('/api/profile',p)
        plan=self.call('/api/optimize')[1]
        self.assertEqual(plan['status'],'FEASIBLE')
        self.assertTrue(all(plan['checks'].values()))
        self.assertTrue(all(s['predictedPrice']<0 for s in plan['slots']))

    def test_five_scenarios_have_one_baseline_and_independent_actions(self):
        self.demo();plan=self.call('/api/optimize')[1]
        scenarios=plan['scenarios'];self.assertEqual([s['code'] for s in scenarios],['S0','S1','S2','S3','S4'])
        base=scenarios[0]['cost']
        for s in scenarios:
            self.assertEqual(s['status'],'FEASIBLE',s.get('message'))
            self.assertEqual(len(s['slots']),24)
            self.assertEqual(s['baselineCost'],base)
            self.assertAlmostEqual(s['saving'],base-s['cost'],places=2)
            self.assertTrue(s['inputFingerprint'])
        self.assertEqual(scenarios[1]['cost'],base)
        self.assertIn('合同量未优化',scenarios[1]['message'])
        self.assertTrue(all(x['charge']==0 and x['discharge']==0 for x in scenarios[2]['slots']))
        self.assertEqual(scenarios[3]['processStart'],plan['profile']['baselineStart'])
        self.assertLessEqual(scenarios[4]['cost'],min(scenarios[2]['cost'],scenarios[3]['cost'])+.02)

    def test_missing_inputs_affect_only_relevant_scenario(self):
        self.demo();profile=self.call('/api/profile')[1]['values']
        profile.update(storageEnabled=False)
        self.call('/api/profile',profile)
        s=self.call('/api/optimize')[1]['scenarios']
        self.assertEqual(s[3]['status'],'NOT_APPLICABLE');self.assertIsNone(s[3]['cost'])
        self.assertEqual(s[2]['status'],'FEASIBLE')
        profile.update(storageEnabled=True,storageParametersConfirmed=False)
        self.call('/api/profile',profile)
        s=self.call('/api/optimize')[1]['scenarios']
        self.assertEqual(s[0]['status'],'FEASIBLE');self.assertEqual(s[2]['status'],'FEASIBLE')
        self.assertEqual(s[3]['status'],'DATA_REQUIRED');self.assertIsNone(s[3]['saving'])

    def test_quarter_hour_aggregation_preserves_energy_and_cost(self):
        day=(datetime.now(b.CHINA).date()).isoformat()
        lines=['timestamp,price_yuan_mwh,load_kw,contract_kwh,contract_price_yuan_mwh']
        values=[(100,100,5,300),(200,200,10,310),(300,300,15,320),(400,400,20,330)]
        for i,(price,load,c,cp) in enumerate(values): lines.append(f'{day}T00:{i*15:02},{price},{load},{c},{cp}')
        raw='\n'.join(lines)
        code,result=self.call('/api/import',{'csv':raw,'metadata':{'intervalMinutes':15,'source':'test meter'}})
        self.assertEqual(code,200,result);self.assertEqual(result['status'],'ACCEPTED')
        with b.connect() as conn: row=conn.execute('SELECT * FROM enterprise_interval WHERE user_id=?',(self.user['id'],)).fetchone()
        self.assertAlmostEqual(row['load_kw'],sum(v[1]*.25 for v in values))
        cost=row['load_kw']*row['price_yuan_mwh']/1000+row['contract_kwh']*(row['contract_price_yuan_mwh']-row['price_yuan_mwh'])/1000
        expected=sum(load*.25*price/1000+c*(cp-price)/1000 for price,load,c,cp in values)
        self.assertAlmostEqual(cost,expected)
        self.assertEqual(self.call(f"/api/import-source?id={result['batchId']}")[1]['raw_csv'],raw)
        bad=self.call('/api/import',{'csv':'\n'.join(lines[:3]),'metadata':{'intervalMinutes':15}})[1]
        self.assertEqual(bad['status'],'REJECTED')
        self.assertEqual(self.call('/api/datasets')[1]['rows'],1)

    def test_alert_deduplication_and_blocking_cannot_be_ignored(self):
        one=self.call('/api/alerts')[1];two=self.call('/api/alerts')[1]
        self.assertEqual(len(one['records']),len(two['records']))
        aid=one['records'][0]['id']
        self.assertEqual(self.call('/api/alerts/action',{'id':aid,'action':'IGNORE','note':'bypass'})[0],409)
        self.assertEqual(self.call('/api/alerts/action',{'id':aid,'action':'ACKNOWLEDGE','note':'checking'})[0],200)
        self.demo();updated=self.call('/api/alerts')[1]
        self.assertEqual(next(r for r in updated['records'] if r['id']==aid)['status'],'RESOLVED')
        self.assertTrue(any(e['event_type']=='ALERT_AUTO_RESOLVED' for e in self.call('/api/events')[1]['events']))

    def test_team_role_revocation_and_cross_enterprise_isolation(self):
        self.demo();pid=self.plan()['id'];viewer=self.colleague('VIEWER')
        self.assertEqual(self.call('/api/plans',{},token=viewer)[0],403)
        self.assertEqual(self.call('/api/plans',token=viewer)[1]['plans'][0]['id'],pid)
        self.assertEqual(self.call('/api/plans/review',{'id':pid,'action':'APPROVED','note':'no permission'},token=viewer)[0],403)
        me=self.call('/api/auth/me',token=viewer)[1]['user']
        self.call('/api/team/revoke',{'userId':me['id']})
        self.assertEqual(self.call('/api/plans',token=viewer)[1]['plans'],[])

    def test_fixed_stress_and_reoptimization_keep_parent_immutable(self):
        self.demo();saved=self.plan();pid=saved['id'];before=self.call('/api/plans')[1]['plans'][0]['snapshot']
        fixed=self.call('/api/stress',{'planId':pid,'priceDelta':25,'baseLoadPercent':10})[1]
        self.assertEqual(fixed['mode'],'FIXED')
        self.assertAlmostEqual(fixed['candidate']['saving'],fixed['baseline']['cost']-fixed['candidate']['cost'],places=2)
        child=self.call('/api/stress',{'planId':pid,'mode':'REOPTIMIZE','baseLoadPercent':10})[1]
        self.assertTrue(child['childId'])
        plans=self.call('/api/plans')[1]['plans'];parent=next(p for p in plans if p['id']==pid)
        self.assertEqual(parent['snapshot'],before)
        self.assertEqual(plans[0]['parent_id'],pid);self.assertEqual(plans[0]['status'],'DRAFT')
        self.assertEqual(self.call('/api/plans/review',{'id':child['childId'],'action':'SUBMITTED','note':'hypothetical inputs'})[0],409)
        bad=self.call('/api/stress',{'planId':pid,'baseLoadPercent':200})[1]
        self.assertEqual(bad['candidate']['status'],'INFEASIBLE');self.assertIsNone(bad['candidate']['cost'])

    def test_multitask_precedence_and_cycle_rejection(self):
        self.demo();profile=self.call('/api/profile')[1]['values']
        profile['tasks']=[{'id':'a','name':'A','powerKw':30,'duration':2,'baselineStart':16,'windowStart':0,'windowEnd':24,'forbiddenHours':[],'predecessors':[]},
                          {'id':'b','name':'B','powerKw':30,'duration':2,'baselineStart':18,'windowStart':0,'windowEnd':24,'forbiddenHours':[12],'predecessors':['a']}]
        self.assertEqual(self.call('/api/profile',profile)[0],200)
        result=self.call('/api/optimize')[1]
        self.assertEqual(result['status'],'FEASIBLE')
        self.assertGreaterEqual(result['taskStarts']['b'],result['taskStarts']['a']+2)
        self.assertNotIn(12,range(result['taskStarts']['b'],result['taskStarts']['b']+2))
        profile['tasks'][0]['predecessors']=['b']
        self.assertEqual(self.call('/api/profile',profile)[0],400)

    def test_actual_savings_require_bill_intervals_and_separate_finance(self):
        demo=self.demo();self.confirm(demo['billId']);saved=self.plan();pid=saved['id'];self.submit(pid)
        reviewer=self.colleague();self.assertEqual(self.call('/api/plans/review',{'id':pid,'action':'APPROVED','note':'checked'},token=reviewer)[0],200)
        snap=saved['plan'];energy=sum(s['adjustedLoad'] for s in snap['slots'])
        self.assertEqual(self.call('/api/plans/execute',{'id':pid,'actualKwh':energy,'note':'demo meter'})[0],200)
        finance=self.colleague('FINANCE');day=snap['planDate']
        cost=snap['optimizedCost']
        code,bill=self.call('/api/bills',{'periodStart':day,'periodEnd':day,'evidence':'DEMO-DAY-BILL same cost scope', 'tolerance':.02,
                           'items':[{'name':'demo total','quantity':1,'unitPrice':cost,'officialAmount':cost}]},token=finance)
        self.assertEqual(code,200,bill)
        self.assertEqual(self.call('/api/bills/confirm',{'id':bill['id'],'confirmed':True},token=finance)[0],200)
        rows=[{'hour':h,'gridKw':s['adjustedLoad'],'baselineGridKw':s['baselineLoad'],'price':s['predictedPrice'],
               'chargeKw':s['charge'],'dischargeKw':s['discharge'],'contractKwh':s['contractKwh'],'contractPrice':s['contractPrice']} for h,s in enumerate(snap['slots'])]
        payload={'planId':pid,'billId':bill['id'],'scopeConfirmed':True,'baselineEvidence':'confirmed original schedule',
                 'meterEvidence':'demo meter','excludedFactors':'same demo production and weather','actualIntervals':rows}
        self.assertEqual(self.call('/api/savings/verify',payload)[0],403)
        missing={**payload,'actualIntervals':rows[:3]}
        self.assertEqual(self.call('/api/savings/verify',missing,token=finance)[0],400)
        code,result=self.call('/api/savings/verify',payload,token=finance)
        self.assertEqual(code,200,result);self.assertAlmostEqual(result['actualSaving'],snap['saving'],delta=.02)
        self.assertTrue(result['isDemo'])
        self.assertEqual(self.call('/api/savings/verify',payload,token=finance)[0],409)

    def test_ai_evidence_is_frozen_and_question_is_logged(self):
        self.demo();saved=self.plan();pid=saved['id'];pr=self.call('/api/profile')[1]['values'];pr['processKw']=80;self.call('/api/profile',pr)
        code,result=self.call('/api/ask',{'question':'如果基础负荷增加10%会怎样','planId':pid})
        self.assertEqual(code,200,result);self.assertIn('尚未重算',result['answer'])
        self.assertTrue(all(e['profileRevision']==saved['plan']['profileRevision'] for e in result['evidence']))
        self.assertEqual(self.call('/api/ai/history')[1]['records'][0]['id'],result['id'])
        self.assertEqual(self.call('/api/ai/feedback',{'id':result['id'],'feedback':'need more explanation'})[0],200)

    def test_excel_and_json_preserve_original_and_reject_formulas(self):
        day=datetime.now(b.CHINA).date().isoformat()
        records=[{'timestamp':day+'T00:00','price_yuan_mwh':-10,'load_kw':100}]
        raw=json.dumps(records,indent=2)
        code,result=self.call('/api/import',{'format':'json','filename':'source.json','records':records,'rawJson':raw})
        self.assertEqual(code,200,result)
        self.assertEqual(self.call(f"/api/import-source?id={result['batchId']}")[1]['raw_csv'],raw)
        def xlsx(formula=False):
            stream=io.BytesIO()
            with ZipFile(stream,'w') as z:
                z.writestr('xl/workbook.xml','<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="data" sheetId="1" r:id="rId1"/></sheets></workbook>')
                z.writestr('xl/_rels/workbook.xml.rels','<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
                values=['timestamp','price_yuan_mwh','load_kw']
                header=''.join(f'<c r="{chr(65+i)}1" t="inlineStr"><is><t>{v}</t></is></c>' for i,v in enumerate(values))
                price='<f>1+1</f><v>2</v>' if formula else '<v>-20</v>'
                z.writestr('xl/worksheets/sheet1.xml',f'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">{header}</row><row r="2"><c r="A2" t="inlineStr"><is><t>{day}T01:00</t></is></c><c r="B2">{price}</c><c r="C2"><v>150</v></c></row></sheetData></worksheet>')
            return base64.b64encode(stream.getvalue()).decode()
        encoded=xlsx()
        code,result=self.call('/api/import',{'format':'xlsx','filename':'meter.xlsx','base64':encoded})
        self.assertEqual(code,200,result);self.assertEqual(result['status'],'ACCEPTED')
        source=self.call(f"/api/import-source?id={result['batchId']}")[1]
        self.assertEqual(source['raw_csv'],encoded);self.assertEqual(source['metadata']['rawEncoding'],'base64')
        self.assertEqual(self.call('/api/import',{'format':'xlsx','base64':xlsx(True)})[0],400)

    def test_shared_equipment_exclusion_and_parallel_approval(self):
        demo=self.demo();self.confirm(demo['billId']);profile=self.call('/api/profile')[1]['values']
        profile['tasks']=[{'id':'a','name':'line A batch','equipmentId':'SHARED-01','powerKw':30,'duration':3,'baselineStart':5,'windowStart':0,'windowEnd':24,'forbiddenHours':[],'predecessors':[]},
                          {'id':'b','name':'line B batch','equipmentId':'SHARED-01','powerKw':30,'duration':3,'baselineStart':8,'windowStart':0,'windowEnd':24,'forbiddenHours':[],'predecessors':[]}]
        self.assertEqual(self.call('/api/profile',profile)[0],200)
        plan=self.plan();starts=plan['plan']['taskStarts']
        self.assertFalse(set(range(starts['a'],starts['a']+3)) & set(range(starts['b'],starts['b']+3)))
        self.submit(plan['id']);reviewer=self.colleague();results=[];barrier=threading.Barrier(2)
        def approve():
            barrier.wait()
            results.append(self.call('/api/plans/review',{'id':plan['id'],'action':'APPROVED','note':'concurrent review'},token=reviewer)[0])
        threads=[threading.Thread(target=approve) for _ in range(2)]
        for t in threads:t.start()
        for t in threads:t.join()
        self.assertEqual(sorted(results),[200,409])

    def test_monthly_budget_and_rule_approval_are_separate_from_dispatch(self):
        self.demo();original=self.plan()['plan']
        code,result=self.call('/api/long-term',{'month':'2026-11','demandKwh':100000,'budgetYuan':50000,'contractPrice':350,
                 'maxSpotExposurePercent':50,'spotLow':200,'spotBase':400,'spotHigh':800,'evidence':'monthly production and quote example'})
        self.assertEqual(code,200,result);self.assertEqual(len(result['results']),5)
        self.assertEqual(result['results'][-1]['costs']['spotHigh'],35000)
        self.assertFalse(result['results'][0]['withinBudget'])
        self.assertEqual(self.call('/api/plans')[1]['plans'][0]['snapshot'],original)
        rule=self.call('/api/rules',{'name':'test scope','region':'Shanxi','meter':'DEMO-001','source':'example rule source',
                                   'validFrom':'2026-10-01','validTo':'2026-12-31','scope':'analytical energy only','formula':'kWh * yuan/MWh / 1000'})[1]
        approve={'action':'APPROVE','id':rule['id'],'note':'checked reference'}
        self.assertEqual(self.call('/api/rules',approve)[0],403)
        reviewer=self.colleague();self.assertEqual(self.call('/api/rules',approve,token=reviewer)[0],200)


    def register_device(self, key='METER-01', **extra):
        data={'deviceId':key,'name':'test device','kind':'METER','ratedPowerKw':500,'staleSeconds':300,**extra}
        code,result=self.call('/api/devices',data)
        self.assertEqual(code,200,result)
        return data

    def point(self, seconds=0, **values):
        return {'timestamp':(datetime.now(b.CHINA)+timedelta(seconds=seconds)).isoformat(), 'quality':'GOOD','values':values or {'powerKw':100}}

    def test_device_isolation_rbac_and_token_redaction(self):
        self.register_device();viewer=self.colleague('VIEWER')
        self.assertEqual(self.call('/api/devices',{},token=viewer)[0],403)
        code,rows=self.call('/api/devices');self.assertEqual(code,200)
        self.assertNotIn('token_hash',json.dumps(rows));self.assertEqual(rows['devices'][0]['status'],'NO_DATA')
        self.register('another_device_enterprise')
        self.assertEqual(self.call('/api/devices')[1]['devices'],[])
        self.assertEqual(self.call('/api/telemetry?deviceId=METER-01')[0],404)

    def test_device_batches_are_atomic_idempotent_and_ordered(self):
        self.register_device();first=self.point(-20,powerKw=100);second=self.point(-10,powerKw=120)
        payload={'deviceId':'METER-01','source':'test meter','points':[second,first]}
        code,result=self.call('/api/telemetry',payload);self.assertEqual(code,200,result);self.assertEqual(result['inserted'],2)
        self.assertEqual(self.call('/api/telemetry',payload)[1]['status'],'DUPLICATE')
        history=self.call('/api/telemetry?deviceId=METER-01')[1]
        self.assertEqual([p['values']['powerKw'] for p in history['points']],[100,120])
        conflict={**second,'values':{'powerKw':130}}
        self.assertEqual(self.call('/api/telemetry',{'deviceId':'METER-01','points':[self.point(),conflict]})[0],409)
        self.assertEqual(len(self.call('/api/telemetry?deviceId=METER-01')[1]['points']),2)
        self.assertEqual(self.call('/api/telemetry',{'deviceId':'METER-01','points':[self.point(600)]})[0],400)

    def test_gateway_credentials_are_device_scoped_rotatable_and_not_user_sessions(self):
        self.register_device();self.register_device('METER-02')
        token=self.call('/api/devices/token',{'deviceId':'METER-01'})[1]['token']
        body={'points':[self.point()]}
        self.assertEqual(self.call('/api/gateway/telemetry',body,token=None)[0],401)
        self.assertEqual(self.call('/api/gateway/telemetry',body)[0],401)
        self.assertEqual(self.call('/api/gateway/telemetry',{**body,'deviceId':'METER-02'},token=token)[0],403)
        self.assertEqual(self.call('/api/gateway/telemetry',body,token=token)[0],200)
        self.assertEqual(self.call('/api/devices',token=token)[0],401)
        report=json.dumps(self.call('/api/report')[1]);self.assertNotIn(token,report)
        new=self.call('/api/devices/token',{'deviceId':'METER-01'})[1]['token']
        self.assertNotEqual(new,token)
        self.assertEqual(self.call('/api/gateway/telemetry',body,token=token)[0],401)
        self.assertEqual(self.call('/api/gateway/telemetry',body,token=new)[0],200)

    def test_critical_device_health_blocks_approval_and_execution_without_changing_prediction(self):
        demo=self.demo();self.confirm(demo['billId'])
        self.register_device('PLC-01',kind='PLC',enforce=True)
        saved=self.plan();pid=saved['id'];fingerprint=saved['plan']['inputFingerprint']
        self.assertEqual(self.call('/api/plans/review',{'id':pid,'action':'SUBMITTED','note':'missing device data'})[0],409)
        initial=self.point(0,state='RUNNING',powerKw=100)
        self.assertEqual(self.call('/api/telemetry',{'deviceId':'PLC-01','points':[initial]})[0],200)
        self.assertEqual(self.call('/api/optimize')[1]['inputFingerprint'],fingerprint)
        self.submit(pid);reviewer=self.colleague()
        bad=self.point(1,state='FAULT',powerKw=0)
        self.call('/api/telemetry',{'deviceId':'PLC-01','points':[bad]})
        self.assertEqual(self.call('/api/plans/review',{'id':pid,'action':'APPROVED','note':'fault exists'},token=reviewer)[0],409)
        self.call('/api/telemetry',{'deviceId':'PLC-01','points':[self.point(2,state='RUNNING',powerKw=100)]})
        self.assertEqual(self.call('/api/plans/review',{'id':pid,'action':'APPROVED','note':'device recovered'},token=reviewer)[0],200)
        self.call('/api/telemetry',{'deviceId':'PLC-01','points':[self.point(3,state='FAULT',powerKw=0)]})
        self.assertEqual(self.call('/api/plans/execute',{'id':pid,'actualKwh':10000,'note':'fault blocks execution'})[0],409)
        self.call('/api/telemetry',{'deviceId':'PLC-01','points':[self.point(4,state='IDLE',powerKw=0)]})
        self.assertEqual(self.call('/api/plans/execute',{'id':pid,'actualKwh':10000,'note':'recovered, test only'})[0],200)

    def test_device_quality_staleness_nulls_and_guard_version(self):
        self.demo();self.register_device('ESS-01',kind='STORAGE',enforce=True)
        snap=self.plan()['plan'];old=self.point(-600,powerKw=0,soc=50);old['quality']='BAD'
        self.call('/api/telemetry',{'deviceId':'ESS-01','points':[old]})
        info=self.call('/api/devices')[1]['devices'][0]
        self.assertEqual(info['status'],'STALE');self.assertNotIn('temperatureC',info['latest']['values'])
        first=self.call('/api/alerts')[1];self.assertEqual(len(first['records']),len(self.call('/api/alerts')[1]['records']))
        self.assertTrue(any(r['level']=='BLOCKING' and r['details'].get('deviceId')=='ESS-01' for r in first['records']))
        self.register_device('ESS-01',kind='STORAGE',enforce=True,ratedPowerKw=300)
        self.assertNotEqual(snap['inputFingerprint'],self.call('/api/optimize')[1]['inputFingerprint'])
        self.assertEqual(self.call('/api/telemetry',{'deviceId':'ESS-01','points':[self.point(soc=None,powerKw=0)]})[0],400)
        self.assertEqual(self.call('/api/telemetry',{'deviceId':'ESS-01','points':[self.point(soc=50,powerKw=0,state=[])]})[0],400)

    def test_device_demo_stays_outside_billing_and_does_not_block_dispatch(self):
        self.demo();before=self.call('/api/datasets')[1]['rows'];plan=self.call('/api/optimize')[1]
        code,devices=self.call('/api/devices/demo',{});self.assertEqual(code,200,devices)
        self.assertEqual(devices['counts']['demo'],5);self.assertEqual(self.call('/api/datasets')[1]['rows'],before)
        self.assertEqual(self.call('/api/optimize')[1]['inputFingerprint'],plan['inputFingerprint'])
        self.assertEqual(self.call('/api/devices/token',{'deviceId':'ESS-01'})[0],409)
        alerts=self.call('/api/alerts')[1]
        device_alerts=[r for r in alerts['records'] if r['details'].get('deviceId')]
        self.assertTrue(device_alerts);self.assertTrue(all(r['level']!='BLOCKING' and r['details']['mode']=='DEMO' for r in device_alerts))


if __name__=='__main__':
    unittest.main()
