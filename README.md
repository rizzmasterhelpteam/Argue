# Argue AI

Interactive React/Vite prototype for the Argue AI voice-first debate app, recreated from the supplied mobile reference.

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

The prototype includes:

- Argue and Brainstorm mode switching
- Explicit Voice/Text input mode switching with mutually exclusive controls
- Voice mode hides the scrollable transcript; Text mode restores it for review
- Simulated listening, thinking, transcribing, and speaking states
- Text argument submission with mock AI responses
- Scrollable transcript cards with copy and replay controls
- Searchable and filterable History plus Profile navigation views
- Accessible voice settings dialog with persisted preferences
- App preferences for haptics, compact Text-mode transcripts, and reduced motion
- Keyboard-friendly multiline input, focus management, and status announcements
- Responsive 390 × 844 mobile framing and reduced-motion support

This repository is a frontend prototype. AI replies and voice playback are simulated; a production backend, authentication, provider adapters, cloud conversation persistence, and native Expo integration are outside the current implementation.
