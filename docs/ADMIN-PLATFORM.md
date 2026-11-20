# Super Admin, provisioning and entitlements: architecture and plan

Status: **Phase 1 (inspection) and Phase 2 (schema + migrations + tests) are done.** Phases 3-10 are not started. Nothing below Phase 2 is implemented unless it says so.

## Phase 1: what exists today

| Concern | Current implementation |
|---|---|
| Stack | Express + TypeScript (tsx), **MongoDB** (official driver; Atlas in production), React 18 + Vite. **Not** NestJS / PostgreSQL / TypeORM as the brief assumes. |
| Tenancy | `company_id` on every tenant table; tenant id comes only from the signed session (`req.auth.companyId`). Tested. |
| Roles | Company roles `owner, admin, recruiter, interviewer, hiring_manager` (permission map in `auth.ts`). Candidates have no account; they use personal expiring links. Platform: one boolean `users.is_super_admin`. |
| Super admin | `/api/admin/*` (`routes/admin.ts`): stats, companies list/detail, suspend, subscription change, plans CRUD, coupons, flags, announcements, invoices, support, audit, time-boxed read-only support sessions. Web console in `pages/Admin.tsx`. |
| Plans/entitlements | `plans.entitlements` JSON blob (booleans + numeric caps) merged with `subscriptions.custom_entitlements`; enforced in `services.ts` `enforce()` (feature gate + monthly counters). |
| Usage | `usage_records` with per-period totals; 80%/100% warning notices. |
| Audit | `audit_logs` table written by `audit()`. |
| Invites | Company member invites (`member_invites`, hashed token, 7 days). No company-admin provisioning flow. |

### Gaps against the brief
1. Only one internal role (all-powerful super admin). No Support / Billing / Platform admin separation.
2. A super admin cannot *create* a company or its first admin; companies self-register.
3. Features are a handful of boolean flags in a JSON blob. No catalog, no per-feature plan/override/temporary-grant model, no source labels.
4. Limits exist for members, interviews, code runs, AI calls and recording MB only. No recruiters/interviewers/active jobs/candidates/storage/concurrent-rooms limits.
5. Company profile lacks contact person/phone/country/address/logo/employee count; subscriptions lack custom price/discount/suspension.
6. No activation-invitation flow for admins (password set by the admin through a single-use link).

## Deliberate decision: keep the stack
The brief says to explain before changing the database layer. **Recommendation: do not migrate to NestJS/PostgreSQL/TypeORM for this work.** Reasons: the existing app is tested and working; the multi-tenant model, RBAC and entitlement concepts map directly; a stack rewrite would cost weeks and add risk without adding any of the requested capability. The schema below is plain relational SQL and ports to PostgreSQL unchanged when you scale beyond one server (see ARCHITECTURE.md "Scaling path"). If you still want NestJS, that should be a separate, explicit project.

## Phase 2: schema (implemented)

Versioned forward-only migrations live in `server/src/migrations/` and are tracked in the `schema_migrations` collection. In MongoDB a migration creates indexes (unique constraints), installs collection validators (CHECK equivalents) and back-fills data; foreign keys are enforced in application code. Version 1 creates the baseline indexes; version 2 adds these collections:

| Table | Purpose |
|---|---|
| `features` | Catalog (key `category.name`, label, category, `implemented` flag so unbuilt features are labelled honestly). 9 categories, 53 features from the brief. |
| `plan_features` | Features included by a plan. |
| `company_feature_overrides` | Super-admin enable/disable for one company (`enabled` 0/1, reason, set_by). |
| `temporary_feature_grants` | Time-boxed access (`starts_at`, `expires_at` > start, revocable). |
| `limit_definitions`, `plan_limits`, `company_limit_overrides` | 12 named limits (`-1` = unlimited); plan default plus per-company override. |
| `internal_staff` | Platform roles `super_admin, platform_admin, support_admin, billing_admin`; existing super admins are backfilled as `super_admin`. |
| `invitations` | Single-use, hashed, expiring activation tokens (`company_admin_activation`, `internal_staff_activation`). |
| `companies` (+cols) | email, contact_person, contact_phone, country, address, logo_key, employee_count, deactivated_at, created_by. |
| `subscriptions` (+cols) | custom_price_monthly/yearly, discount_percent, suspended_at, notes. |

Resolution rule (to be implemented in Phase 6, defined here):
`effective(feature) = active temporary grant → ON | company override → its value | plan_features contains key → ON | else OFF`, and the source is reported as *Temporary Grant*, *Custom Override* or *Plan Default*. Limits: `company_limit_overrides` else `plan_limits`.

Backfill: `plan_features`/`plan_limits` are derived once from the legacy `plans.entitlements` JSON (`catalog.ts` `legacyFeatureKeys`), never overwriting later edits. New limits without a legacy value start at `-1` so current behaviour does not change.

**Important:** Phase 2 does not change enforcement. The app still enforces the legacy entitlement JSON until Phases 5-7 move `enforce()` onto the new tables.

## Commands
```bash
npm run dev            # migrations run automatically on API start
npm test               # api.test.ts (10) + migrations.test.ts (9)
npm run typecheck
```
There is no separate migrate command: `runMigrations()` runs at start and is idempotent. Moving existing SQLite data: `cd server && MONGODB_URI=... npm run import:sqlite -- ../storage/app.db`.

## Remaining phases
3 internal-staff auth and permissions · 4 company + first-admin provisioning with activation email · 5 plan and feature-catalog admin APIs · 6 entitlement resolver, overrides, temporary grants, enforcement · 7 usage limits for the new limits · 8-9 Super Admin UI (wizard, feature checkboxes) · 10 subscription admin, audit coverage, remaining tests.
