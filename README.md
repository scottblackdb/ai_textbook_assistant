# Course Companion

Student chatbot over the course textbooks. Node.js server + flat HTML/CSS/JS UI with a
switch between two answer modes (the choice is remembered; each mode keeps its own chat).

| Mode | How it answers |
|------|----------------|
| **Genie Agent** | Databricks Genie agent `01f1e49951b91151bc1e88b97cc6517a` searches the PDFs in `quickstart_catalog.quickstart_schema.textbooks` (Agent mode API, beta). |
| **Vector Search** | Question is embedded with `databricks-gte-large-en`, top 6 chunks are pulled from Lakebase `shared` / `textbooks.public.textbook_chunks` (pgvector, cosine), and the model picked in the dropdown (Luna 6 by default, called through the Unity Gateway model service `scott.default.textbook`, Terra 6.1 `databricks-gpt-6-1-terra`, or GPT 5.4 mini `databricks-gpt-5-4-mini`) writes a streamed, cited answer from them. |

## Run locally

    npm install
    databricks auth login --profile DEFAULT   # only if the token has expired
    npm start                                 # http://localhost:3000

Config via env vars or `.env` (see `.env.example`). Local dev reads the host from
`~/.databrickscfg` and a token from `databricks auth token`. For deployment set
`DATABRICKS_HOST` and `DATABRICKS_TOKEN`; that identity needs `CAN_QUERY` on both serving
endpoints, access to the Genie space, and a Postgres role on the Lakebase `textbooks` database.

## Layout
- `server.js` – static files + `POST /api/chat` (`mode`: `genie` | `vector`), NDJSON streaming
- `lib/genie.js`, `lib/rag.js` – the two modes; `lib/auth.js` – Databricks auth helpers
- `public/` – UI
