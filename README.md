# Overlay Profile Editor

Production-ready MVP monorepo for editing online streaming overlay profiles with a Windows desktop editor and a single stable OBS Browser Source URL per profile.

## Stack
- pnpm workspaces + TypeScript monorepo
- Desktop: Electron + React + Vite + react-konva
- Backend: Supabase (Postgres/Auth/Edge Functions)
- Renderer: React + Vite web app for OBS browser source
- Packaging: electron-builder
- Release CI: GitHub Actions

## Monorepo structure
- `apps/desktop`: German UI editor app (Draft editing, LIVE publish panel)
- `apps/renderer`: OBS overlay renderer route `/p/:profileId`
- `packages/shared`: Zod scene schema, role helpers
- `supabase/migrations`: schema + RLS + SQL functions
- `supabase/functions`: edge functions for profile auth, role ops, publish/activation, public active overlay
- `.github/workflows/release.yml`: Windows EXE release workflow

## MVP behavior
- One stable OBS URL per profile: `https://<rendererBase>/p/<profileId>?key=<viewKey>`
- Draft and published separation is enforced.
- OBS fetches only published active overlay from edge function.
- Two-step activation:
  - set pending activation
  - publish pending activation to go live
- Moderator can edit drafts only.
- Admin/Streamer controls available in dedicated LIVE panel only.
- Presence via heartbeat (`profile_presence` updates every 10s, visible within 30s).

## Quickstart
### 1) Install
```bash
pnpm install
```

### 2) Supabase project setup
1. Create a Supabase project.
2. In **Authentication > Providers**, enable Google OAuth.
3. Create Google OAuth Client in Google Cloud Console:
   - Add Supabase callback URL shown in provider settings.
   - Add desktop dev redirect URIs if needed.
4. Add env values:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`

### 3) Run migrations
```bash
supabase db push
```

### 4) Deploy edge functions
```bash
supabase functions deploy create-profile
supabase functions deploy join-profile
supabase functions deploy set-member-role
supabase functions deploy remove-member
supabase functions deploy rotate-view-key
supabase functions deploy set-pending-activation
supabase functions deploy publish-overlay
supabase functions deploy publish-and-activate
supabase functions deploy public-active
```

### 5) Configure desktop env
Create `apps/desktop/.env`:
```env
VITE_SUPABASE_URL=https://<project>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon>
VITE_RENDERER_BASE=https://renderer.example.com
```

### 6) Configure renderer env
Create `apps/renderer/.env`:
```env
VITE_SUPABASE_FUNCTIONS_BASE=https://<project>.functions.supabase.co
```

### 7) Run apps
```bash
pnpm --filter renderer dev
pnpm --filter desktop dev
```

## Build Windows EXE
Local:
```bash
pnpm --filter desktop dist:win
```

Artifacts output to `apps/desktop/dist` and `apps/desktop/dist-electron` plus electron-builder release folder.

## GitHub release flow
- Push a semver tag (`v0.1.0`)
- Workflow builds renderer + shared + desktop and creates `Overlay Profile Editor Setup.exe` artifact.

## Production setup checklist
- [ ] Supabase Auth Google OAuth configured with production callback URLs
- [ ] RLS policies enabled and tested
- [ ] Service role key only used in edge runtime secrets
- [ ] Renderer deployed over HTTPS (Vercel recommended)
- [ ] Desktop `.env` points to production renderer URL
- [ ] Rotate compromised `view_key` immediately
- [ ] Use strong profile passwords
- [ ] Verify moderators cannot publish/activate

## Security notes
- Profile password is hashed using PBKDF2 in edge function before DB storage.
- OBS access requires profile `view_key`; rotate from LIVE panel when needed.
- Public renderer endpoint returns only active **published** scene data.
- CustomWidget runs sandboxed in iframe (`allow-scripts`) with no auth token exposure.

## Phase 2 scaffolding notes (not implemented)
- `widget_runtime_state` table for live controls (counter/checklist runtime updates)
- `audit_log` table for compliance and forensic trace
- version history UI + rollback operation from published snapshots
