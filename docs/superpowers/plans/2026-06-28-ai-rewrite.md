# AI Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AI rewrite for captions and transcripts with frontend model-provider configuration.

**Architecture:** Add a focused `server/llm.py` module for config resolution, persisted runtime config, OpenAI-compatible request construction, and response parsing. Keep `server/app.py` as the thin route layer, extend `server/schemas.py` for request/response contracts, and add static UI controls using the existing `DESIGN.md` Apple-like system.

**Tech Stack:** FastAPI, Pydantic, requests, unittest, vanilla HTML/CSS/JavaScript.

---

### Task 1: LLM Configuration and Request Core

**Files:**
- Create: `tests/test_llm.py`
- Create: `server/llm.py`

- [ ] **Step 1: Write failing unittest coverage for provider defaults, config merge, URL resolution, secret masking, payload building, and response parsing.**

Use `unittest`, `tempfile.TemporaryDirectory`, and environment dictionaries so tests do not touch real `.env` files or network.

- [ ] **Step 2: Run `python3 -m unittest tests.test_llm` and verify it fails because `server.llm` does not exist.**

- [ ] **Step 3: Implement `server/llm.py` with these public functions and classes: `LLMConfigError`, `LLMServiceError`, `RuntimeLLMConfig`, `resolve_config`, `config_response`, `save_config`, `chat_completions_url`, `build_rewrite_payload`, `extract_message_text`, and `rewrite_text`.**

- [ ] **Step 4: Run `python3 -m unittest tests.test_llm` and verify it passes.**

### Task 2: API Schemas and Routes

**Files:**
- Modify: `server/schemas.py`
- Modify: `server/app.py`
- Modify: `tests/test_llm.py`

- [ ] **Step 1: Add failing tests for config response shape and rewrite helper behavior with a fake HTTP post callable.**

- [ ] **Step 2: Extend `server/schemas.py` with `RewriteRequest`, `RewriteResponse`, `LLMConfigRequest`, and `LLMConfigResponse`.**

- [ ] **Step 3: Add `GET /api/ai/config`, `PUT /api/ai/config`, and `POST /api/ai/rewrite` to `server/app.py`, mapping `LLMConfigError` to 503 and `LLMServiceError` to 502.**

- [ ] **Step 4: Run `python3 -m unittest tests.test_llm` and verify it passes.**

### Task 3: Frontend Model Configuration and Rewrite Controls

**Files:**
- Modify: `server/static/index.html`
- Modify: `server/static/app.js`
- Modify: `server/static/styles.css`

- [ ] **Step 1: Read `DESIGN.md` before editing. Use its `#0066cc` action blue, white/parchment/pearl surfaces, SF Pro font stack, pill buttons, 11px/18px radius values, and restrained Apple-like card grammar already present in `styles.css`.**

- [ ] **Step 2: Add a model configuration panel with provider, model, base URL, API key, timeout, current status, and save button.**

- [ ] **Step 3: Add `loadLlmConfig`, `saveLlmConfig`, `providerDefaults`, `applyProviderDefaults`, `rewriteText`, `copyText`, `renderRewriteTool`, and helper DOM functions in `app.js`.**

- [ ] **Step 4: Render rewrite controls beside both `metadata.desc/shareCaption` and `metadata.transcript.content/text`. Display result below the source text and provide copy buttons.**

- [ ] **Step 5: Style the new panel and rewrite blocks using the existing design tokens and avoid new visual language.**

### Task 4: Environment Documentation and Verification

**Files:**
- Modify: `.env.example`
- Verify: `README.md` if needed for obvious config drift only.

- [ ] **Step 1: Add LLM provider configuration placeholders to `.env.example` without real secrets.**

- [ ] **Step 2: Run `npm test`.**

- [ ] **Step 3: Run `python3 -m unittest discover -s tests -p 'test_*.py'`.**

- [ ] **Step 4: Run `python3 -m compileall server` with a writable pycache prefix if needed.**

- [ ] **Step 5: Start `ASR_PRELOAD=0 npm run api`, probe `GET /`, `GET /api/asr/status`, and `GET /api/ai/config`, then stop the server.**
