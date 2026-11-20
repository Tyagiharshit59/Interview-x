/**
 * Reference data for the feature catalog and limit definitions.
 * This is the *vocabulary* the Super Admin chooses from. Which plan/company gets which feature lives in the database
 * (plan_features, company_feature_overrides, temporary_feature_grants), never in this file.
 * `implemented: false` marks catalog entries the product does not provide yet, so the UI can label them honestly.
 */
export interface FeatureDef { key: string; category: string; label: string; description?: string; implemented?: boolean }

export const CATEGORIES: Array<{ id: string; label: string }> = [
  { id: 'company', label: 'Company and team management' }, { id: 'jobs', label: 'Job and candidate management' },
  { id: 'interview', label: 'Interview management' }, { id: 'coding', label: 'Coding assessment' }, { id: 'live', label: 'Live interview' },
  { id: 'ai', label: 'AI features' }, { id: 'analytics', label: 'Analytics and reporting' }, { id: 'integrations', label: 'Integrations' },
  { id: 'security', label: 'Security and administration' },
];

const f = (category: string, name: string, label: string, implemented = true, description?: string): FeatureDef => ({ key: `${category}.${name}`, category, label, description, implemented });

export const FEATURES: FeatureDef[] = [
  f('company', 'dashboard', 'Company dashboard'), f('company', 'profile', 'Company profile'), f('company', 'team_management', 'Team management'),
  f('company', 'team_invitations', 'Team invitations'), f('company', 'role_management', 'Role management'), f('company', 'multiple_admins', 'Multiple administrators'),
  f('jobs', 'creation', 'Job creation'), f('jobs', 'description_uploads', 'Job description uploads'), f('jobs', 'candidate_management', 'Candidate management'),
  f('jobs', 'cv_uploads', 'CV uploads'), f('jobs', 'application_tracking', 'Candidate application tracking'),
  f('jobs', 'candidate_portal', 'Candidate portal', false, 'Candidates currently join interviews through personal links; there is no candidate account portal yet.'),
  f('jobs', 'candidate_invitation_links', 'Candidate invitation links'),
  f('interview', 'scheduling', 'Interview scheduling'), f('interview', 'calendar', 'Interview calendar'), f('interview', 'invitations', 'Interview invitations'),
  f('interview', 'multiple_interviewers', 'Multiple interviewers'), f('interview', 'feedback', 'Interview feedback'), f('interview', 'evaluation_forms', 'Interview evaluation forms'),
  f('interview', 'reports', 'Interview reports'),
  f('coding', 'editor', 'Online coding editor'), f('coding', 'multiple_languages', 'Multiple programming languages'), f('coding', 'execution', 'Code execution', true, 'Needs a Judge0 runner configured on the server.'),
  f('coding', 'custom_test_cases', 'Custom test cases'), f('coding', 'auto_evaluation', 'Automated test evaluation'), f('coding', 'reports', 'Coding assessment reports'),
  f('coding', 'submission_history', 'Code submission history'),
  f('live', 'audio', 'Audio calling'), f('live', 'video', 'Video calling'), f('live', 'screen_sharing', 'Screen sharing'), f('live', 'chat', 'Real-time chat'),
  f('live', 'recording', 'Interview recording'), f('live', 'secondary_camera', 'Candidate-controlled secondary camera'), f('live', 'qr_pairing', 'QR-based camera pairing'),
  f('live', 'session_reports', 'Interview session reports'),
  f('ai', 'questions', 'AI-generated interview questions'),
  f('ai', 'resume_analysis', 'AI resume analysis', false, 'Resume parsing and keyword skill-match exist; AI-model resume analysis does not.'),
  f('ai', 'interview_summaries', 'AI interview summaries'), f('ai', 'coding_evaluation', 'AI coding evaluation'),
  f('ai', 'candidate_recommendations', 'AI candidate recommendations', false, 'By design the product does not auto-recommend hire/reject; if built, output must remain a labelled aid for humans.'),
  f('analytics', 'company', 'Company analytics'), f('analytics', 'interview', 'Interview analytics'), f('analytics', 'candidate_reports', 'Candidate reports'),
  f('analytics', 'recruiter_performance', 'Recruiter performance'), f('analytics', 'export', 'Export reports'), f('analytics', 'advanced', 'Advanced analytics', false),
  f('integrations', 'email', 'Email integration'), f('integrations', 'calendar', 'Calendar integration', true, 'Calendar (.ics) invitations only; no live Google/Outlook sync.'),
  f('integrations', 'webhooks', 'Webhooks', false), f('integrations', 'api', 'API access', false), f('integrations', 'custom', 'Custom integrations', false),
  f('security', 'audit_logs', 'Audit logs'), f('security', 'advanced_roles', 'Advanced role permissions', false), f('security', 'sso', 'Single sign-on (SSO)', false),
  f('security', 'mfa', 'Multi-factor authentication'), f('security', 'custom_retention', 'Custom retention policies'),
];

export interface LimitDef { key: string; label: string; unit: string; period: 'month' | 'total' | 'concurrent' | 'days'; legacy?: string }
/** Value -1 means unlimited. `legacy` names the key in the old plans.entitlements JSON, used to backfill. */
export const LIMITS: LimitDef[] = [
  { key: 'members', label: 'Team members', unit: 'users', period: 'total', legacy: 'members' },
  { key: 'recruiters', label: 'Recruiters', unit: 'users', period: 'total' },
  { key: 'interviewers', label: 'Interviewers', unit: 'users', period: 'total' },
  { key: 'interviews_per_month', label: 'Interviews per month', unit: 'interviews', period: 'month', legacy: 'interviews_per_month' },
  { key: 'active_jobs', label: 'Active jobs', unit: 'jobs', period: 'total' },
  { key: 'candidates', label: 'Candidates', unit: 'candidates', period: 'total' },
  { key: 'storage_mb', label: 'Document storage', unit: 'MB', period: 'total' },
  { key: 'recording_storage_mb', label: 'Recording storage', unit: 'MB', period: 'total', legacy: 'recording_storage_mb' },
  { key: 'concurrent_rooms', label: 'Concurrent interview rooms', unit: 'rooms', period: 'concurrent' },
  { key: 'code_runs_per_month', label: 'Code runs per month', unit: 'runs', period: 'month', legacy: 'code_runs_per_month' },
  { key: 'ai_calls_per_month', label: 'AI calls per month', unit: 'calls', period: 'month', legacy: 'ai_calls_per_month' },
  { key: 'recording_retention_days', label: 'Recording retention', unit: 'days', period: 'days', legacy: 'recording_retention_days' },
];

/** Which catalog features the legacy boolean entitlement flags imply. Used only to backfill plan_features; afterwards plan_features is the source of truth. */
const byCat = (c: string) => FEATURES.filter(x => x.category === c).map(x => x.key);
const CORE = [
  'company.dashboard', 'company.profile', 'company.team_management', 'company.team_invitations', 'company.role_management', ...byCat('jobs'),
  'interview.scheduling', 'interview.calendar', 'interview.invitations', 'interview.multiple_interviewers', 'interview.feedback', 'interview.reports',
  'live.audio', 'live.video', 'live.screen_sharing', 'live.chat', 'live.session_reports', 'integrations.email', 'integrations.calendar', 'security.audit_logs', 'security.mfa',
];
export function legacyFeatureKeys(ent: Record<string, any>): string[] {
  const on = new Set<string>(CORE);
  if (ent.coding) byCat('coding').forEach(k => on.add(k));
  if (ent.recording) on.add('live.recording');
  if (ent.secondary_camera) { on.add('live.secondary_camera'); on.add('live.qr_pairing'); }
  if (ent.ai) byCat('ai').forEach(k => on.add(k));
  if (ent.analytics) ['analytics.company', 'analytics.interview', 'analytics.candidate_reports', 'analytics.recruiter_performance', 'analytics.export'].forEach(k => on.add(k));
  if (ent.custom_evaluation) ['interview.evaluation_forms', 'company.multiple_admins', 'analytics.advanced', 'security.advanced_roles', 'security.custom_retention'].forEach(k => on.add(k));
  if (ent.sso) on.add('security.sso');
  if (ent.api_access) ['integrations.webhooks', 'integrations.api', 'integrations.custom'].forEach(k => on.add(k));
  return [...on];
}
