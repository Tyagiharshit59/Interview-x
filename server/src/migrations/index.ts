import type Database from 'better-sqlite3';
import { FEATURES, LIMITS, legacyFeatureKeys } from './catalog.js';

/**
 * Versioned, forward-only migrations.
 * The original tables are created by the baseline SCHEMA in db.ts (CREATE IF NOT EXISTS); that is migration 1.
 * Every later change is a numbered migration here, applied once, inside a transaction, and recorded in schema_migrations.
 * Never edit an applied migration; add a new one.
 */
type Db = Database.Database;
interface Migration { version: number; name: string; up: (db: Db) => void }

const hasColumn = (db: Db, table: string, col: string) => (db.prepare(`PRAGMA table_info(${table})`).all() as any[]).some(c => c.name === col);
const addColumn = (db: Db, table: string, col: string, ddl: string) => { if (!hasColumn(db, table, col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`); };

export const MIGRATIONS: Migration[] = [
  { version: 1, name: 'baseline schema (db.ts)', up: () => { /* tables already created by the baseline SCHEMA */ } },
  {
    version: 2, name: 'admin provisioning, feature catalog, overrides, grants, limits, internal staff, invitations',
    up: (db) => {
      // --- company profile fields needed by provisioning ---
      for (const [c, d] of [['email', 'TEXT'], ['contact_person', 'TEXT'], ['contact_phone', 'TEXT'], ['country', 'TEXT'], ['address', 'TEXT'], ['logo_key', 'TEXT'], ['employee_count', 'INTEGER'], ['deactivated_at', 'TEXT'], ['created_by', 'TEXT']] as const) addColumn(db, 'companies', c, d);
      // --- subscription fields: custom price, discount, suspension, notes ---
      for (const [c, d] of [['custom_price_monthly', 'INTEGER'], ['custom_price_yearly', 'INTEGER'], ['discount_percent', 'INTEGER NOT NULL DEFAULT 0'], ['suspended_at', 'TEXT'], ['notes', 'TEXT']] as const) addColumn(db, 'subscriptions', c, d);
      db.exec(`
        CREATE TABLE IF NOT EXISTS features (
          key TEXT PRIMARY KEY, category TEXT NOT NULL, label TEXT NOT NULL, description TEXT,
          implemented INTEGER NOT NULL DEFAULT 1, is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS plan_features (
          plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, feature_key TEXT NOT NULL REFERENCES features(key) ON DELETE CASCADE,
          PRIMARY KEY (plan_id, feature_key)
        );
        CREATE TABLE IF NOT EXISTS company_feature_overrides (
          company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, feature_key TEXT NOT NULL REFERENCES features(key) ON DELETE CASCADE,
          enabled INTEGER NOT NULL CHECK (enabled IN (0,1)), reason TEXT, set_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY (company_id, feature_key)
        );
        CREATE TABLE IF NOT EXISTS temporary_feature_grants (
          id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, feature_key TEXT NOT NULL REFERENCES features(key) ON DELETE CASCADE,
          starts_at TEXT NOT NULL, expires_at TEXT NOT NULL, reason TEXT, granted_by TEXT, revoked_at TEXT, created_at TEXT NOT NULL,
          CHECK (expires_at > starts_at)
        );
        CREATE INDEX IF NOT EXISTS idx_grants_company ON temporary_feature_grants(company_id, feature_key, expires_at);
        CREATE TABLE IF NOT EXISTS limit_definitions (
          key TEXT PRIMARY KEY, label TEXT NOT NULL, unit TEXT NOT NULL, period TEXT NOT NULL CHECK (period IN ('month','total','concurrent','days')), sort_order INTEGER NOT NULL DEFAULT 0
        );
        CREATE TABLE IF NOT EXISTS plan_limits (
          plan_id TEXT NOT NULL REFERENCES plans(id) ON DELETE CASCADE, limit_key TEXT NOT NULL REFERENCES limit_definitions(key) ON DELETE CASCADE,
          value INTEGER NOT NULL CHECK (value >= -1), PRIMARY KEY (plan_id, limit_key)
        );
        CREATE TABLE IF NOT EXISTS company_limit_overrides (
          company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, limit_key TEXT NOT NULL REFERENCES limit_definitions(key) ON DELETE CASCADE,
          value INTEGER NOT NULL CHECK (value >= -1), reason TEXT, set_by TEXT, updated_at TEXT NOT NULL, PRIMARY KEY (company_id, limit_key)
        );
        CREATE TABLE IF NOT EXISTS internal_staff (
          user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('super_admin','platform_admin','support_admin','billing_admin')),
          status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')), created_by TEXT, created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS invitations (
          id TEXT PRIMARY KEY, company_id TEXT REFERENCES companies(id) ON DELETE CASCADE, user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          email TEXT NOT NULL, purpose TEXT NOT NULL CHECK (purpose IN ('company_admin_activation','internal_staff_activation')),
          token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, used_at TEXT, revoked_at TEXT, created_by TEXT, created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_invitations_company ON invitations(company_id, purpose);
      `);
      // existing super admins become internal staff with the full role
      db.prepare("INSERT OR IGNORE INTO internal_staff(user_id,role,status,created_at) SELECT id,'super_admin','active',? FROM users WHERE is_super_admin=1").run(new Date().toISOString());
      seedCatalog(db);
      syncPlansFromLegacy(db);
    },
  },
];

/** Upserts the feature and limit vocabularies. Safe to run on every start. */
export function seedCatalog(db: Db) {
  const f = db.prepare('INSERT INTO features(key,category,label,description,implemented,sort_order) VALUES (?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET category=excluded.category, label=excluded.label, description=excluded.description, implemented=excluded.implemented, sort_order=excluded.sort_order');
  FEATURES.forEach((x, i) => f.run(x.key, x.category, x.label, x.description ?? null, x.implemented === false ? 0 : 1, i));
  const l = db.prepare('INSERT INTO limit_definitions(key,label,unit,period,sort_order) VALUES (?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET label=excluded.label, unit=excluded.unit, period=excluded.period, sort_order=excluded.sort_order');
  LIMITS.forEach((x, i) => l.run(x.key, x.label, x.unit, x.period, i));
}

/**
 * Fills plan_features / plan_limits for plans that have none yet, derived from the legacy plans.entitlements JSON.
 * INSERT OR IGNORE: it never overwrites what a Super Admin has since edited. New limits with no legacy equivalent default to -1 (unlimited) so behaviour does not change.
 */
export function syncPlansFromLegacy(db: Db) {
  const pf = db.prepare('INSERT OR IGNORE INTO plan_features(plan_id,feature_key) VALUES (?,?)');
  const pl = db.prepare('INSERT OR IGNORE INTO plan_limits(plan_id,limit_key,value) VALUES (?,?,?)');
  for (const p of db.prepare('SELECT id, entitlements FROM plans').all() as any[]) {
    let ent: Record<string, any> = {}; try { ent = JSON.parse(p.entitlements || '{}'); } catch { /* keep empty */ }
    if (!db.prepare('SELECT 1 FROM plan_features WHERE plan_id=? LIMIT 1').get(p.id)) for (const k of legacyFeatureKeys(ent)) pf.run(p.id, k);
    for (const l of LIMITS) { const v = l.legacy && typeof ent[l.legacy] === 'number' ? ent[l.legacy] : -1; pl.run(p.id, l.key, v); }
  }
}

export function runMigrations(db: Db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  const done = new Set((db.prepare('SELECT version FROM schema_migrations').all() as any[]).map(r => r.version));
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (done.has(m.version)) continue;
    db.transaction(() => { m.up(db); db.prepare('INSERT INTO schema_migrations(version,name,applied_at) VALUES (?,?,?)').run(m.version, m.name, new Date().toISOString()); })();
    applied.push(m.version);
  }
  seedCatalog(db); // keep vocabulary current when the catalog file changes
  return applied;
}
