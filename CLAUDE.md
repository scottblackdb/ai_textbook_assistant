# Course Companion — agent context

Student chatbot that answers questions about course textbooks. Node.js (ESM, Node >= 20) server plus a
no-build flat HTML/CSS/JS UI. Two switchable answer modes. Only runtime dependency: `pg`.

Run: `npm install && npm start` (http://localhost:3000, `PORT` to change). Local auth uses the Databricks CLI
profile `DEFAULT` (`databricks auth login --profile DEFAULT` if the token expired). No tests or linter exist;
verify with `node --check <file>` and real requests (see "Testing").

## Layout
- `server.js` — static file server + `POST /api/chat` + `GET /api/config`, `/api/health`. Loads `.env` *before* dynamically
  importing `lib/*` (they read `process.env` at import time; keep that order). `lib/rag.js` (and `pg`) is imported lazily on
  the first vector request, so a missing `npm install` disables only vector mode. `.env` values may carry inline ` # comments`
  (stripped unless the value is quoted).
- `lib/auth.js` — host/token resolution and `dbFetch`/`dbJson` REST helpers.
- `lib/genie.js` — mode `genie`. `lib/rag.js` — mode `vector`. Both export `chat(payload, send, signal)`.
- `public/` — `index.html`, `style.css`, `app.js` (UI/state/streaming), `markdown.js` (small safe renderer, escapes all HTML).
- `pipeline/Textbooks PDF Vectorization to Lakebase.ipynb` — Databricks notebook that fills the vector table (user-owned; not part of the app).
- `.env.example` documents every setting. `README.md` is the human-facing doc.

## The two modes
| | `genie` | `vector` |
|---|---|---|
| Source | Genie agent `01f1e49951b91151bc1e88b97cc6517a` over PDFs in volume `quickstart_catalog.quickstart_schema.textbooks` | Lakebase project `shared`, branch `production`, endpoint `primary`, DB `textbooks`, table `public.textbook_chunks` |
| API | `POST /api/2.0/genie/agents/{id}/responses` (Agent mode, **beta**, SSE) | embed -> pgvector cosine top-6 -> chat completion (streamed) |
| Models | managed by Genie | embeddings `databricks-gte-large-en`; chat `databricks-gpt-6-luna` |
| State | server returns `conversationId`; client sends it back | stateless: client sends last <=8 `history` messages |
| Streaming | answer arrives whole (progress statuses only) | token `delta` events, then final `answer` |

Client -> server body: `{ mode, message, conversationId?, history? }` (message max 2000 chars).
Server -> client: NDJSON lines, `type` in `status | delta | answer | error`.
`answer` = `{ text, sources: [{ n, title, pages? | pagesLabel? }], conversationId? }`; text uses plain `[n]` citation markers.

## Hard-won facts (don't re-learn these)
- **Genie classic Conversation API cannot read PDF volumes** (replies "no tables available"). Only the Agent mode API works.
- Genie's own citations are `\[[1](workspace-url?filePreviewPath=file.pdf)\]` links students can't open; `lib/genie.js`
  rewrites them to `[n]` and builds Sources from the retrieved `<chunk source="file.pdf (p.N)">` blocks.
- **Embedding model must stay `databricks-gte-large-en`**: verified by embedding a stored chunk (cosine sim 1.0). bge-large and
  qwen3-embedding are also 1024-d but do NOT match the stored vectors. If the pipeline notebook changes models, change `EMBEDDING_ENDPOINT` too.
- "luna 6" was interpreted as `databricks-gpt-6-luna` (a `databricks-gpt-5-6-luna` also exists). Override with `RAG_CHAT_ENDPOINT`.
- `textbook_chunks` columns: `id, source_file, chunk_index, page_start, page_end, content, embedding vector(1024), created_at`
  (~4,968 rows, HNSW cosine index, unique `(source_file, chunk_index)`). No title column: titles are prettified from file names.
  Chunks span page ranges (e.g. pp. 82-83), so Sources show ranges.
- Lakebase auth: Postgres password = OAuth token from `POST /api/2.0/postgres/credentials {endpoint}` (cached, refreshed 5 min
  before expiry); user = SCIM `/Me` userName (or `PGUSER`); host from `GET /api/2.0/postgres/{endpoint}` (or `PGHOST`).
  Compute scales to zero, so the pool uses a 20 s connect timeout. The pool is cached as a *promise* (no duplicate pools under
  concurrency); on connection/auth errors only (not SQL errors) `resetPool()` swaps out the failed pool once and retries.
- The model is told to answer only from numbered excerpts and cite `[n]`; `finalize()` in `lib/rag.js` normalizes `[1, 3]` -> `[1] [3]`
  and ranges `[1-3]` -> `[1] [2] [3]`, and lists only citations actually used.
- The client keeps and sends at most the last 8 vector-mode history messages (request bodies are capped at 128 KB).
- The UI reads the vector-mode model name from `GET /api/config`; don't hardcode model names in `public/`.
- `answer` events carry `meta`: `{ source: 'Genie' }` or `{ source: 'Lakebase', model, effort }`. The UI shows it with the
  browser-measured elapsed time as a small label under each answer (`addMeta` in `app.js`).
- Luna accepts `reasoning_effort` = `none|low|medium|high|xhigh` (`minimal` is rejected) but never echoes the level used, so
  the app always sends the level explicitly and reports what it sent. The query-rewrite call always uses `none`.
- Per-question effort comes from `lib/effort.js`: the `ai_decide` AI Function via its **REST API**
  (`POST /api/2.0/ai-functions/ai-decide`, Beta; ~0.5 s, no SQL warehouse). The user asked for REST over the SQL function. It is
  a `choice` question whose labels are exactly Luna's effort values; `state` = the standalone (rewritten) question. It runs in
  parallel with embedding + vector search. On error/timeout (`RAG_EFFORT_TIMEOUT_MS`, default 8 s) or `RAG_EFFORT_STRATEGY=fixed`
  it falls back to `RAG_REASONING_EFFORT` (default `medium`) and `meta.effortSource` is `'default'` (UI shows "(default)").
  Error details stay in the server log; the UI only gets a short reason.
- The `ai_decide` prompt is tuned to pick the LOWEST sufficient effort. The first wording ("comparison of one or two concepts" =
  medium) sent simple questions like "differences between assets and liabilities?" to medium; the current wording puts
  definitions and basic two-concept differences in `low`. It was checked on 20 mixed questions (2 repeat runs, 20/20 each), e.g.
  "thanks!" -> none; "What is inventory?", "assets vs liabilities", "speed vs velocity" -> low; "compare FIFO, LIFO and weighted
  average", "summarize chapter 3" -> medium; numeric problems and journal entries -> high; derivations -> xhigh.
  If you edit the prompt, re-run a mixed set like this and check that simple questions don't drift back to medium.
- Auth: `DATABRICKS_HOST`+`DATABRICKS_TOKEN` if set (deployed), else host from `~/.databrickscfg` + `databricks auth token --profile $DATABRICKS_CONFIG_PROFILE`.
  The `databricks` CLI must be on PATH locally. No psql installed; use `pg` from node for ad-hoc SQL.

## UI conventions
- Flat design via CSS variables in `style.css`; light/dark follows `prefers-color-scheme`; mobile at <=520px.
- Strict CSP (`default-src 'self'`): no inline scripts/styles, no CDNs. Keep everything in `public/` files.
- Each mode has its own message container and state (`modes` in `app.js`); mode choice is saved in `localStorage`; the mode switch
  and send are disabled while a request is in flight. Never insert model output with `innerHTML` except via `renderMarkdown`.

## Testing
Start with `PORT=3058 node server.js &` then e.g.:

    curl -sN localhost:3058/api/chat -H 'Content-Type: application/json' \
      -d '{"mode":"vector","message":"What is the accounting equation?"}'

(swap `"mode":"genie"` for the other mode; Genie takes ~20-60 s). Stop the server by port (`ss -ltnp | grep :3058`, then kill the pid).
Do not use `pkill -f "node server.js"` from the shell tool: it matches and kills the calling shell.
The UI itself has not been exercised in a real browser by agents so far.

## Open items / ideas
- Deploying for students (e.g. as a Databricks App): needs a service principal with CAN_QUERY on both serving endpoints,
  access to the Genie space, and a Postgres role on the `textbooks` DB. Not done yet.
- Nicer source titles (file -> title map or a title column), suggested prompts are accounting-flavored placeholders
  (books present: Principles of Accounting vol. 1 and Motion Mountain vol. 1 physics).
- Possible: rate limiting / student auth, feedback buttons, hybrid (keyword + vector) retrieval.
