/**
 * Field defaults carried over from the old SQL schema (column DEFAULT clauses).
 * MongoDB has no column defaults, so the data layer fills these in on every insert (and migration 3 back-fills existing documents).
 * Only add a field here if the app relies on it always being present.
 */
export const DEFAULTS: Record<string, Record<string, string | number>> = {
  users: {is_super_admin: 0, email_verified: 0, mfa_enabled: 0, failed_logins: 0, session_version: 0},
  plans: {currency: 'INR', overage: '{}', is_public: 1, is_active: 1, sort_order: 0, trial_days: 14},
  companies: {status: 'active', settings: '{}'},
  company_members: {status: 'active'},
  subscriptions: {billing_cycle: 'monthly', cancel_at_period_end: 0, discount_percent: 0},
  coupons: {redeemed: 0, is_active: 1},
  invoices: {discount: 0, cgst: 0, sgst: 0, igst: 0, currency: 'INR'},
  jobs: {required_skills: '[]', preferred_skills: '[]', screening_questions: '[]', status: 'draft', is_template: 0, interviewer_ids: '[]'},
  candidates: {skills: '[]', tags: '[]'},
  applications: {stage: 'Applied'},
  interviews: {round_no: 1, type: 'technical', duration_min: 60, timezone: 'UTC', status: 'scheduled', config: '{}'},
  interview_participants: {role: 'interviewer'},
  interview_recordings: {size: 0, status: 'recording'},
  recording_events: {offset_sec: 0},
  coding_questions: {difficulty: 'medium', languages: '[]', starter_code: '{}', time_limit_sec: 2, kind: 'coding'},
  coding_test_cases: {input: '', expected_output: '', is_hidden: 0, weight: 1},
  coding_assessments: {language: 'javascript'},
  whiteboard_sessions: {data: '[]'},
  interview_feedback: {ratings: '{}', submitted: 0},
  interview_transcripts: {offset_sec: 0, source: 'manual'},
  notification_prefs: {email_enabled: 1, reminders: 1},
  email_outbox: {status: 'queued'},
  integrations: {config: '{}', enabled: 0},
  feature_flags: {enabled: 0},
  features: {implemented: 1, is_active: 1, sort_order: 0},
  limit_definitions: {sort_order: 0},
  internal_staff: {status: 'active'},
  announcements: {level: 'info', active: 1},
  support_requests: {status: 'open'},
};
