import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

// Each test file runs in its own process; this one gets its own embedded MongoDB in a throwaway directory.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ivx-mig-'));
process.env.STORAGE_DIR = tmp; process.env.NODE_ENV = 'test'; process.env.SUPER_ADMIN_PASSWORD = 'Test-Password-123!';
delete process.env.TEST_MONGODB_URI; // config ignores MONGODB_URI under NODE_ENV=test

let db: any, raw: any, closeDb: any, ensureSeed: any, runMigrations: any, syncPlansFromLegacy: any, MIGRATIONS: any, FEATURES: any, CATEGORIES: any, LIMITS: any, now: any, isDuplicateKey: any;
before(async () => {
  ({ db, raw, closeDb, now, isDuplicateKey } = await import('../src/db.js'));
  ({ ensureSeed } = await import('../src/seed.js'));
  ({ runMigrations, syncPlansFromLegacy, MIGRATIONS } = await import('../src/migrations/index.js'));
  ({ FEATURES, CATEGORIES, LIMITS } = await import('../src/migrations/catalog.js'));
  await ensureSeed();
});
after(async () => { await closeDb(); });

const plan = async (code: string) => (await db.plans.get({ code })).id as string;
const featuresOf = async (code: string) => new Set((await db.plan_features.list({ plan_id: await plan(code) })).map((r: any) => r.feature_key));
const limitOf = async (code: string, k: string) => (await db.plan_limits.get({ plan_id: await plan(code), limit_key: k })).value;
const mkCompany = async (name: string) => db.companies.insert({ name, slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, status: 'active', settings: '{}', created_at: now() });
/** Asserts the write fails with a duplicate key (11000) or document-validation (121) error. */
async function rejects(p: Promise<any>, kind: 'duplicate' | 'validation') {
  try { await p; } catch (e: any) { if (kind === 'duplicate') assert.ok(isDuplicateKey(e), `expected duplicate-key, got ${e?.code}`); else assert.equal(e?.code, 121, `expected validation error, got ${e?.code}`); return; }
  assert.fail(`expected a ${kind} error`);
}

test('migrations are recorded, in order, once', async () => {
  const rows = (await db.schema_migrations.list({}, { sort: { version: 1 } })).map((r: any) => r.version);
  assert.deepEqual(rows, MIGRATIONS.map((m: any) => m.version));
  assert.deepEqual(await runMigrations(), [], 'a second run applies nothing');
});

test('unique indexes from the old schema exist', async () => {
  const unique = async (c: string) => (await raw.collection(c).indexes()).filter((i: any) => i.unique).map((i: any) => Object.keys(i.key).join(','));
  assert.ok((await unique('users')).includes('email'));
  assert.ok((await unique('company_members')).includes('company_id,user_id'));
  assert.ok((await unique('applications')).includes('job_id,candidate_id'));
  assert.ok((await unique('interview_feedback')).includes('interview_id,interviewer_id'));
  assert.ok((await unique('company_feature_overrides')).includes('company_id,feature_key'));
  assert.ok((await unique('invitations')).includes('token_hash'));
});

test('feature catalog covers every category from the spec and marks unbuilt features', async () => {
  const rows = await db.features.list();
  assert.equal(rows.length, FEATURES.length);
  assert.equal(new Set(rows.map((r: any) => r.category)).size, CATEGORIES.length);
  assert.equal(new Set(rows.map((r: any) => r.key)).size, rows.length, 'keys are unique');
  for (const k of ['company.team_management', 'coding.editor', 'live.recording', 'ai.questions', 'analytics.export', 'integrations.webhooks', 'security.sso']) assert.ok(rows.some((r: any) => r.key === k), k);
  assert.equal(rows.find((r: any) => r.key === 'security.sso').implemented, 0, 'SSO is not built and must not be presented as available');
  assert.equal(rows.find((r: any) => r.key === 'live.recording').implemented, 1);
});

test('plans are backfilled from legacy entitlements: features and limits', async () => {
  assert.ok((await featuresOf('professional')).has('live.recording'));
  assert.ok(!(await featuresOf('starter')).has('live.recording'), 'starter has no recording');
  assert.ok(!(await featuresOf('starter')).has('ai.questions'));
  assert.ok((await featuresOf('professional')).has('ai.questions'));
  assert.ok((await featuresOf('enterprise')).has('security.sso'));
  assert.ok(!(await featuresOf('professional')).has('security.sso'));
  assert.ok((await featuresOf('starter')).has('company.team_management'), 'core features are in every plan');
  assert.equal(await limitOf('starter', 'members'), 2);
  assert.equal(await limitOf('professional', 'interviews_per_month'), 100);
  assert.equal(await limitOf('enterprise', 'members'), -1);
  assert.equal(await limitOf('starter', 'active_jobs'), -1, 'limits without a legacy value default to unlimited so behaviour is unchanged');
  assert.equal(await db.plan_limits.count({ plan_id: await plan('starter') }), LIMITS.length);
});

test('re-syncing never overwrites what a Super Admin edited', async () => {
  const p = await plan('professional');
  await db.plan_features.del({ plan_id: p, feature_key: 'live.recording' });
  await db.plan_limits.set({ plan_id: p, limit_key: 'interviews_per_month' }, { value: 250 });
  await syncPlansFromLegacy(); await runMigrations(); await ensureSeed();
  assert.ok(!(await featuresOf('professional')).has('live.recording'), 'removed feature stays removed');
  assert.equal(await limitOf('professional', 'interviews_per_month'), 250);
});

test('the seeded super admin is internal staff with the super_admin role', async () => {
  const u = await db.users.get({ is_super_admin: 1 });
  const s = await db.internal_staff.get({ user_id: u.id });
  assert.equal(s.role, 'super_admin'); assert.equal(s.status, 'active');
});

test('migration 2 is idempotent and backfills a super admin that pre-dates it', async () => {
  const id = await db.users.insert({ email: 'old-admin@example.test', password_hash: 'x', name: 'Old Admin', is_super_admin: 1, email_verified: 1, session_version: 0, created_at: now() });
  assert.equal(await db.internal_staff.get({ user_id: id }), null);
  await MIGRATIONS[1].up();
  assert.equal((await db.internal_staff.get({ user_id: id })).role, 'super_admin');
  assert.equal(await db.features.count(), FEATURES.length, 'catalog not duplicated');
});

test('constraints: uniqueness and validators on overrides, grants, limits, staff roles and invitations', async () => {
  const c = await mkCompany('Constraint Co');
  const t0 = new Date().toISOString(), t1 = new Date(Date.now() + 86400000).toISOString();
  await db.company_feature_overrides.insert({ company_id: c, feature_key: 'live.recording', enabled: 1, created_at: now(), updated_at: now() });
  await rejects(db.company_feature_overrides.insert({ company_id: c, feature_key: 'live.recording', enabled: 0, created_at: now(), updated_at: now() }), 'duplicate');
  await rejects(db.company_feature_overrides.insert({ company_id: c, feature_key: 'live.chat', enabled: 2, created_at: now(), updated_at: now() }), 'validation');
  await db.temporary_feature_grants.insert({ company_id: c, feature_key: 'ai.questions', starts_at: t0, expires_at: t1, created_at: now() });
  await rejects(db.temporary_feature_grants.insert({ company_id: c, feature_key: 'ai.questions', starts_at: t1, expires_at: t0, created_at: now() }), 'validation');
  await db.company_limit_overrides.insert({ company_id: c, limit_key: 'members', value: -1, updated_at: now() });
  await rejects(db.company_limit_overrides.insert({ company_id: c, limit_key: 'candidates', value: -5, updated_at: now() }), 'validation');
  const u = await db.users.insert({ email: 'staff@example.test', password_hash: 'x', name: 'Staff', created_at: now() });
  await rejects(db.internal_staff.insert({ user_id: u, role: 'owner', created_at: now() }), 'validation');
  for (const role of ['support_admin', 'billing_admin', 'platform_admin']) { await db.internal_staff.del({ user_id: u }); await db.internal_staff.insert({ user_id: u, role, status: 'active', created_at: now() }); }
  await db.invitations.insert({ company_id: c, email: 'a@x.test', purpose: 'company_admin_activation', token_hash: 'hash-1', expires_at: t1, created_at: now() });
  await rejects(db.invitations.insert({ company_id: c, email: 'b@x.test', purpose: 'company_admin_activation', token_hash: 'hash-1', expires_at: t1, created_at: now() }), 'duplicate');
  await rejects(db.invitations.insert({ company_id: c, email: 'b@x.test', purpose: 'password_in_email', token_hash: 'hash-2', expires_at: t1, created_at: now() }), 'validation');
});

test('tenant-scoped records stay separate per company', async () => {
  const a = await mkCompany('Tenant A'), b = await mkCompany('Tenant B');
  await db.company_feature_overrides.insert({ company_id: a, feature_key: 'ai.questions', enabled: 1, created_at: now(), updated_at: now() });
  await db.company_feature_overrides.insert({ company_id: b, feature_key: 'ai.questions', enabled: 0, created_at: now(), updated_at: now() });
  assert.equal((await db.company_feature_overrides.get({ company_id: a, feature_key: 'ai.questions' })).enabled, 1);
  assert.equal((await db.company_feature_overrides.get({ company_id: b, feature_key: 'ai.questions' })).enabled, 0);
  assert.equal(await db.company_feature_overrides.count({ company_id: a }), 1);
});

test('migration 6 gives existing jobs a company-prefixed ID in creation order and never touches templates', async () => {
  const cid = await mkCompany('Infoaxon Technologies');
  const t = (m: number) => new Date(Date.UTC(2026, 0, 1, 0, m)).toISOString();
  const second = await db.jobs.insert({ company_id: cid, title: 'Second', status: 'draft', is_template: 0, created_at: t(2), updated_at: t(2) });
  const first = await db.jobs.insert({ company_id: cid, title: 'First', status: 'published', is_template: 0, created_at: t(1), updated_at: t(1) });
  const tpl = await db.jobs.insert({ company_id: cid, title: 'Template', status: 'draft', is_template: 1, created_at: t(0), updated_at: t(0) });
  await MIGRATIONS.find((m: any) => m.version === 6).up();
  assert.equal((await db.jobs.get({ id: first })).job_code, 'IT-0001');
  assert.equal((await db.jobs.get({ id: second })).job_code, 'IT-0002');
  assert.equal((await db.jobs.get({ id: tpl })).job_code, undefined);
  assert.equal((await db.companies.get({ id: cid })).job_seq, 2);
  await MIGRATIONS.find((m: any) => m.version === 6).up();
  assert.equal((await db.jobs.get({ id: second })).job_code, 'IT-0002', 're-running is a no-op');
  const { nextJobCode } = await import('../src/jobcodes.js');
  assert.equal(await nextJobCode(cid), 'IT-0003');
});
