PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS market_daily (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_date TEXT NOT NULL UNIQUE,
    day_ahead_volume_mwh REAL NOT NULL,
    day_ahead_avg_price REAL NOT NULL,
    realtime_volume_mwh REAL NOT NULL,
    realtime_avg_price REAL NOT NULL,
    source_title TEXT,
    source_url TEXT,
    captured_at TEXT
);

CREATE TABLE IF NOT EXISTS load_profile (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    profile_date TEXT NOT NULL,
    slot TEXT NOT NULL,
    load_kw REAL NOT NULL,
    shiftable_kw REAL DEFAULT 0,
    UNIQUE(profile_date, slot)
);

CREATE TABLE IF NOT EXISTS forecast_run (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    forecast_date TEXT NOT NULL,
    slot TEXT NOT NULL,
    predicted_price REAL NOT NULL,
    predicted_load_kw REAL,
    model_name TEXT NOT NULL,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS dispatch_plan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    plan_date TEXT NOT NULL,
    slot TEXT NOT NULL,
    baseline_load_kw REAL NOT NULL,
    adjusted_load_kw REAL NOT NULL,
    charge_kw REAL DEFAULT 0,
    discharge_kw REAL DEFAULT 0,
    expected_cost REAL NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT'
);

CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    entity_id TEXT,
    detail TEXT,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS app_user (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    email TEXT,
    role TEXT NOT NULL DEFAULT 'ENTERPRISE_USER',
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_session (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (user_id) REFERENCES app_user(id) ON DELETE CASCADE
);

-- Enterprise records are scoped to the signed-in owner. Public market data is shared.
CREATE TABLE IF NOT EXISTS enterprise_profile (
    user_id INTEGER PRIMARY KEY REFERENCES app_user(id),
    payload TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_batch (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES app_user(id),
    filename TEXT NOT NULL,
    digest TEXT NOT NULL,
    raw_csv TEXT NOT NULL,
    status TEXT NOT NULL,
    row_count INTEGER NOT NULL,
    issues TEXT NOT NULL,
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS enterprise_interval (
    user_id INTEGER NOT NULL REFERENCES app_user(id),
    timestamp TEXT NOT NULL,
    price_yuan_mwh REAL NOT NULL,
    load_kw REAL NOT NULL,
    temperature_c REAL,
    renewable_kw REAL,
    contract_kwh REAL,
    contract_price_yuan_mwh REAL,
    batch_id INTEGER NOT NULL REFERENCES import_batch(id),
    PRIMARY KEY(user_id, timestamp)
);
CREATE TABLE IF NOT EXISTS business_plan (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES app_user(id),
    plan_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'DRAFT',
    snapshot TEXT NOT NULL,
    review_note TEXT,
    reviewed_at TEXT,
    execution TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS bill_reconciliation (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES app_user(id),
    period_start TEXT NOT NULL,
    period_end TEXT NOT NULL,
    evidence TEXT NOT NULL,
    items TEXT NOT NULL,
    calculated_total REAL NOT NULL,
    official_total REAL NOT NULL,
    difference REAL NOT NULL,
    tolerance REAL NOT NULL,
    status TEXT NOT NULL,
    confirmed_at TEXT,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS enterprise_event (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES app_user(id),
    event_type TEXT NOT NULL,
    entity_id TEXT,
    detail TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_plan_owner ON business_plan(user_id, id);
CREATE INDEX IF NOT EXISTS idx_bill_owner ON bill_reconciliation(user_id, id);
CREATE INDEX IF NOT EXISTS idx_event_owner ON enterprise_event(user_id, id);

-- user_id in legacy business tables is the workspace owner id.
CREATE TABLE IF NOT EXISTS workspace_member (owner_id INTEGER NOT NULL REFERENCES app_user(id),user_id INTEGER NOT NULL REFERENCES app_user(id),role TEXT NOT NULL,active INTEGER NOT NULL DEFAULT 1,PRIMARY KEY(owner_id,user_id));
CREATE TABLE IF NOT EXISTS workspace_invite (token_hash TEXT PRIMARY KEY,owner_id INTEGER NOT NULL,role TEXT NOT NULL,created_by INTEGER NOT NULL,expires_at TEXT NOT NULL,used_by INTEGER,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS workspace_selection (user_id INTEGER PRIMARY KEY,owner_id INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS import_metadata (batch_id INTEGER PRIMARY KEY REFERENCES import_batch(id),payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alert_rule (owner_id INTEGER PRIMARY KEY,revision INTEGER NOT NULL DEFAULT 1,payload TEXT NOT NULL,updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS alert_record (
 id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id INTEGER NOT NULL,alert_key TEXT NOT NULL,version_key TEXT NOT NULL,
 category TEXT NOT NULL,level TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'OPEN',title TEXT NOT NULL,details TEXT NOT NULL,
 assigned_to TEXT NOT NULL DEFAULT '',due_at TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,closed_at TEXT,resolution TEXT,
 UNIQUE(owner_id,alert_key,version_key));
CREATE TABLE IF NOT EXISTS alert_action (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id INTEGER NOT NULL,alert_id INTEGER NOT NULL,actor_id INTEGER NOT NULL,action TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS stress_run (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id INTEGER NOT NULL,plan_id INTEGER NOT NULL,actor_id INTEGER NOT NULL,payload TEXT NOT NULL,child_id INTEGER,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS saving_verification (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id INTEGER NOT NULL,plan_id INTEGER NOT NULL UNIQUE,bill_id INTEGER NOT NULL,payload TEXT NOT NULL,actual_saving REAL NOT NULL,actor_id INTEGER NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS long_term_plan (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id INTEGER NOT NULL,actor_id INTEGER NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settlement_rule (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id INTEGER NOT NULL,payload TEXT NOT NULL,created_by INTEGER NOT NULL,approved_by INTEGER,status TEXT NOT NULL DEFAULT 'DRAFT',created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_exchange (id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id INTEGER NOT NULL,actor_id INTEGER NOT NULL,plan_id INTEGER,question TEXT NOT NULL,answer TEXT NOT NULL,evidence TEXT NOT NULL,mode TEXT NOT NULL,model TEXT NOT NULL,feedback TEXT,created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS ai_usage (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 owner_id INTEGER NOT NULL REFERENCES app_user(id),
 actor_id INTEGER NOT NULL REFERENCES app_user(id),
 request_id TEXT NOT NULL UNIQUE,
 model TEXT NOT NULL,
 request_type TEXT NOT NULL,
 is_deep INTEGER NOT NULL DEFAULT 0,
 is_document INTEGER NOT NULL DEFAULT 0,
 input_tokens INTEGER NOT NULL DEFAULT 0,
 output_tokens INTEGER NOT NULL DEFAULT 0,
 total_tokens INTEGER NOT NULL DEFAULT 0,
 started_at TEXT NOT NULL,
 ended_at TEXT NOT NULL,
 latency_ms INTEGER NOT NULL DEFAULT 0,
 status TEXT NOT NULL,
 error_type TEXT NOT NULL DEFAULT '',
 blocked_reason TEXT NOT NULL DEFAULT '',
 created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_owner_time ON ai_usage(owner_id,started_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_time ON ai_usage(started_at);
CREATE INDEX IF NOT EXISTS idx_alert_owner ON alert_record(owner_id,status);
CREATE TRIGGER IF NOT EXISTS enterprise_event_no_update BEFORE UPDATE ON enterprise_event BEGIN SELECT RAISE(ABORT,'audit records are append only'); END;
CREATE TRIGGER IF NOT EXISTS enterprise_event_no_delete BEFORE DELETE ON enterprise_event BEGIN SELECT RAISE(ABORT,'audit records are append only'); END;

CREATE TABLE IF NOT EXISTS device_registry (
 owner_id INTEGER NOT NULL REFERENCES app_user(id),device_id TEXT NOT NULL,name TEXT NOT NULL,
 kind TEXT NOT NULL,mode TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,payload TEXT NOT NULL,
 token_hash TEXT UNIQUE,token_expires TEXT,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,device_id));
CREATE TABLE IF NOT EXISTS device_ingest_batch (
 id INTEGER PRIMARY KEY AUTOINCREMENT,owner_id INTEGER NOT NULL,device_id TEXT NOT NULL,
 digest TEXT NOT NULL,source TEXT NOT NULL,raw_payload TEXT NOT NULL,row_count INTEGER NOT NULL,
 received_at TEXT NOT NULL,UNIQUE(owner_id,device_id,digest),
 FOREIGN KEY(owner_id,device_id) REFERENCES device_registry(owner_id,device_id));
CREATE TABLE IF NOT EXISTS device_sample (
 owner_id INTEGER NOT NULL,device_id TEXT NOT NULL,timestamp TEXT NOT NULL,quality TEXT NOT NULL,
 values_json TEXT NOT NULL,batch_id INTEGER NOT NULL REFERENCES device_ingest_batch(id),received_at TEXT NOT NULL,
 PRIMARY KEY(owner_id,device_id,timestamp),
 FOREIGN KEY(owner_id,device_id) REFERENCES device_registry(owner_id,device_id));
CREATE INDEX IF NOT EXISTS idx_device_time ON device_sample(owner_id,device_id,timestamp DESC);
