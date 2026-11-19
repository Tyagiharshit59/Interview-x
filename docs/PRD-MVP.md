# PRD & MVP scope (condensed)

## Goal
One product where a company can run its hiring loop: define jobs, manage candidates, schedule and conduct interviews (video, code, whiteboard), evaluate fairly with humans in charge, and pay for it with transparent plans. Privacy and consent are product features, not footnotes.

## Personas
Platform Super Admin · Company Owner/Admin · Recruiter · Interviewer · Hiring Manager · Candidate (see permission matrix in `server/src/auth.ts`).

## Key journeys
1. **Admin:** register → verify email → (optionally) MFA → invite team → set recording/AI policies → subscribe.
2. **Recruiter:** create job (upload JD) → add candidates (CV upload/CSV) → shortlist → schedule interview → candidate invited.
3. **Interviewer:** open room → admit candidate → video + code + whiteboard → (optional recording with consent, QR second camera) → end → submit evidence-based feedback.
4. **Hiring manager:** review consolidated feedback, playback with timeline, record the human decision.
5. **Candidate:** open personal link → confirm identity → device check → read notices → waiting room → interview → can withdraw consent.

## Non-functional targets (proposed; to be validated by load tests that have **not** been run)
Page interaction p95 < 300 ms API; join-to-connected < 10 s on typical broadband; recoverable reconnect < 15 s; availability goal 99.5% for MVP deployment; recordings upload resilient to retry; RPO/RTO per backup policy you set.

## MVP (what is built, in priority order)
**Must:** auth + tenancy + RBAC, jobs, candidates/CV, scheduling + expiring invites, room (video/audio/chat/screen share/waiting room), consent, feedback + human decisions, billing & entitlements, audit.
**Should:** coding workspace + Judge0, recording + playback + timeline, whiteboard, analytics, AI drafts, QR second camera, super admin.
**Later:** SSO, calendar integrations, SFU (LiveKit), server-side STT, real-time CRDT editing, SMS/WhatsApp, recurring billing/dunning, e-invoicing/PDF invoices, international gateways, API access, branding, browser E2E/load/security test suites.
**Out of scope (by design):** facial/emotion/voice analysis, automatic rejection or ranking-as-decision, covert capture of any device.

## Acceptance criteria highlights
* A user from company A can never read or modify company B's data (tested).
* A candidate cannot enter a room without a valid unexpired link + matching email and admission by staff (tested).
* Recording cannot start and cannot be uploaded without recorded candidate consent (tested). Secondary-camera recording needs separate consent (tested).
* Only interviewers on an interview can submit feedback; others' feedback is hidden until submission; final decisions require decision permission (tested).
* Plans/limits are data, enforced server-side, editable in Super Admin (tested for limits and feature gating).
* AI output is labelled, editable and never changes a candidate's stage (by construction).
