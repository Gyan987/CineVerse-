# CineVerse

CineVerse is a server-backed screenplay translation and localization workspace. It includes a browser editor, private SQLite persistence, screenplay parsing for Fountain/TXT/FDX/DOCX/PDF, project-scoped context and glossary memory, review/validation workflows, provider-agnostic translation, and DOCX/FDX/Fountain/TXT/JSON/CSV/review exports.

## Run locally

```powershell
npm install
$env:CINEVERSE_DEMO_ENABLED = "true"
$env:CINEVERSE_AI_PROVIDER = "demo"
npm start
```

Open `http://127.0.0.1:3000/` and use **Try demo**. The demo creates a separate authenticated account and seeds the clearly labelled *Midnight Train* project. Demo translation is deterministic, sends no screenplay content to an external provider, and marks unknown language pairs or lines for human review.

For a configured OpenAI-compatible provider, keep credentials server-side and set `CINEVERSE_AI_BASE_URL`, `CINEVERSE_AI_API_KEY`, and `CINEVERSE_AI_MODEL`. Review the provider's retention and training policy before sending private screenplay content.

## Checks

```powershell
npm test
npm run check
```

Uploaded files are stored beneath `CINEVERSE_STORAGE_DIR` with private permissions and are only reachable through authenticated, project-scoped API routes. Set `CINEVERSE_DEMO_ENABLED=false` in production unless demo accounts are intentionally enabled. See `.env.example` for the available server settings.
