/**
 * One-off import of an existing IntervueX SQLite database (storage/app.db) into MongoDB.
 *
 *   MONGODB_URI="mongodb+srv://..." npx tsx scripts/import-sqlite.ts ../storage/app.db
 *
 * - Documents keep the row shape (id -> _id), so the app reads them unchanged.
 * - Refuses to write into a database that already has companies or non-seed users, unless --force is passed.
 * - Rows are inserted in table order with their original rowid order preserved (as `_seq`).
 * - Uploaded files (resumes, recordings) stay on disk under STORAGE_DIR; copy that folder to the new server too.
 */
import Database from 'better-sqlite3';
import { raw, db, closeDb, COLLECTIONS } from '../src/db.js';

const file = process.argv[2];
const force = process.argv.includes('--force');
if (!file) { console.error('Usage: npx tsx scripts/import-sqlite.ts <path-to-app.db> [--force]'); process.exit(1); }

const sqlite = new Database(file, { readonly: true, fileMustExist: true });
const tables = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'schema_migrations'").all() as any[]).map(r => r.name as string);

const existingCompanies = await db.companies.count();
const existingUsers = await db.users.count({ is_super_admin: { $ne: 1 } });
if ((existingCompanies || existingUsers) && !force) {
  console.error(`Target MongoDB already has ${existingCompanies} companies and ${existingUsers} users. Re-run with --force to merge (rows with the same id are skipped).`);
  await closeDb(); process.exit(1);
}

let total = 0;
for (const t of tables) {
  if (!(COLLECTIONS as readonly string[]).includes(t)) { console.warn(`skip unknown table ${t}`); continue; }
  const rows = sqlite.prepare(`SELECT rowid AS __rowid, * FROM "${t}" ORDER BY rowid`).all() as any[];
  if (!rows.length) continue;
  const docs = rows.map(({ __rowid, id, ...rest }) => ({ _id: id ?? `${t}:${__rowid}`, _seq: __rowid, ...rest }));
  // Natural-key tables (no id column): avoid clashing with seed rows created on first start.
  const naturalKey: Record<string, string> = { user_tokens: 'token_hash', coupons: 'code', feature_flags: 'key', notification_prefs: 'user_id', features: 'key', limit_definitions: 'key' };
  let inserted = 0;
  for (const d of docs) {
    const nk = naturalKey[t];
    try {
      if (nk) await raw.collection(t).updateOne({ [nk]: d[nk] }, { $setOnInsert: d }, { upsert: true });
      else if (t === 'plans') {
        // Imported plan replaces a seeded default with the same code (subscriptions reference the imported id).
        const seeded = await raw.collection(t).findOne({ code: d.code });
        if (seeded && seeded._id !== d._id) { await raw.collection('plan_features').deleteMany({ plan_id: seeded._id }); await raw.collection('plan_limits').deleteMany({ plan_id: seeded._id }); await raw.collection(t).deleteOne({ _id: seeded._id }); }
        await raw.collection(t).replaceOne({ _id: d._id }, d, { upsert: true });
      }
      else await raw.collection(t).insertOne(d as any);
      inserted++;
    } catch (e: any) { if (e?.code !== 11000) throw e; }
  }
  total += inserted;
  console.log(`${t.padEnd(28)} ${inserted}/${rows.length}`);
}
sqlite.close();
console.log(`Imported ${total} documents. Restart the API so migrations back-fill the feature catalog for imported plans.`);
await closeDb();
