import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db, uid, now } from './db.js';
import { config } from './config.js';

/** Placeholder plans from the product brief. All values are editable in the Super Admin console. */
const PLANS = [
  { code: 'starter', name: 'Starter', desc: 'For small teams starting structured interviews.', m: 1999, y: 19990, sort: 1,
    e: { members: 2, interviews_per_month: 20, recording: false, coding: true, code_runs_per_month: 200, ai: false, ai_calls_per_month: 0, secondary_camera: false, recording_retention_days: 30, recording_storage_mb: 0, analytics: false, custom_evaluation: false } },
  { code: 'professional', name: 'Professional', desc: 'Coding, recording, AI summaries and secondary camera.', m: 4999, y: 49990, sort: 2,
    e: { members: 10, interviews_per_month: 100, recording: true, coding: true, code_runs_per_month: 2000, ai: true, ai_calls_per_month: 300, secondary_camera: true, recording_retention_days: 60, recording_storage_mb: 20000, analytics: true, custom_evaluation: false } },
  { code: 'business', name: 'Business', desc: 'Advanced AI, teams, custom evaluation and extended retention.', m: 9999, y: 99990, sort: 3,
    e: { members: 25, interviews_per_month: 300, recording: true, coding: true, code_runs_per_month: 10000, ai: true, ai_calls_per_month: 2000, secondary_camera: true, recording_retention_days: 180, recording_storage_mb: 100000, analytics: true, custom_evaluation: true } },
  { code: 'enterprise', name: 'Enterprise', desc: 'Negotiated limits, SSO, API access, branding and SLA.', m: 0, y: 0, sort: 4, isPublic: false,
    e: { members: -1, interviews_per_month: -1, recording: true, coding: true, code_runs_per_month: -1, ai: true, ai_calls_per_month: -1, secondary_camera: true, recording_retention_days: 365, recording_storage_mb: -1, analytics: true, sso: true, api_access: true, custom_evaluation: true } },
];

export function ensureSeed() {
  for (const p of PLANS) {
    if (db.prepare('SELECT 1 FROM plans WHERE code=?').get(p.code)) continue;
    db.prepare('INSERT INTO plans(id,code,name,description,price_monthly,price_yearly,entitlements,overage,is_public,sort_order,trial_days) VALUES (?,?,?,?,?,?,?,?,?,?,14)')
      .run(uid(), p.code, p.name, p.desc, p.m, p.y, JSON.stringify(p.e), JSON.stringify({ interviews: 99, code_runs: 1 }), (p as any).isPublic === false ? 0 : 1, p.sort);
  }
  for (const [k, d] of [['ai_assistance', 'AI interview intelligence'], ['secondary_camera', 'QR secondary camera'], ['whiteboard', 'Collaborative whiteboard']] as const) {
    db.prepare('INSERT OR IGNORE INTO feature_flags(key,enabled,description) VALUES (?,1,?)').run(k, d);
  }
  if (!db.prepare('SELECT 1 FROM coupons').get()) db.prepare('INSERT INTO coupons(code,percent_off,max_redemptions) VALUES (?,?,?)').run('WELCOME10', 10, 1000);

  if (!db.prepare('SELECT 1 FROM users WHERE is_super_admin=1').get()) {
    // Never ship a known default password: use the env value, or generate one and print it once (dev only).
    let pw = config.superAdminPassword;
    let generated = false;
    if (!pw) {
      if (config.isProd) { console.warn('[seed] No SUPER_ADMIN_PASSWORD set; super admin was NOT created.'); return; }
      pw = crypto.randomBytes(9).toString('base64url') + '9'; generated = true;
    }
    db.prepare('INSERT INTO users(id,email,password_hash,name,is_super_admin,email_verified,created_at) VALUES (?,?,?,?,1,1,?)').run(uid(), config.superAdminEmail, bcrypt.hashSync(pw, 12), 'Platform Admin', now());
    if (generated) console.log(`\n[seed] Super admin created (dev). Email: ${config.superAdminEmail}  Password: ${pw}\n       Set SUPER_ADMIN_PASSWORD in .env to choose your own.\n`);
  }
}

if (process.argv[1]?.endsWith('seed.ts')) { ensureSeed(); console.log('Seed complete.'); }
