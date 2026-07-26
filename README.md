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

Voice mode requests a short-lived Gemini Live token from `/api/live-token`, then connects directly to Gemini over WebSocket so the long-lived Gemini API key stays server-side. Text mode uses `/api/chat` and the configured Groq reasoning model. Conversation persistence and native Expo integration are outside the current implementation.

### Environment variables

Copy `.env.example` to `.env` for local server deployments. Set `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) and optionally `GEMINI_LIVE_MODEL` / `GEMINI_LIVE_VOICE` for voice mode. Set `GROQ_API_KEY` and `GROQ_REASONING_MODEL` for Text mode.
