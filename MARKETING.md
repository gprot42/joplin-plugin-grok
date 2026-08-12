# Joplin Grok AI Assistant — v0.0.1

**Chat with Grok inside Joplin.** Search, summarize, and write notes without leaving your notebook tree — with access controls that keep private folders private.

## What we shipped

- **Grok in Joplin** — Docked chat panel plus a single bottom-right Grok button; open, ask, close; history stays for the session
- **xAI SuperGrok Heavy** — Sign in via `grok login` / OAuth (`~/.grok/auth.json`); optional console API key mode for prepaid credits
- **OpenRouter & local LLMs** — Switch to OpenRouter or any OpenAI-compatible endpoint (Ollama, LM Studio, etc.)
- **Agent tools on your notes** — Search, read, list notebooks/notes, create, update, and tag — only where you allow
- **Notebook summaries that read like summaries** — Forced synthesis after tools so “summarize coffee” is an overview, not a dump
- **Smart placement** — New notes land in the best matching notebook or subnotebook
- **Exclude notebooks, simply** — Pick a notebook → **+ Add** → **×** to remove → Save; subnotebooks blocked too
- **Secrets stay off the repo** — Keys from `~/.grok/.env`, `~/.grok/api_key`, project `.env` (gitignored), or Joplin secure settings
- **Clean startup** — No empty black panel; chat loads only when you open it; “Include current note” off by default

## Version

**0.0.1** — first packaged release of the Joplin Grok AI assistant.

## One line

*Your notes. Your Grok. Your rules.*
