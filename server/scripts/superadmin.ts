/**
 * Create a platform super admin, or reset an existing one's password. Run on the server (it needs database access);
 * there is intentionally no web page or sign-up for this.
 *
 *   npm run superadmin -w server -- --email you@company.com --password 'NewPassw0rd' [--name "Your Name"]
 *   npm run superadmin -w server            (uses SUPER_ADMIN_EMAIL / SUPER_ADMIN_PASSWORD from server/.env)
 *
 * The password is never printed. Existing sessions of that account are signed out.
 */
import bcrypt from 'bcryptjs';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const email = (flag('email') || process.env.SUPER_ADMIN_EMAIL || '').trim().toLowerCase();
const password = flag('password') || process.env.SUPER_ADMIN_PASSWORD || '';
const name = flag('name') || 'Platform Admin';

const fail = (m: string) => { console.error(`\n✖ ${m}\n`); process.exit(1); };
if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) fail('Give a valid email: --email you@company.com (or set SUPER_ADMIN_EMAIL in server/.env).');
if (password.length < 8 || !/[A-Za-z]/.test(password) || !/\d/.test(password)) fail('The password needs at least 8 characters, including a letter and a number: --password \'...\' (or set SUPER_ADMIN_PASSWORD in server/.env).');

const { db, now, closeDb } = await import('../src/db.js');
const hash = bcrypt.hashSync(password, 12);
const existing = await db.users.get({ email });
let id: string;
if (existing) {
  id = existing.id;
  await db.users.update({ id }, { $set: { password_hash: hash, is_super_admin: 1, email_verified: 1, failed_logins: 0, locked_until: null }, $inc: { session_version: 1 } });
} else {
  id = await db.users.insert({ email, password_hash: hash, name, is_super_admin: 1, email_verified: 1, mfa_secret: null, mfa_enabled: 0, failed_logins: 0, locked_until: null, session_version: 0, created_at: now() });
}
await db.internal_staff.upsert({ user_id: id }, { role: 'super_admin', status: 'active' }, { created_at: now() });
await db.audit_logs.insert({ company_id: null, actor_id: null, actor_label: 'cli', action: existing ? 'superadmin.password_reset' : 'superadmin.created', target: id, created_at: now() });
console.log(`\n✔ Super admin ${existing ? 'updated (password reset, other sessions signed out)' : 'created'}: ${email}\n  Sign in at ${process.env.APP_URL || 'http://localhost:5173'}/login\n`);
await closeDb();
process.exit(0);
