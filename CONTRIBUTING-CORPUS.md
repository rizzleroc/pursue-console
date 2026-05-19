# Contributing Transcriptions

> **Moved in 2.0.** Corpus-contribution docs are now consolidated.

The full architecture + three-priority ladder + setup instructions live in:

- **[HOW-CAN-I-HELP.md](./HOW-CAN-I-HELP.md)** — the volunteer entry point. Settle the REVIEW queue → transcribe new pages → image + context capture, in that priority order.
- **[CONTRIBUTING.md](./CONTRIBUTING.md)** — non-corpus contributions (new views, entity-graph edits, record metadata).
- **[VISUAL-EXTRACTION-PROCESS.md](./VISUAL-EXTRACTION-PROCESS.md)** — the image + context capture flow specifically.
- **[JUDGE-STANDARD.md](./JUDGE-STANDARD.md)** — what the PR validator checks.

Quick reference for transcription contributions:

```
contributions/<your-handle>/
├── human/<eid>/p<NNNN>.txt        hand-typed (always wins canonical)
├── gpt-vision/<eid>/p<NNNN>.txt   scripts/volunteer.mjs (ChatGPT)
├── gemini/<eid>/p<NNNN>.txt       scripts/volunteer.mjs --provider=gemini
└── media/<eid>/p<NNNN>.{json,jpg} scripts/volunteer-media.mjs
```

`human` is reserved for hand-typed pages — automation never writes there. The OCR volunteer flow now produces source-specific paths (no longer `<handle>/<eid>/`).

See [CHANGELOG.md § 2.0](./CHANGELOG.md) for the full set of changes that made this document redundant.
