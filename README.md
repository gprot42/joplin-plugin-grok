# Joplin Grok AI Assistant

A Joplin desktop plugin that connects **xAI Grok** or any **OpenAI-compatible** LLM (Ollama, LM Studio, OpenAI, etc.) to your notes.

## Privacy warning

**This plugin can send your note content to an external AI provider.**

When you chat, the assistant may upload note titles and bodies it reads (search/read tools, summarize, or “Include current note context”) to:

- **xAI** (Grok / SuperGrok), or  
- **OpenRouter**, or  
- **any OpenAI-compatible endpoint** you configure (including local servers such as Ollama).

Only use it on notes you are willing to share with that provider. Exclude private notebooks under **Configuration → Joplin Grok AI**. Content is not kept “on device only” unless you point the provider at a fully local model.

## Features

- **Chat** over your notes with tool-using agent (search, read, create, update, tag)
- **Smart notebook placement** — picks the best notebook/subnotebook (or creates one)
- **Summarize** the current note
- **Access control** — block notebooks and subnotebooks so the AI cannot read or write them
- **Single Grok button** (bottom-right) + toolbar button + Tools menu

## Install (development)

1. Build:

   ```bash
   npm install
   npm run dist
   ```

2. In Joplin: **Configuration → Plugins → Advanced → Development plugins**  
   Set the path to this repo root (the folder that contains `src/` and `dist/`).

3. Restart Joplin (or use a [development profile](https://joplinapp.org/help/api/references/development_mode)).

Alternatively install the built package:

- `publish/com.joplin-grok.ai-assistant.jpl` via **Plugins → Install from file**

## Configure

### API keys (keep out of git)

Keys are **never** read from the repo. Preferred locations (first match wins):

1. Environment: `XAI_API_KEY`, `OPENROUTER_API_KEY`, `OPENAI_API_KEY`
2. **`~/.grok/.env`** (recommended):

   ```bash
   # ~/.grok/.env  (mode 600 recommended)
   XAI_API_KEY=xai-...
   # OPENROUTER_API_KEY=sk-or-...
   ```

   Or a one-line key file: **`~/.grok/api_key`**

3. Project **`.env`** (copy from `.env.example`; gitignored)
4. Joplin **Configuration → Joplin Grok AI** secure fields (optional fallback)

**SuperGrok / SuperGrok Heavy** OAuth sessions live in **`~/.grok/auth.json`** after `grok login` (also outside the repo).

### Plugin settings

**Configuration → Joplin Grok AI**

| Setting | Notes |
|--------|--------|
| LLM provider | **xAI Grok** (default), **OpenRouter**, or **OpenAI-compatible** |
| **xAI auth mode** | **SuperGrok / SuperGrok Heavy (OAuth)** (default) or **API key** (console prepaid credits) |
| SuperGrok session | Auto-imports `~/.grok/auth.json` after `grok login` (Heavy = JWT tier 5). Or use **Sign in with SuperGrok** |
| xAI API key / model | Optional if key is in `~/.grok` / `.env` — [console.x.ai](https://console.x.ai); model defaults to **Grok 4.5** |
| OpenRouter API key / model | Optional if `OPENROUTER_API_KEY` is set — [openrouter.ai/keys](https://openrouter.ai/keys); model e.g. `x-ai/grok-4.5` |
| OpenAI base URL / key / model | e.g. `http://localhost:11434/v1` + `llama3.2` |

### SuperGrok Heavy vs API credits

| Product | Pays for |
|--------|----------|
| **SuperGrok Heavy** (this plugin’s SuperGrok auth) | Consumer SuperGrok OAuth path (`grok login` / device sign-in) |
| **API key credits** | Prepaid balance on [console.x.ai billing](https://console.x.ai/team/default/billing) |

A SuperGrok Heavy subscription does **not** top up API-key credits. If you see “used all available credits”, either buy API credits **or** switch **xAI auth mode** to **SuperGrok / SuperGrok Heavy**.
| **Blocked notebook IDs** | IDs the AI must never touch (subnotebooks included) |
| **Blocked path patterns** | e.g. `Private`, `Finance / Taxes` |
| **Allowlist mode** | When on, AI may *only* use listed notebook IDs (+ children) |
| Allow creating notebooks | On by default |
| Confirm before write | Optional safety |

### Controlling what the AI can see

Three layers (all enforced in every tool: search, get, create, update, place):

1. **Block list** — notebook IDs (and all descendants)
2. **Path patterns** — case-insensitive substring match on notebook path/title
3. **Allowlist mode** — fail-closed: only listed roots (and their children)

**Exclude notebooks (simple)**

Open the manager via any of:
- **Note toolbar** ban icon (⛔ / exclude button next to Grok)
- **Configuration → Joplin Grok AI → Exclude notebooks / subnotebooks** → select **Open manager…**
- **Tools → Joplin Grok: Manage excluded notebooks…**

Then: choose a notebook → **+ Add** → repeat → **×** to remove → **Save**.

Excluded notebooks **and all their subnotebooks** are hidden from search, read, create, update, place, and tag.

**From the Tools menu**

- **Block current notebook from AI** — blocks the notebook of the selected note
- **Copy current notebook ID** — paste into settings or share

The model is also told the active policy in its system prompt, and tools return access-denied errors if it tries to cheat.

## Use

| Action | How |
|--------|-----|
| Open assistant | Note toolbar robot icon, or Tools → Joplin Grok: Toggle AI assistant |
| Chat | Type a question; tools search allowed notes only |
| Add note | Mode chip **Add note** — describe content; AI places + creates |
| Summarize | Mode chip **Summarize** (uses current note if accessible) |
| Test API | **Test connection** in the panel |

## Architecture

- Joplin Plugin Data API (`joplin.data`) — no Web Clipper token required
- Side panel chat (postMessage bridge) — dialogs cannot host multi-turn tool loops
- Tool-calling agent loop (search → place → write)
- Access policy applied on every tool execution

## Privacy

- API keys use Joplin secure settings (OS keychain when available).
- Blocked notebooks are never returned from search/get/list tools and cannot be write targets.
- Content of the current note is only attached to prompts when it is in an **allowed** notebook and “Include current note context” is checked.

## License

MIT
