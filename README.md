# Argue AI

Interactive React/Vite app for the Argue AI voice-first debate experience, recreated from the supplied mobile and desktop references.

## Run locally

```bash
npm install
npm run dev -- --host 0.0.0.0 --port 4173 --strictPort
```

## Verify

```bash
npm run check
npm audit
```

The app includes:

- Argue and Brainstorm mode switching
- Explicit Voice/Text input mode switching with mutually exclusive controls
- Voice mode hides the scrollable transcript; Text mode restores it for review
- Gemini Live voice sessions with bidirectional microphone audio, automatic pause detection, live transcription, and native audio responses
- Groq-powered text argument submission with compact Argue and Brainstorm responses
- Scrollable transcript cards with copy and replay controls
- Searchable and filterable History plus Profile navigation views
- Accessible voice settings dialog with persisted preferences
- App preferences for haptics, compact Text-mode transcripts, and reduced motion
- Keyboard-friendly multiline input, focus management, and status announcements
- Responsive 390 × 844 mobile framing and reduced-motion support

Voice mode requests a short-lived Gemini Live token from `/api/live-token`, then connects directly to Gemini over WebSocket so the long-lived Gemini API key stays server-side. Vercel never receives microphone or response audio. Vercel exposes separate short-lived Node routes for `/api/live-token`, `/api/chat`, and `/api/health`; the Cloudflare worker reuses the same API logic for its own deployment target. Text mode uses `/api/chat` and the configured Groq reasoning model. Conversation persistence and native Expo integration are outside the current implementation.

For Hobby/MVP protection, the server limits chat input to 2,000 characters and the most recent 8 messages, limits voice-token requests to 20 per 5 minutes per IP/user, and allows 5 voice sessions per day per IP/user on each warm function instance. The browser also caps a voice session at 60 seconds, stops after 15 seconds of silence, ignores duplicate starts, and cleans up the microphone, WebSocket, and audio contexts when the session ends or the page is hidden. The in-memory server limiter is deliberately dependency-free; use a shared store only if stronger cross-instance enforcement is required later.

`GET /api/health` reports deployment environment, configured credential presence, model, voice, API version, and build commit. `liveStatus: "credentials-present-not-verified"` is intentional: health does not mint tokens or claim that Gemini access, quota, or permissions are valid. Add `?voiceDebug=1` to the deployed URL for a sanitized diagnostics panel and browser-console phase logs; secrets, tokens, audio data, and transcripts are never logged.

Voice settings distinguish the server-controlled Gemini Live voice from the browser-only SpeechSynthesis replay voice. When automatic playback is off or the browser suspends output audio, Gemini audio is retained and a `Play response` / `Tap to enable audio` action remains available.

### Environment variables

Copy `.env.example` to `.env` for local server deployments. Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) and optionally `GEMINI_LIVE_MODEL` / `GEMINI_LIVE_VOICE` for voice mode. Set `GROQ_API_KEY` and `GROQ_REASONING_MODEL` for Text mode.
