# IntervueX: interview SaaS platform

Multi-tenant recruitment, live interview, collaborative coding, AI-assist and subscription platform, built from `Interview_SaaS_Master_Prompt.pdf`. "IntervueX" is a placeholder name.

**Stack:** React + TypeScript + Vite + Monaco (web) · Node.js + Express + TypeScript (API) · SQLite via better-sqlite3 · WebSockets + WebRTC · Judge0 (code execution) · Razorpay (payments).

> Read [docs/STATUS.md](docs/STATUS.md) first. It lists exactly what works, what needs an external service, and what is not built yet.

## Run it (development)

Requires Node 20+.

```bash
npm install
cp .env.example server/.env        # optional; sensible dev defaults exist
npm run dev                         # API on :4000, web on :5173
```

Open http://localhost:5173 and **Start free trial** to create a company. A 14-day Professional trial is created automatically.

* **Emails** (verification, invites, interview links) are printed in the API console and stored in `email_outbox` unless SMTP is configured. Dev-only responses also include the link (`devVerifyUrl`, `devInviteUrl`).
* **Super admin:** created on first start. If `SUPER_ADMIN_PASSWORD` is empty, a random password is generated and printed once in the API console. Sign in at `/login`; you are taken to `/admin`.
* **Code execution** is `disabled` by default. For a quick local demo of JavaScript/Python only, set `CODE_RUNNER=dev-local` (**not a sandbox; refused in production**). For real use, deploy [Judge0](https://github.com/judge0/judge0) and set `CODE_RUNNER=judge0`, `JUDGE0_URL=...`.
* **Payments:** without Razorpay keys the Billing page uses a dev-only payment simulator.
* **Camera/mic** work on `localhost`. On any other host you need HTTPS.

### Try a full interview locally
1. Register a company → create a job (or upload a JD) → add a candidate (upload a CV) on the job's page.
2. **Interviews → Schedule.** The API console prints the candidate's `/join/...` link.
3. Open the interviewer room (Interview page → *Open interview room*) in one window and the candidate link in a private window (use a different camera/mic or accept the shared device warning).
4. Admit the candidate from the **People** tab, start the interview, use chat, code, whiteboard, screen-share permissions, recording (needs candidate consent) and the QR secondary camera (**Session** tab).

## Tests and checks
```bash
npm run typecheck
npm test            # 10 end-to-end API tests on a throwaway database (tenant isolation, RBAC, consent, billing, MFA, WebSocket room…)
npm run build       # production web build into web/dist (served by the API)
```

## Production
`docker compose up --build` runs a single image (API + built web). Put it behind a TLS reverse proxy. Set `JWT_SECRET`, `SUPER_ADMIN_PASSWORD`, SMTP, TURN (`ICE_SERVERS`), Judge0 and Razorpay variables (see `.env.example`). Back up the `/data` volume (database, resumes, recordings). The Docker image has not been built in this repository's CI yet; treat the first build as part of your validation.

## Layout
```
server/src
  index.ts            app wiring, CSRF origin check, background jobs (reminders, retention purge)
  db.ts               schema (tenant tables carry company_id)
  auth.ts             sessions, RBAC permission map, tenant guard
  realtime.ts         WebSocket rooms: signalling, waiting room, chat, code sync, whiteboard, consent, recording state
  code.ts             Judge0 / dev-local runner, test-case judging
  services.ts         audit, mail, notifications, entitlements & usage metering, file storage, signed links
  parsing.ts          PDF/DOCX text extraction, JD/CV parsing, transparent skill-match
  routes/*            auth, company/team, recruitment, interviews, public (candidate/QR), coding, evaluation+AI, analytics, billing, admin
  test/api.test.ts    integration tests
web/src
  pages/*             marketing, auth, dashboard, jobs, candidates, interviews, feedback, playback, analytics, team, settings, billing, admin, join, camera
  room/               useRoom (WebRTC mesh + perfect negotiation), RoomView, Monaco code panel, whiteboard
docs/                 STATUS, ARCHITECTURE, SECURITY-PRIVACY, PRD-MVP
```
