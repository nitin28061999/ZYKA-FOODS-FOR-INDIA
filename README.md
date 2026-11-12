# Zaykaa food assistant

A local multi-agent chat prototype based on the Zaykaa architecture sketch. Gemini is the default chat and embedding provider, with an OpenAI option. LangGraph routes each chat turn to the FAQ, order, or menu specialist. Each specialist receives tools from a local Model Context Protocol (MCP) server; SQLite and FAQ data stay behind those connectors. Redis and BullMQ queue FAQ embedding work in a separate worker process.

## Requirements

- Node.js 22.9 or later
- Docker Desktop with Docker Compose
- A Gemini API key (default) or an OpenAI API key

## Setup and start

```powershell
npm install
Copy-Item .env.example .env
# Add your GEMINI_API_KEY to .env
docker compose up -d
```

Run the API and the background worker in separate terminals:

```powershell
npm start
```

```powershell
npm run worker
```

Open [http://localhost:3000](http://localhost:3000). The chat API allows the local app origins by default (`http://localhost:<PORT>` and `http://127.0.0.1:<PORT>`). For a separate frontend, add its exact origin or comma-separated origins to `CORS_ORIGINS` in `.env` (for example `http://localhost:5173`). The API handles restricted `OPTIONS` preflight for JSON `POST` requests and rejects origins outside the allowlist. It also exposes `GET /api/health` for app and SQLite status. The app creates `data/orders.sqlite` on first start. Demo order IDs are `ZY-2048` and `ZY-2049`. Redis stores queue state; SQLite stores orders, products, FAQ documents, and their vectors. FAQ lookup continues with BM25 while the embedding job waits or runs, then uses hybrid retrieval when vectors are ready.

Gemini is the default provider: set `GEMINI_API_KEY` in `.env` (or use `GOOGLE_API_KEY`). The chat model defaults to `gemini-3.8-flash`, and FAQ embeddings use `gemini-embedding-001`. To use OpenAI instead, set `AI_PROVIDER=openai`, add `OPENAI_API_KEY`, and optionally change `OPENAI_MODEL` and `OPENAI_EMBEDDING_MODEL`. FAQ documents and queries use the same provider-specific embedding model; when the provider or embedding model changes, the background job rebuilds the FAQ index. Keep `.env` private; it is excluded by `.gitignore`.

Run `npm test` to execute the Node.js test suite. It covers order normalization, BM25 retrieval, FAQ index validation, CORS preflight, API request validation, health checks, and static path traversal.

## MCP connectors and retrieval

`@langchain/mcp-adapters` starts two local stdio MCP servers and discovers their tools when the first chat request arrives:

- **zaykaa_faq** exposes `search_help_centre` for FAQ retrieval.
- **zaykaa_store** exposes read-only `lookup_order` and `search_menu` tools over SQLite.

BullMQ queues FAQ indexing jobs in Redis. The API enqueues indexing when the FAQ index is missing, stale, or built with a different provider/model; `src/worker.js` embeds pending FAQ documents and writes vectors to SQLite. The job uses retries and exponential backoff. If Redis is unavailable, the chat app can still start and FAQ retrieval remains available through BM25; restart the app after Redis is available to enqueue the job.

FAQ vectors use an exact cosine scan over SQLite rows and a hybrid score of 75% cosine similarity plus 25% normalized BM25 relevance. This is straightforward for the small demo corpus. FAISS or a dedicated vector database can replace this retrieval layer as the corpus grows. The menu uses BM25, while order IDs and product categories have SQLite indexes.

## Architecture

- **Orchestrator:** a LangGraph `StateGraph` calls a structured intent classifier and conditionally routes to one specialist agent.
- **Conversation memory:** an in-memory checkpointer retains chat history while the server runs.
- **Background jobs:** BullMQ + Redis handle FAQ indexing outside chat requests.
- **Data and retrieval:** SQLite persists app data and vectors; BM25 and cosine similarity rank FAQ results.

This prototype has no authentication, live restaurant integration, payment flow, or real customer data.
