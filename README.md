# Argue AI

Authenticated React/Vite app for the Argue AI voice-first debate experience.

## Run locally

```bash
npm install
npm run dev -- --host 0.0.0.0 --port 4173 --strictPort
```

Copy `.env.example` to `.env` and set the Supabase public variables before opening the app. The browser fails closed when Supabase is not configured.

## Verify

```bash
npm run check
npm audit --omit=dev
npm run cap:sync
cd android && .\gradlew.bat assembleDebug
```

The app includes:

- Supabase email/password and Google authentication with session restoration
- Argue and Brainstorm modes with Voice and Text input
- Shared, user-owned Voice and Text conversation history
- Gemini Live voice sessions with automatic activity detection and direct browser-to-Gemini audio
- Groq GPT-OSS text chat with server-owned prompts and recent history limits
- Searchable history, persisted preferences, profile settings, logout, and account deletion
- Capacitor Android support with microphone permission and native lifecycle cleanup

Vercel is the primary target. `npm run build` produces the standard Vite `dist` output and Vercel functions live under `api/`. `npm run build:cloudflare` preserves the separate Cloudflare target while it remains needed.

Voice mode requests a short-lived, single-use Gemini Live token from `/api/live/token`, then connects directly to Gemini over WebSocket. The permanent Gemini API key and all Supabase service credentials remain server-only. Tokens are constrained to `gemini-3.1-flash-live-preview`, audio responses, session resumption, the server-selected voice, and the server-controlled mode instruction.

`/api/chat`, `/api/live/token`, `/api/live/release`, `/api/messages`, and `/api/account` require a verified Supabase bearer token. Text history is server-owned and confirmed Voice transcripts are persisted to the same conversation. `/api/status` returns only safe readiness booleans, the allowed Live model, and build commit.

## Supabase migration

The production schema, RLS policies, private rate-limit buckets, Voice-reservation functions, and user bootstrap trigger are in [supabase/migrations/202607300001_argue_ai_production.sql](supabase/migrations/202607300001_argue_ai_production.sql). It is intentionally not applied automatically.

Apply it to project `sgxegggrsbbjxryknpen` only after reviewing it and configuring Supabase Auth redirect URLs for local, preview, and production origins.

## Environment variables

Client variables: `VITE_SUPABASE_URL`, `VITE_SUPABASE_PUBLISHABLE_KEY`, and optionally `VITE_API_BASE_URL` for native builds.

Server-only variables: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `GEMINI_API_KEY`, `GEMINI_LIVE_MODEL=gemini-3.1-flash-live-preview`, `GEMINI_LIVE_VOICE=Kore`, `GROQ_API_KEY`, `GROQ_REASONING_MODEL=openai/gpt-oss-120b`, and `GROQ_FALLBACK_MODEL=openai/gpt-oss-20b`.

## Dodo billing

Set `DODO_PAYMENTS_API_KEY`, `DODO_PAYMENTS_WEBHOOK_KEY`, `DODO_PAYMENTS_ENVIRONMENT`, `DODO_PAYMENTS_STARTER_PRODUCT_ID`, `DODO_PAYMENTS_PRO_PRODUCT_ID`, and `APP_URL=https://argueai.vercel.app` in Vercel. `DODO_PAYMENTS_VOICE_PACK_PRODUCT_ID` is required only when selling the 30-minute voice pack.

Configure this Dodo production webhook URL: `https://argueai.vercel.app/api/webhooks/dodo`. The compatible alias `https://argueai.vercel.app/api/billing/webhook` is also supported. Subscribe to subscription lifecycle events and `payment.succeeded`; the handler verifies every event signature and deduplicates by Dodo's webhook id.
