import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { MongoClient, type Db, type ClientSession, type Document } from 'mongodb';
import { config } from './config.js';
import { runMigrations } from './migrations/index.js';

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();
export const j = <T = any>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};

/**
 * MongoDB data layer.
 *
 * Documents keep the shape the app has always used: a string `id` (stored as `_id`), snake_case fields, ISO-string timestamps,
 * 0/1 flags and JSON-in-string fields (read with `j()`). Reads return `id`, never `_id`. Every collection is addressed as `db.<name>`.
 *
 * Multi-tenancy rule is unchanged: collections that hold tenant data carry `company_id` and EVERY query on them must filter by it.
 * Platform-level collections: users (global identity), plans, coupons, features, plan_features, limit_definitions, plan_limits,
 * feature_flags, announcements, webhook_events, internal_staff, schema_migrations.
 */
let uri = config.mongo.uri;
let embedded: any = null;
if (!uri) {
  if (config.isProd) throw new Error('MONGODB_URI must be set in production (e.g. your MongoDB Atlas connection string)');
  // Development/test convenience: a real mongod (replica set, so transactions work) started in-process and stored under storage/mongo-data.
  const { MongoMemoryReplSet } = await import('mongodb-memory-server');
  const dbPath = path.join(config.storageDir, 'mongo-data'); fs.mkdirSync(dbPath, { recursive: true });
  embedded = await MongoMemoryReplSet.create({ replSet: { count: 1, storageEngine: 'wiredTiger', dbName: config.mongo.dbName }, instanceOpts: [{ dbPath, port: config.mongo.devPort || undefined, storageEngine: 'wiredTiger' }] });
  uri = embedded.getUri();
  if (!config.isTest) console.log(`[db] No MONGODB_URI set: using an embedded development MongoDB at ${dbPath}`);
}
export const client = new MongoClient(uri, { ignoreUndefined: true, maxPoolSize: 20 });
await client.connect();
export const raw: Db = client.db(config.mongo.dbName);
export async function closeDb() { await client.close(); await embedded?.stop(); }

const txStore = new AsyncLocalStorage<ClientSession>();
/** Runs fn in a transaction. All `db.*` calls made inside (even through helpers) join it. Retries transient errors; rolls back on throw. Nested calls join the outer transaction. */
export async function tx<T>(fn: () => Promise<T>): Promise<T> {
  if (txStore.getStore()) return fn();
  const session = client.startSession();
  try { let out!: T; await session.withTransaction(async () => { out = await txStore.run(session, fn); }); return out; }
  finally { await session.endSession(); }
}
export const isDuplicateKey = (e: any) => e?.code === 11000;

type Filter = Record<string, any>;
const mapF = (f: any): any => {
  if (!f || typeof f !== 'object') return f;
  if (Array.isArray(f)) return f.map(mapF);
  const o: any = {};
  for (const [k, v] of Object.entries(f)) { if (k === 'id') o._id = v; else if (k === '$and' || k === '$or' || k === '$nor') o[k] = (v as any[]).map(mapF); else o[k] = v; }
  return o;
};
/** Monotonic insertion counter (like SQLite rowid). Stored as `_seq`, never returned; use `sort: { _seq: 1 }` to list in insertion order. */
let seqN = 0; const nextSeq = () => Date.now() * 1000 + (seqN++ % 1000);
const out = (d: any) => { if (!d) return d; const { _id, _seq, ...rest } = d; return { id: _id, ...rest }; };
const sess = (extra: Document = {}) => { const s = txStore.getStore(); return s ? { session: s, ...extra } : extra; };

export interface FindOpts { sort?: Record<string, 1 | -1>; limit?: number; skip?: number; projection?: Record<string, 0 | 1>; collation?: { locale: string; strength: number } }
export const NOCASE = { locale: 'en', strength: 2 } as const;

class Coll {
  constructor(readonly name: string) {}
  private get c() { return raw.collection(this.name); }
  /** One document or null. Filter key `id` means the primary key. */
  async get(filter: Filter, o: FindOpts = {}): Promise<any | null> { return out(await this.c.findOne(mapF(filter), sess({ sort: o.sort, projection: o.projection, collation: o.collation }) as any)); }
  async list(filter: Filter = {}, o: FindOpts = {}): Promise<any[]> {
    let cur = this.c.find(mapF(filter), sess({ projection: o.projection, collation: o.collation }) as any);
    if (o.sort) cur = cur.sort(o.sort as any); if (o.skip) cur = cur.skip(o.skip); if (o.limit) cur = cur.limit(o.limit);
    return (await cur.toArray()).map(out);
  }
  async exists(filter: Filter, o: FindOpts = {}) { return (await this.c.countDocuments(mapF(filter), sess({ limit: 1, collation: o.collation }) as any)) > 0; }
  async count(filter: Filter = {}) { return this.c.countDocuments(mapF(filter), sess() as any); }
  /** Inserts a document; `id` is generated when absent. Returns the id. Throws a duplicate-key error (see isDuplicateKey) on unique violations. */
  async insert(doc: Filter): Promise<string> { const { id, ...rest } = doc; const _id = id ?? uid(); await this.c.insertOne({ _id, _seq: nextSeq(), ...rest } as any, sess() as any); return _id; }
  async insertMany(docs: Filter[]) { if (!docs.length) return; await this.c.insertMany(docs.map(({ id, ...rest }) => ({ _id: id ?? uid(), _seq: nextSeq(), ...rest })) as any, sess() as any); }
  /** $set on the first match. Returns how many documents matched (0 or 1). */
  async set(filter: Filter, fields: Filter): Promise<number> { return (await this.c.updateOne(mapF(filter), { $set: fields }, sess() as any)).matchedCount; }
  async setMany(filter: Filter, fields: Filter): Promise<number> { return (await this.c.updateMany(mapF(filter), { $set: fields }, sess() as any)).matchedCount; }
  /** Raw update operators ($set, $inc, $unset...) on the first match, or all matches with many:true. */
  async update(filter: Filter, ops: Document, o: { many?: boolean; upsert?: boolean } = {}): Promise<number> {
    const r = o.many ? await this.c.updateMany(mapF(filter), ops, sess({ upsert: o.upsert }) as any) : await this.c.updateOne(mapF(filter), ops, sess({ upsert: o.upsert }) as any);
    return r.matchedCount + (r.upsertedCount || 0);
  }
  async inc(filter: Filter, fields: Record<string, number>) { return this.update(filter, { $inc: fields }); }
  /**
   * Update-or-insert by an equality filter. Equality fields of the filter are written on insert automatically.
   * `onInsert` fields are only written when the document is created (use for ids and created_at).
   */
  async upsert(filter: Filter, fields: Filter, onInsert: Filter = {}) {
    const f = mapF(filter); const eq: Filter = {};
    for (const [k, v] of Object.entries(f)) if (!k.startsWith('$') && (typeof v !== 'object' || v === null)) eq[k] = v;
    const set = { ...fields }; const ins: Filter = { ...onInsert };
    for (const k of Object.keys(eq)) { delete set[k]; delete ins[k]; }
    for (const k of Object.keys(set)) delete ins[k];
    if (ins.id !== undefined) { ins._id = ins.id; delete ins.id; }
    ins._seq = nextSeq();
    if (!eq._id && !ins._id) ins._id = uid();
    const upd: Document = {}; if (Object.keys(set).length) upd.$set = set; if (Object.keys(ins).length) upd.$setOnInsert = ins;
    await this.c.updateOne(f, upd, sess({ upsert: true }) as any);
  }
  async del(filter: Filter): Promise<number> { return (await this.c.deleteMany(mapF(filter), sess() as any)).deletedCount; }
  async sum(field: string, filter: Filter = {}): Promise<number> { const r = await this.c.aggregate([{ $match: mapF(filter) }, { $group: { _id: null, t: { $sum: `$${field}` } } }], sess() as any).toArray(); return r[0]?.t ?? 0; }
  async distinct(field: string, filter: Filter = {}) { return this.c.distinct(field, mapF(filter), sess() as any); }
  /** Raw aggregation. Results are returned as-is (`_id` is the group key), not remapped. */
  async aggregate(pipeline: Document[]): Promise<any[]> { return this.c.aggregate(pipeline, sess() as any).toArray(); }
  /** Escape hatch to the native driver collection. */
  get native() { return this.c; }
}

export const COLLECTIONS = [
  'users', 'user_tokens', 'plans', 'companies', 'company_members', 'member_invites', 'subscriptions', 'coupons', 'invoices', 'webhook_events', 'usage_records',
  'jobs', 'candidates', 'candidate_resumes', 'applications', 'application_notes', 'activity', 'interviews', 'interview_participants', 'interview_invitations',
  'camera_sessions', 'consent_records', 'interview_recordings', 'recording_events', 'chat_messages', 'coding_questions', 'coding_test_cases', 'coding_assessments',
  'coding_submissions', 'coding_execution_logs', 'code_snapshots', 'whiteboard_sessions', 'evaluation_templates', 'interview_feedback', 'interview_transcripts',
  'ai_reports', 'notifications', 'notification_prefs', 'email_outbox', 'integrations', 'feature_flags', 'announcements', 'support_requests', 'audit_logs',
  'features', 'plan_features', 'company_feature_overrides', 'temporary_feature_grants', 'limit_definitions', 'plan_limits', 'company_limit_overrides', 'internal_staff', 'invitations', 'schema_migrations',
] as const;
type Name = typeof COLLECTIONS[number];
export const db = Object.fromEntries(COLLECTIONS.map(n => [n, new Coll(n)])) as { [K in Name]: Coll };

await runMigrations();
