import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Each test file runs in its own process, so this throwaway DB is isolated.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ivx-mig-'));
process.env.DB_PATH = path.join(tmp, 'm.db'); process.env.STORAGE_DIR = tmp; process.env.NODE_ENV = 'test'; process.env.SUPER_ADMIN_PASSWORD = 'Test-Password-123!';

let db: any, ensureSeed: any, runMigrations: any, syncPlansFromLegacy: any, MIGRATIONS: any, FEATURES: any, CATEGORIES: any, LIMITS: any, uid: any, now: any;
before(async () => {
  ({ db, uid, now } = await import('../src/db.js'));
  ({ ensureSeed } = await import('../src/seed.js'));
  ({ runMigrations, syncPlansFromLegacy, MIGRATIONS } = await import('../src/migrations/index.js'));
  ({ FEATURES, CATEGORIES, LIMITS } = await import('../src/migrations/catalog.js'));
  ensureSeed();
});

const tables = () => (db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as any[]).map(r => r.name);
const plan = (code: string) => db.prepare('SELECT id FROM plans WHERE code=?').get(code) as any;
const featuresOf = (code: string) => new Set((db.prepare('SELECT feature_key k FROM plan_features WHERE plan_id=?').all(plan(code).id) as any[]).map(r => r.k));
const limitOf = (code: string, k: string) => (db.prepare('SELECT value FROM plan_limits WHERE plan_id=? AND limit_key=?').get(plan(code).id, k) as any).value;
const mkCompany = (name: string) => { const id = uid(); db.prepare('INSERT INTO companies(id,name,slug,created_at) VALUES (?,?,?,?)').run(id, name, name.toLowerCase() + '-' + id.slice(0, 6), now()); return id; };

test('migrations are recorded, in order, once', () => {
  const rows = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map((r: any) => r.version);
  assert.deepEqual(rows, MIGRATIONS.map((m: any) => m.version));
  assert.deepEqual(runMigrations(db), [], 'a second run applies nothing');
});

test('new tables exist and existing tables gained the provisioning columns', () => {
  for (const t of ['features', 'plan_features', 'company_feature_overrides', 'temporary_feature_grants', 'limit_definitions', 'plan_limits', 'company_limit_overrides', 'internal_staff', 'invitations', 'schema_migrations'])
    assert.ok(tables().includes(t), `missing table ${t}`);
  const cols = (t: string) => (db.prepare(`PRAGMA table_info(${t})`).all() as any[]).map(c => c.name);
  for (const c of ['email', 'contact_person', 'contact_phone', 'country', 'address', 'logo_key', 'employee_count', 'deactivated_at']) assert.ok(cols('companies').includes(c), `companies.${c}`);
  for (const c of ['custom_price_monthly', 'custom_price_yearly', 'discount_percent', 'suspended_at']) assert.ok(cols('subscriptions').includes(c), `subscriptions.${c}`);
});

test('feature catalog covers every category from the spec and marks unbuilt features', () => {
  const rows = db.prepare('SELECT key, category, implemented FROM features').all() as any[];
  assert.equal(rows.length, FEATURES.length);
  assert.equal(new Set(rows.map(r => r.category)).size, CATEGORIES.length);
  assert.equal(new Set(rows.map(r => r.key)).size, rows.length, 'keys are unique');
  for (const k of ['company.team_management', 'coding.editor', 'live.recording', 'ai.questions', 'analytics.export', 'integrations.webhooks', 'security.sso']) assert.ok(rows.some(r => r.key === k), k);
  assert.equal(rows.find(r => r.key === 'security.sso').implemented, 0, 'SSO is not built and must not be presented as available');
  assert.equal(rows.find(r => r.key === 'live.recording').implemented, 1);
});

test('plans are backfilled from legacy entitlements: features and limits', () => {
  assert.ok(featuresOf('professional').has('live.recording'));
  assert.ok(!featuresOf('starter').has('live.recording'), 'starter has no recording');
  assert.ok(!featuresOf('starter').has('ai.questions'));
  assert.ok(featuresOf('professional').has('ai.questions'));
  assert.ok(featuresOf('enterprise').has('security.sso'));
  assert.ok(!featuresOf('professional').has('security.sso'));
  assert.ok(featuresOf('starter').has('company.team_management'), 'core features are in every plan');
  assert.equal(limitOf('starter', 'members'), 2);
  assert.equal(limitOf('professional', 'interviews_per_month'), 100);
  assert.equal(limitOf('enterprise', 'members'), -1);
  assert.equal(limitOf('starter', 'active_jobs'), -1, 'limits without a legacy value default to unlimited so behaviour is unchanged');
  assert.equal((db.prepare('SELECT COUNT(*) c FROM plan_limits WHERE plan_id=?').get(plan('starter').id) as any).c, LIMITS.length);
});

test('re-syncing never overwrites what a Super Admin edited', () => {
  const p = plan('professional').id;
  db.prepare("DELETE FROM plan_features WHERE plan_id=? AND feature_key='live.recording'").run(p);
  db.prepare("UPDATE plan_limits SET value=250 WHERE plan_id=? AND limit_key='interviews_per_month'").run(p);
  syncPlansFromLegacy(db); runMigrations(db);
  assert.ok(!featuresOf('professional').has('live.recording'), 'removed feature stays removed');
  assert.equal(limitOf('professional', 'interviews_per_month'), 250);
});

test('the seeded super admin is internal staff with the super_admin role', () => {
  const r = db.prepare("SELECT s.role, s.status FROM internal_staff s JOIN users u ON u.id=s.user_id WHERE u.is_super_admin=1").get() as any;
  assert.deepEqual({ ...r }, { role: 'super_admin', status: 'active' });
});

test('migration 2 is idempotent and backfills a super admin that pre-dates it', () => {
  const id = uid();
  db.prepare('INSERT INTO users(id,email,password_hash,name,is_super_admin,email_verified,created_at) VALUES (?,?,?,?,1,1,?)').run(id, 'old-admin@example.test', 'x', 'Old Admin', now());
  assert.equal(db.prepare('SELECT 1 FROM internal_staff WHERE user_id=?').get(id), undefined);
  db.transaction(() => MIGRATIONS[1].up(db))();
  assert.equal((db.prepare('SELECT role FROM internal_staff WHERE user_id=?').get(id) as any).role, 'super_admin');
});

test('constraints: overrides, grants, limits, staff roles and invitations', () => {
  const c = mkCompany('Constraint Co');
  const ins = (sql: string, ...a: any[]) => db.prepare(sql).run(...a);
  // override: boolean only, must reference a real feature, one row per company+feature
  ins('INSERT INTO company_feature_overrides(company_id,feature_key,enabled,created_at,updated_at) VALUES (?,?,?,?,?)', c, 'live.recording', 1, now(), now());
  assert.throws(() => ins('INSERT INTO company_feature_overrides(company_id,feature_key,enabled,created_at,updated_at) VALUES (?,?,?,?,?)', c, 'live.recording', 0, now(), now()), /UNIQUE|PRIMARY/);
  assert.throws(() => ins('INSERT INTO company_feature_overrides(company_id,feature_key,enabled,created_at,updated_at) VALUES (?,?,?,?,?)', c, 'live.chat', 2, now(), now()), /CHECK/);
  assert.throws(() => ins('INSERT INTO company_feature_overrides(company_id,feature_key,enabled,created_at,updated_at) VALUES (?,?,?,?,?)', c, 'no.such_feature', 1, now(), now()), /FOREIGN KEY/);
  // temporary grant: must end after it starts
  const t0 = new Date().toISOString(), t1 = new Date(Date.now() + 86400000).toISOString();
  ins('INSERT INTO temporary_feature_grants(id,company_id,feature_key,starts_at,expires_at,created_at) VALUES (?,?,?,?,?,?)', uid(), c, 'ai.questions', t0, t1, now());
  assert.throws(() => ins('INSERT INTO temporary_feature_grants(id,company_id,feature_key,starts_at,expires_at,created_at) VALUES (?,?,?,?,?,?)', uid(), c, 'ai.questions', t1, t0, now()), /CHECK/);
  // limits: -1 (unlimited) allowed, below -1 not; key must be defined
  ins('INSERT INTO company_limit_overrides(company_id,limit_key,value,updated_at) VALUES (?,?,?,?)', c, 'members', -1, now());
  assert.throws(() => ins('INSERT INTO company_limit_overrides(company_id,limit_key,value,updated_at) VALUES (?,?,?,?)', c, 'candidates', -5, now()), /CHECK/);
  assert.throws(() => ins('INSERT INTO company_limit_overrides(company_id,limit_key,value,updated_at) VALUES (?,?,?,?)', c, 'bogus', 1, now()), /FOREIGN KEY/);
  // internal staff roles are a closed set
  const u = uid(); ins('INSERT INTO users(id,email,password_hash,name,created_at) VALUES (?,?,?,?,?)', u, 'staff@example.test', 'x', 'Staff', now());
  assert.throws(() => ins("INSERT INTO internal_staff(user_id,role,created_at) VALUES (?,'owner',?)", u, now()), /CHECK/);
  for (const role of ['support_admin', 'billing_admin', 'platform_admin']) { ins('DELETE FROM internal_staff WHERE user_id=?', u); ins('INSERT INTO internal_staff(user_id,role,created_at) VALUES (?,?,?)', u, role, now()); }
  // invitations: hashed token unique, purpose closed set
  ins("INSERT INTO invitations(id,company_id,email,purpose,token_hash,expires_at,created_at) VALUES (?,?,?,'company_admin_activation',?,?,?)", uid(), c, 'a@x.test', 'hash-1', t1, now());
  assert.throws(() => ins("INSERT INTO invitations(id,company_id,email,purpose,token_hash,expires_at,created_at) VALUES (?,?,?,'company_admin_activation',?,?,?)", uid(), c, 'b@x.test', 'hash-1', t1, now()), /UNIQUE/);
  assert.throws(() => ins("INSERT INTO invitations(id,company_id,email,purpose,token_hash,expires_at,created_at) VALUES (?,?,?,'password_in_email',?,?,?)", uid(), c, 'b@x.test', 'hash-2', t1, now()), /CHECK/);
});

test('tenant-scoped rows are removed with their company, and never leak across companies', () => {
  const a = mkCompany('Tenant A'), b = mkCompany('Tenant B');
  const t1 = new Date(Date.now() + 86400000).toISOString();
  for (const c of [a, b]) {
    db.prepare('INSERT INTO company_feature_overrides(company_id,feature_key,enabled,created_at,updated_at) VALUES (?,?,1,?,?)').run(c, 'live.recording', now(), now());
    db.prepare('INSERT INTO temporary_feature_grants(id,company_id,feature_key,starts_at,expires_at,created_at) VALUES (?,?,?,?,?,?)').run(uid(), c, 'ai.questions', now(), t1, now());
    db.prepare('INSERT INTO company_limit_overrides(company_id,limit_key,value,updated_at) VALUES (?,?,?,?)').run(c, 'members', 5, now());
  }
  const count = (t: string, c: string) => (db.prepare(`SELECT COUNT(*) n FROM ${t} WHERE company_id=?`).get(c) as any).n;
  db.prepare('DELETE FROM companies WHERE id=?').run(a);
  for (const t of ['company_feature_overrides', 'temporary_feature_grants', 'company_limit_overrides']) { assert.equal(count(t, a), 0, `${t} cascades`); assert.equal(count(t, b), 1, `${t} for the other tenant is untouched`); }
});
