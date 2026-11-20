import { raw, db, now } from '../db.js';
import { FEATURES, LIMITS, legacyFeatureKeys } from './catalog.js';
import { DEFAULTS } from '../defaults.js';

/**
 * Versioned, forward-only migrations for MongoDB.
 * MongoDB is schemaless, so a migration here means: create indexes (including unique constraints), install collection validators, and back-fill data.
 * Each migration runs once and is recorded in `schema_migrations`. Never edit an applied migration; add a new one.
 * (Foreign keys do not exist in MongoDB; referential integrity and cascades are enforced in application code.)
 */
interface Migration { version: number; name: string; up: () => Promise<void> }

type IdxOpts = { unique?: boolean; partial?: Record<string, any>; nocase?: boolean };
async function idx(collection: string, keys: Record<string, 1 | -1>, o: IdxOpts = {}) {
  await raw.collection(collection).createIndex(keys, {
    unique: !!o.unique, ...(o.partial ? { partialFilterExpression: o.partial } : {}), ...(o.nocase ? { collation: { locale: 'en', strength: 2 } } : {}),
  });
}
/** Unique index that ignores documents where the field is null/missing (SQL UNIQUE allowed many NULLs). */
const uniqueIfSet = (collection: string, keys: Record<string, 1 | -1>) => {
  const partial: Record<string, any> = {}; for (const k of Object.keys(keys)) partial[k] = { $type: 'string' };
  return idx(collection, keys, { unique: true, partial });
};

async function validator(collection: string, v: Record<string, any>) {
  const exists = (await raw.listCollections({ name: collection }).toArray()).length > 0;
  if (!exists) await raw.createCollection(collection, { validator: v, validationLevel: 'strict', validationAction: 'error' });
  else await raw.command({ collMod: collection, validator: v, validationLevel: 'strict', validationAction: 'error' });
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1, name: 'baseline indexes and unique constraints',
    up: async () => {
      await idx('users', { email: 1 }, { unique: true });
      await idx('user_tokens', { token_hash: 1 }, { unique: true }); await idx('user_tokens', { user_id: 1 });
      await idx('plans', { code: 1 }, { unique: true });
      await idx('companies', { slug: 1 }, { unique: true });
      await idx('company_members', { company_id: 1, user_id: 1 }, { unique: true }); await idx('company_members', { user_id: 1 });
      await idx('member_invites', { token_hash: 1 }, { unique: true }); await idx('member_invites', { company_id: 1 });
      await idx('subscriptions', { company_id: 1 }, { unique: true });
      await idx('coupons', { code: 1 }, { unique: true, nocase: true });
      await idx('invoices', { number: 1 }, { unique: true }); await uniqueIfSet('invoices', { gateway_ref: 1 }); await idx('invoices', { company_id: 1, issued_at: -1 });
      await idx('usage_records', { company_id: 1, metric: 1, created_at: 1 });
      await idx('jobs', { company_id: 1, status: 1 });
      await uniqueIfSet('candidates', { company_id: 1, email: 1 });
      await idx('applications', { job_id: 1, candidate_id: 1 }, { unique: true }); await idx('applications', { company_id: 1, stage: 1 }); await idx('applications', { candidate_id: 1 });
      await idx('interviews', { company_id: 1, scheduled_at: 1 }); await idx('interviews', { application_id: 1 });
      await idx('interview_participants', { interview_id: 1, user_id: 1 }, { unique: true });
      await idx('interview_invitations', { token_hash: 1 }, { unique: true }); await idx('interview_invitations', { interview_id: 1 });
      await idx('camera_sessions', { token_hash: 1 }, { unique: true });
      await idx('whiteboard_sessions', { interview_id: 1 }, { unique: true });
      await idx('interview_feedback', { interview_id: 1, interviewer_id: 1 }, { unique: true });
      await idx('integrations', { company_id: 1, kind: 1 }, { unique: true });
      await idx('notification_prefs', { user_id: 1 }, { unique: true });
      await idx('feature_flags', { key: 1 }, { unique: true });
      await idx('audit_logs', { company_id: 1, created_at: 1 }); await idx('audit_logs', { action: 1, target: 1 });
      for (const c of ['interview_recordings', 'recording_events', 'chat_messages', 'consent_records', 'interview_transcripts', 'code_snapshots', 'coding_submissions']) await idx(c, { interview_id: 1, created_at: 1 });
      await idx('notifications', { user_id: 1, created_at: -1 }); await idx('ai_reports', { company_id: 1, created_at: -1 }); await idx('activity', { company_id: 1, candidate_id: 1, created_at: -1 });
    },
  },
  {
    version: 2, name: 'admin provisioning: feature catalog, overrides, grants, limits, internal staff, invitations',
    up: async () => {
      await idx('features', { key: 1 }, { unique: true }); await idx('features', { category: 1, sort_order: 1 });
      await idx('plan_features', { plan_id: 1, feature_key: 1 }, { unique: true });
      await idx('company_feature_overrides', { company_id: 1, feature_key: 1 }, { unique: true });
      await idx('temporary_feature_grants', { company_id: 1, feature_key: 1, expires_at: 1 });
      await idx('limit_definitions', { key: 1 }, { unique: true });
      await idx('plan_limits', { plan_id: 1, limit_key: 1 }, { unique: true });
      await idx('company_limit_overrides', { company_id: 1, limit_key: 1 }, { unique: true });
      await idx('internal_staff', { user_id: 1 }, { unique: true });
      await idx('invitations', { token_hash: 1 }, { unique: true }); await idx('invitations', { company_id: 1, purpose: 1 });
      // CHECK-constraint equivalents
      await validator('company_feature_overrides', { $jsonSchema: { properties: { enabled: { enum: [0, 1] } }, required: ['company_id', 'feature_key', 'enabled'] } });
      await validator('temporary_feature_grants', { $and: [{ $jsonSchema: { required: ['company_id', 'feature_key', 'starts_at', 'expires_at'] } }, { $expr: { $gt: ['$expires_at', '$starts_at'] } }] });
      await validator('plan_limits', { $jsonSchema: { properties: { value: { bsonType: ['int', 'long', 'double'], minimum: -1 } }, required: ['plan_id', 'limit_key', 'value'] } });
      await validator('company_limit_overrides', { $jsonSchema: { properties: { value: { bsonType: ['int', 'long', 'double'], minimum: -1 } }, required: ['company_id', 'limit_key', 'value'] } });
      await validator('limit_definitions', { $jsonSchema: { properties: { period: { enum: ['month', 'total', 'concurrent', 'days'] } } } });
      await validator('internal_staff', { $jsonSchema: { properties: { role: { enum: ['super_admin', 'platform_admin', 'support_admin', 'billing_admin'] }, status: { enum: ['active', 'disabled'] } }, required: ['user_id', 'role'] } });
      await validator('invitations', { $jsonSchema: { properties: { purpose: { enum: ['company_admin_activation', 'internal_staff_activation'] } }, required: ['email', 'purpose', 'token_hash', 'expires_at'] } });
      await seedCatalog();
      await syncPlansFromLegacy();
      for (const u of await db.users.list({ is_super_admin: 1 }, { projection: { _id: 1 } }))
        await db.internal_staff.upsert({ user_id: u.id }, { role: 'super_admin', status: 'active' }, { created_at: now() });
    },
  },
  {
    version: 3, name: 'back-fill old SQL column defaults on documents written without them',
    up: async () => {
      // Documents created right after the switch to MongoDB could miss fields that SQL used to default (e.g. interviews.status).
      for (const [collection, fields] of Object.entries(DEFAULTS))
        for (const [field, value] of Object.entries(fields))
          await raw.collection(collection).updateMany({ [field]: { $exists: false } }, { $set: { [field]: value } });
    },
  },
];

/** Upserts the feature and limit vocabularies. Safe to run on every start. */
export async function seedCatalog() {
  for (const [i, x] of FEATURES.entries())
    await db.features.upsert({ key: x.key }, { category: x.category, label: x.label, description: x.description ?? null, implemented: x.implemented === false ? 0 : 1, sort_order: i }, { is_active: 1 });
  for (const [i, x] of LIMITS.entries())
    await db.limit_definitions.upsert({ key: x.key }, { label: x.label, unit: x.unit, period: x.period, sort_order: i });
}

/**
 * Fills plan_features / plan_limits for plans that have none yet, derived from the legacy plans.entitlements JSON.
 * It never overwrites what a Super Admin has since edited. New limits with no legacy equivalent default to -1 (unlimited) so behaviour does not change.
 */
export async function syncPlansFromLegacy() {
  for (const p of await db.plans.list()) {
    let ent: Record<string, any> = {}; try { ent = JSON.parse(p.entitlements || '{}'); } catch { /* keep empty */ }
    if (!(await db.plan_features.exists({ plan_id: p.id }))) for (const k of legacyFeatureKeys(ent)) await db.plan_features.upsert({ plan_id: p.id, feature_key: k }, {});
    for (const l of LIMITS) {
      const v = l.legacy && typeof ent[l.legacy] === 'number' ? ent[l.legacy] : -1;
      if (!(await db.plan_limits.exists({ plan_id: p.id, limit_key: l.key }))) await db.plan_limits.upsert({ plan_id: p.id, limit_key: l.key }, { value: v });
    }
  }
}

export async function runMigrations() {
  const done = new Set((await db.schema_migrations.list()).map(r => r.version));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    await m.up();
    await db.schema_migrations.insert({ id: String(m.version), version: m.version, name: m.name, applied_at: now() });
    applied.push(m.version);
  }
  await seedCatalog(); // keep the vocabulary current when the catalog file changes
  return applied;
}
