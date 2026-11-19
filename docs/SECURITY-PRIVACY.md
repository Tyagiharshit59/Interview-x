# Security & privacy plan

**This document describes controls implemented in the code and gaps. It is not a compliance claim.** Have qualified counsel review notices, retention periods, cross-border processing and candidate rights (including India's DPDP Act and rules, and any jurisdiction where your customers or candidates are). Commission a penetration test before launch.

## Implemented controls
| Area | Control |
|------|---------|
| Auth | bcrypt (cost 12); password policy; lockout after 5 failures for 15 min; generic errors; reset tokens single-use, 1 h, hashed at rest; password reset/change bumps `session_version` (all sessions die); httpOnly + SameSite=Lax cookies (`Secure` in production); TOTP MFA |
| CSRF | SameSite cookies + JSON/multipart bodies + explicit cross-origin rejection on state-changing `/api` requests |
| AuthZ | Central permission map (`auth.ts`); per-route `requirePerm`; tenant id only from the session; object-level checks (`AND company_id=?`); interviewer-only feedback/recordings; human-only decisions |
| Tenant isolation | See ARCHITECTURE.md; integration-tested |
| Invitations | 256-bit random tokens, only SHA-256 stored, expiry, revocation, replaced on resend; identity confirmation; join window; rate-limited |
| Realtime | One-time 2-minute tickets; per-message role checks; payload cap; origin check in production; heartbeats; room size cap |
| Uploads | Size limits, magic-byte allow-list, extension mapping, malware-scan hook (**wire ClamAV; fail closed**), files outside web root, never served inline except recordings, `nosniff` |
| Media access | Short-lived signed URLs, re-validated tenant, access logged (`recording.accessed`, `resume.accessed`) |
| Code execution | Out-of-process via Judge0, resource limits, credentials server-side only |
| Secrets | Env-only; production refuses to start without `JWT_SECRET`; no seeded passwords |
| Headers | Helmet; CSP in production |
| Abuse | Rate limits on auth and public join/camera endpoints |
| Audit | `audit_logs` for logins, membership, jobs, decisions, billing, exports, recordings, support access |
| Support access | Only within a customer-granted window; read-only; 1 hour; every request audited |
| CSV export | Permission checked, audited, formula-injection neutralised |
| Payments | Server-side amounts, HMAC-verified webhook, idempotent by event id, no card data touches the server |

## Consent flow
1. Invite and join page disclose recording, coding workspace, optional second camera and review signals **before** joining.
2. Recording requires an explicit in-room consent from the candidate; the server refuses to start recording/uploads without a granted consent record (`consent_records`, versioned notice). Withdrawal stops recording.
3. Secondary camera: QR never activates anything; the phone page requires a consent checkbox + browser permission; **separate** consent for recording that feed; video only (no microphone); visible status; one-click stop; staff can disconnect.
4. Indicators: red recording badge for everyone; candidate "Privacy" tab shows current consent state.

## What the product deliberately does not do
No facial recognition, emotion/personality inference, accent/voice analysis, or "cheating detection" claims. Tab/window/paste events are stored as *review signals* and labelled as non-proof. AI never makes or recommends hiring/rejection decisions; skill-match is a labelled keyword aid.

## Retention & deletion
* Recording retention is per company (default 30 days, capped by plan) and enforced by a purge job every 10 minutes.
* Owners/admins can delete individual recordings and permanently delete a candidate (resumes, applications, interviews, recordings, activity).
* Backups: not implemented in app code. Define backup retention consistent with deletion promises.

## Threat model (summary)
| Threat | Mitigation | Residual risk |
|--------|-----------|---------------|
| Cross-tenant data access | Session-derived tenant, scoped queries, tests | New endpoints must follow the pattern; add a lint/test per route |
| Guessable/shared interview links | 256-bit hashed tokens, expiry, revoke, email identity check | Email forwarding by candidate; consider OTP |
| Candidate code escapes sandbox | Judge0 isolation | Depends on Judge0 hardening; keep it on separate hosts/network |
| Malicious uploads | Type/size checks, scan hook | Real AV not bundled |
| Stolen session cookie | httpOnly, Secure, 12h TTL, session_version | No device list / revoke UI |
| Secret camera/mic use | Browser permission + in-app consent + visible UI; QR needs explicit action | Phone browser UI is out of our control |
| Recording leakage | Signed 15-min URLs, role checks, audit | Interviewer can screen-record playback; legal/contractual control |
| Webhook forgery/replay | HMAC + event-id dedupe | Test against live Razorpay |
| DoS | Rate limits, payload caps | No WAF/global limits; put a proxy in front |

## Compliance review checklist
- [ ] Privacy notice, candidate notice and consent text reviewed by counsel
- [ ] Lawful basis, purpose limitation and retention schedule documented per data class
- [ ] Data principal rights workflow (access/correction/erasure/grievance officer) operationalised (deletion exists; access/correction export is manual)
- [ ] DPA with customers; sub-processors listed (email, Judge0 host, AI provider, Razorpay, hosting)
- [ ] Cross-border transfer review (AI provider, hosting region)
- [ ] Children/minor candidates policy
- [ ] Breach response runbook and notification path
- [ ] Penetration test, dependency audit, backup/restore drill
- [ ] Accessibility review (WCAG 2.2 AA) of candidate-facing pages
- [ ] GST invoice format, SAC code and e-invoicing applicability confirmed with a tax adviser
