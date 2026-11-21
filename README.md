# Course Companion

Student chatbot over the course textbooks. Node.js (no dependencies) with a flat HTML/CSS/JS UI.
Answers come from the Databricks Genie agent `01f1e49951b91151bc1e88b97cc6517a`
(volume `quickstart_catalog.quickstart_schema.textbooks`).

## Run locally

    databricks auth login --profile DEFAULT   # only if the token has expired
    npm start                                 # http://localhost:3000

Config comes from env vars or a `.env` file (see `.env.example`). Local dev reads the host from
`~/.databrickscfg` and gets a short-lived token from `databricks auth token`.
For deployment, set `DATABRICKS_HOST` and `DATABRICKS_TOKEN`.

## How it works

`POST /api/chat` calls the Genie *Agent mode* API (`/api/2.0/genie/agents/{id}/responses`, beta),
which searches the PDFs. The server streams progress and the final answer to the browser as NDJSON.
Citations are rewritten to `[n]` markers with a Sources list (book title and pages).
The classic Conversation API can't read PDF volumes, so it isn't used.
