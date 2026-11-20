import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db, uid, now } from './db.js';
import { config } from './config.js';
import { syncPlansFromLegacy } from './migrations/index.js';

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

export async function ensureSeed() {
  for (const p of PLANS) {
    if (await db.plans.exists({ code: p.code })) continue;
    await db.plans.insert({ code: p.code, name: p.name, description: p.desc, price_monthly: p.m, price_yearly: p.y, currency: 'INR', entitlements: JSON.stringify(p.e), overage: JSON.stringify({ interviews: 99, code_runs: 1 }), is_public: (p as any).isPublic === false ? 0 : 1, is_active: 1, sort_order: p.sort, trial_days: 14 });
  }
  await syncPlansFromLegacy();
  for (const [k, d] of [['ai_assistance', 'AI interview intelligence'], ['secondary_camera', 'QR secondary camera'], ['whiteboard', 'Collaborative whiteboard']] as const) {
    await db.feature_flags.upsert({ key: k }, {}, { enabled: 1, description: d });
  }
  if (!(await db.coupons.exists({}))) await db.coupons.insert({ code: 'WELCOME10', percent_off: 10, max_redemptions: 1000, redeemed: 0, expires_at: null, is_active: 1 });

  if (!(await db.users.exists({ is_super_admin: 1 }))) {
    // Never ship a known default password: use the env value, or generate one and print it once (dev only).
    let pw = config.superAdminPassword;
    let generated = false;
    if (!pw) {
      if (config.isProd) { console.warn('[seed] No SUPER_ADMIN_PASSWORD set; super admin was NOT created.'); return; }
      pw = crypto.randomBytes(9).toString('base64url') + '9'; generated = true;
    }
    const adminId = await db.users.insert({ email: config.superAdminEmail.toLowerCase(), password_hash: bcrypt.hashSync(pw, 12), name: 'Platform Admin', is_super_admin: 1, email_verified: 1, mfa_secret: null, mfa_enabled: 0, failed_logins: 0, locked_until: null, session_version: 0, created_at: now() });
    await db.internal_staff.upsert({ user_id: adminId }, { role: 'super_admin', status: 'active' }, { created_at: now() });
    if (generated) console.log(`\n[seed] Super admin created (dev). Email: ${config.superAdminEmail}  Password: ${pw}\n       Set SUPER_ADMIN_PASSWORD in .env to choose your own.\n`);
  }
}

if (process.argv[1]?.endsWith('seed.ts')) { await ensureSeed(); console.log('Seed complete.'); process.exit(0); }
