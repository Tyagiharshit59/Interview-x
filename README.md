# IntervueX: interview SaaS platform

Multi-tenant recruitment, live interview, collaborative coding, AI-assist and subscription platform, built from `Interview_SaaS_Master_Prompt.pdf`. "IntervueX" is a placeholder name.

**Stack:** React + TypeScript + Vite + Monaco (web) · Node.js + Express + TypeScript (API) · MongoDB (Atlas in production; embedded mongod in development) · WebSockets + WebRTC · Judge0 (code execution) · Razorpay (payments).

> Read [docs/STATUS.md](docs/STATUS.md) first. It lists exactly what works, what needs an external service, and what is not built yet.

## Run it (development)

Requires Node 20+.

```bash
npm install
cp .env.example server/.env        # optional; sensible dev defaults exist
npm run dev                         # API on :4000, web on :5173 (first start downloads an embedded MongoDB, ~600 MB, once)
```

Open http://localhost:5173 and **Start free trial** to create a company. A 14-day Professional trial is created automatically.

* **Emails** (verification, invites, interview links) are printed in the API console and stored in `email_outbox` unless SMTP is configured. Dev-only responses also include the link (`devVerifyUrl`, `devInviteUrl`).
* **Super admin:** created on first start. If `SUPER_ADMIN_PASSWORD` is empty, a random password is generated and printed once in the API console. Sign in at `/login`; you are taken to `/admin`.
* **Code execution** is `disabled` by default. For a quick local demo of JavaScript/Python only, set `CODE_RUNNER=dev-local` (**not a sandbox; refused in production**). For real use, deploy [Judge0](https://github.com/judge0/judge0) and set `CODE_RUNNER=judge0`, `JUDGE0_URL=...`.
* **Payments:** without Razorpay keys the Billing page uses a dev-only payment simulator.
* **Camera/mic** work on `localhost`. On any other host you need HTTPS.

### Careers portal for job seekers
Open http://localhost:5173/portal. Job seekers create their own profile (separate from company accounts), search and save jobs, get skill-based recommendations, apply with their CV, track applications, read updates a company shares, and join interviews they were invited to. Company data is shown only for the candidate's **verified** email. Published jobs are listed unless "List on the public careers portal" is unticked in the job editor.

### Employee referral portal
HR or admins add employees in **Team → Add team member** (role *Employee*) or **Referral programme → Employees**; there is no self sign-up. Employees activate with a one-time link, then see only **Refer & earn** and **My referrals**: open roles with bonuses, a refer form (with consent and optional CV) and the progress and bonus status of their referrals. HR manages bonuses (ready → paid / declined), the leaderboard and programme rules in **Referral programme**; per-job bonuses are set in the job editor. Employee accounts cannot reach any hiring data (server-side default deny) and do not use paid team seats.

### Open it on your phone (same Wi-Fi)
`npm run dev:phone` serves the web app over HTTPS on your local network (phones only allow camera/microphone on HTTPS). Open the **Network** address it prints (e.g. `https://192.168.x.x:5173`) on the phone, accept the self-signed certificate warning, and allow Node.js through Windows Firewall on *Private* networks if asked. Set `APP_URL` in `server/.env` to that address so emailed/printed invite links point to it.

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

## Database (MongoDB)
* **Development/tests:** leave `MONGODB_URI` empty; an embedded MongoDB runs inside the API and stores data in `storage/mongo-data`.
* **Production:** create a MongoDB Atlas cluster, allow your server's IP in Atlas *Network Access*, create a database user, and set `MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster.../?retryWrites=true&w=majority` (and optionally `MONGODB_DB`). The API refuses to start in production without it. Indexes are created automatically on start.
* **Existing SQLite data:** `cd server && MONGODB_URI=... npm run import:sqlite -- ../storage/app.db` (refuses to overwrite a non-empty database unless `--force`). Copy `storage/files` to the new server as well.

## Production
`docker compose up --build` runs a single image (API + built web). Put it behind a TLS reverse proxy. Set `JWT_SECRET`, `SUPER_ADMIN_PASSWORD`, SMTP, TURN (`ICE_SERVERS`), Judge0 and Razorpay variables (see `.env.example`). Back up the `/data` volume (resumes, recordings) and enable Atlas backups for the database. The Docker image has not been built in this repository's CI yet; treat the first build as part of your validation.

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
