import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';

fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export const uid = () => crypto.randomUUID();
export const now = () => new Date().toISOString();

/**
 * Tenant-owned tables carry company_id and EVERY query on them must filter by it.
 * Platform-level tables: users (global identity), plans, coupons, feature_flags, announcements, webhook_events.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, password_hash TEXT NOT NULL, name TEXT NOT NULL,
  is_super_admin INTEGER NOT NULL DEFAULT 0, email_verified INTEGER NOT NULL DEFAULT 0,
  mfa_secret TEXT, mfa_enabled INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0, locked_until TEXT,
  session_version INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS user_tokens (
  token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose TEXT NOT NULL, expires_at TEXT NOT NULL, used_at TEXT, payload TEXT
);
CREATE TABLE IF NOT EXISTS plans (
  id TEXT PRIMARY KEY, code TEXT NOT NULL UNIQUE, name TEXT NOT NULL, description TEXT,
  price_monthly INTEGER NOT NULL, price_yearly INTEGER NOT NULL, currency TEXT NOT NULL DEFAULT 'INR',
  entitlements TEXT NOT NULL, overage TEXT NOT NULL DEFAULT '{}', is_public INTEGER NOT NULL DEFAULT 1,
  is_active INTEGER NOT NULL DEFAULT 1, sort_order INTEGER NOT NULL DEFAULT 0, trial_days INTEGER NOT NULL DEFAULT 14
);
CREATE TABLE IF NOT EXISTS companies (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, website TEXT, industry TEXT, size TEXT,
  gst_number TEXT, billing_address TEXT, state TEXT, status TEXT NOT NULL DEFAULT 'active',
  settings TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS company_members (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active', created_at TEXT NOT NULL, UNIQUE(company_id, user_id)
);
CREATE TABLE IF NOT EXISTS member_invites (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  email TEXT NOT NULL, role TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, invited_by TEXT NOT NULL,
  expires_at TEXT NOT NULL, accepted_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL UNIQUE REFERENCES companies(id) ON DELETE CASCADE,
  plan_id TEXT NOT NULL REFERENCES plans(id), status TEXT NOT NULL, billing_cycle TEXT NOT NULL DEFAULT 'monthly',
  trial_ends_at TEXT, current_period_start TEXT NOT NULL, current_period_end TEXT NOT NULL,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0, custom_entitlements TEXT, coupon_code TEXT,
  gateway TEXT, gateway_ref TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coupons (
  code TEXT PRIMARY KEY, percent_off INTEGER NOT NULL, max_redemptions INTEGER, redeemed INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT, is_active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS invoices (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  number TEXT NOT NULL UNIQUE, description TEXT NOT NULL, plan_id TEXT, billing_cycle TEXT,
  subtotal INTEGER NOT NULL, discount INTEGER NOT NULL DEFAULT 0,
  cgst INTEGER NOT NULL DEFAULT 0, sgst INTEGER NOT NULL DEFAULT 0, igst INTEGER NOT NULL DEFAULT 0, total INTEGER NOT NULL,
  currency TEXT NOT NULL DEFAULT 'INR', status TEXT NOT NULL, gateway TEXT, gateway_ref TEXT UNIQUE,
  billing_snapshot TEXT, coupon_code TEXT, issued_at TEXT NOT NULL, paid_at TEXT
);
CREATE TABLE IF NOT EXISTS webhook_events (id TEXT PRIMARY KEY, provider TEXT NOT NULL, received_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS usage_records (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  metric TEXT NOT NULL, quantity REAL NOT NULL, ref_id TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_company_metric ON usage_records(company_id, metric, created_at);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL, department TEXT, location TEXT, employment_type TEXT, exp_min INTEGER, exp_max INTEGER,
  description TEXT, responsibilities TEXT, required_skills TEXT NOT NULL DEFAULT '[]', preferred_skills TEXT NOT NULL DEFAULT '[]',
  qualifications TEXT, screening_questions TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'draft',
  is_template INTEGER NOT NULL DEFAULT 0, recruiter_id TEXT, interviewer_ids TEXT NOT NULL DEFAULT '[]',
  created_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company_id, status);
CREATE TABLE IF NOT EXISTS candidates (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  name TEXT NOT NULL, email TEXT NOT NULL, phone TEXT, current_title TEXT, current_company TEXT, location TEXT,
  experience_years REAL, skills TEXT NOT NULL DEFAULT '[]', tags TEXT NOT NULL DEFAULT '[]', source TEXT,
  created_by TEXT, created_at TEXT NOT NULL, UNIQUE(company_id, email)
);
CREATE TABLE IF NOT EXISTS candidate_resumes (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  file_key TEXT NOT NULL, original_name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL,
  parsed_text TEXT, uploaded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, candidate_id TEXT NOT NULL REFERENCES candidates(id) ON DELETE CASCADE,
  stage TEXT NOT NULL DEFAULT 'Applied', match_score INTEGER, match_detail TEXT, decision TEXT, decision_by TEXT, decision_note TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(job_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS idx_app_company ON applications(company_id, stage);
CREATE TABLE IF NOT EXISTS application_notes (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, application_id TEXT, candidate_id TEXT, actor_id TEXT, action TEXT NOT NULL, detail TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interviews (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL REFERENCES applications(id) ON DELETE CASCADE, round_no INTEGER NOT NULL DEFAULT 1,
  title TEXT NOT NULL, type TEXT NOT NULL DEFAULT 'technical', scheduled_at TEXT NOT NULL, duration_min INTEGER NOT NULL DEFAULT 60,
  timezone TEXT NOT NULL DEFAULT 'UTC', instructions TEXT, status TEXT NOT NULL DEFAULT 'scheduled',
  config TEXT NOT NULL DEFAULT '{}', created_by TEXT, created_at TEXT NOT NULL, started_at TEXT, ended_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_int_company ON interviews(company_id, scheduled_at);
CREATE TABLE IF NOT EXISTS interview_participants (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id), role TEXT NOT NULL DEFAULT 'interviewer', UNIQUE(interview_id, user_id)
);
CREATE TABLE IF NOT EXISTS interview_invitations (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, revoked_at TEXT, last_used_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS camera_sessions (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE, expires_at TEXT NOT NULL, claimed_at TEXT, ended_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS consent_records (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, interview_id TEXT NOT NULL, subject TEXT NOT NULL,
  kind TEXT NOT NULL, granted INTEGER NOT NULL, notice_version TEXT NOT NULL, ip TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interview_recordings (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  source TEXT NOT NULL, file_key TEXT, mime TEXT, size INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'recording',
  started_by TEXT, retain_until TEXT, created_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS recording_events (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, label TEXT, offset_sec REAL NOT NULL DEFAULT 0, author_id TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS chat_messages (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  sender_name TEXT NOT NULL, sender_role TEXT NOT NULL, body TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coding_questions (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  title TEXT NOT NULL, prompt TEXT NOT NULL, difficulty TEXT NOT NULL DEFAULT 'medium', category TEXT, languages TEXT NOT NULL DEFAULT '[]',
  starter_code TEXT NOT NULL DEFAULT '{}', time_limit_sec INTEGER NOT NULL DEFAULT 2, scoring_criteria TEXT, kind TEXT NOT NULL DEFAULT 'coding',
  created_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coding_test_cases (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, question_id TEXT NOT NULL REFERENCES coding_questions(id) ON DELETE CASCADE,
  input TEXT NOT NULL DEFAULT '', expected_output TEXT NOT NULL DEFAULT '', is_hidden INTEGER NOT NULL DEFAULT 0, weight INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS coding_assessments (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  question_id TEXT REFERENCES coding_questions(id), language TEXT NOT NULL DEFAULT 'javascript', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coding_submissions (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  question_id TEXT, user_id TEXT, language TEXT NOT NULL, code TEXT NOT NULL, kind TEXT NOT NULL, passed INTEGER, total INTEGER,
  score REAL, results TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS coding_execution_logs (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, interview_id TEXT, language TEXT, status TEXT, time_ms REAL, memory_kb REAL, stdout TEXT, stderr TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS code_snapshots (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  file_name TEXT NOT NULL, language TEXT, content TEXT NOT NULL, author TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS whiteboard_sessions (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, interview_id TEXT NOT NULL UNIQUE REFERENCES interviews(id) ON DELETE CASCADE,
  data TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS evaluation_templates (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, name TEXT NOT NULL, criteria TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS interview_feedback (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  interviewer_id TEXT NOT NULL REFERENCES users(id), ratings TEXT NOT NULL DEFAULT '{}', evidence TEXT, private_notes TEXT,
  recommendation TEXT, submitted INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  UNIQUE(interview_id, interviewer_id)
);
CREATE TABLE IF NOT EXISTS interview_transcripts (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, interview_id TEXT NOT NULL REFERENCES interviews(id) ON DELETE CASCADE,
  speaker TEXT, text TEXT NOT NULL, offset_sec REAL NOT NULL DEFAULT 0, source TEXT NOT NULL DEFAULT 'manual', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ai_reports (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, interview_id TEXT, job_id TEXT, kind TEXT NOT NULL, content TEXT NOT NULL,
  provider TEXT NOT NULL, created_by TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id TEXT PRIMARY KEY, company_id TEXT, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT, link TEXT, read_at TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notification_prefs (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, email_enabled INTEGER NOT NULL DEFAULT 1, reminders INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS email_outbox (
  id TEXT PRIMARY KEY, company_id TEXT, to_email TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued', error TEXT, created_at TEXT NOT NULL, sent_at TEXT
);
CREATE TABLE IF NOT EXISTS integrations (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE, kind TEXT NOT NULL, config TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, UNIQUE(company_id, kind)
);
CREATE TABLE IF NOT EXISTS feature_flags (key TEXT PRIMARY KEY, enabled INTEGER NOT NULL DEFAULT 0, description TEXT);
CREATE TABLE IF NOT EXISTS announcements (id TEXT PRIMARY KEY, message TEXT NOT NULL, level TEXT NOT NULL DEFAULT 'info', active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS support_requests (
  id TEXT PRIMARY KEY, company_id TEXT NOT NULL, user_id TEXT NOT NULL, subject TEXT NOT NULL, body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', support_access_until TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS audit_logs (
  id TEXT PRIMARY KEY, company_id TEXT, actor_id TEXT, actor_label TEXT, action TEXT NOT NULL, target TEXT, detail TEXT, ip TEXT, created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_audit_company ON audit_logs(company_id, created_at);
`;
db.exec(SCHEMA);

export const j = <T = any>(s: string | null | undefined, fallback: T): T => {
  if (!s) return fallback;
  try { return JSON.parse(s) as T; } catch { return fallback; }
};
