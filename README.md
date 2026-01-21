# Daily Product Feedback Digest

**Author:** Alexandra Boico
**Submission:** Cloudflare PM Intern Assessment

A Cloudflare Workers prototype that aggregates product feedback, analyzes it with AI, and delivers a daily digest—helping PMs quickly surface themes, sentiment, and actionable insights from noisy user feedback.

## Live Demo

**[cloudflare-feedback-digest.alexandraboico2027.workers.dev](https://cloudflare-feedback-digest.alexandraboico2027.workers.dev)**

## How to Demo (30 sec)

1. Open `/` to view the January 21 daily digest UI
2. Hit `/run-digest` to generate a fresh digest and store it in D1
3. Refresh `/` or hit `/latest-digest` to confirm it was persisted
4. (Optional) Hit `/trigger-workflow` to demonstrate orchestration via Cloudflare Workflows

## Overview

This prototype simulates a daily feedback digest pipeline for a PM on the D1 database team. It uses **seeded sample data** to simulate noisy feedback from GitHub, Discord, Twitter, and Support tickets.

The pipeline:

1. **Collects** raw feedback from D1 (seeded with realistic sample data)
2. **Analyzes** feedback using Workers AI (Llama 3) to extract themes, sentiment, and feature signals
3. **Stores** digests in D1 for historical tracking
4. **Delivers** formatted summaries to Slack (simulated—payloads are logged, no OAuth required)

## Tech Stack

| Component | Purpose |
|-----------|---------|
| **Cloudflare Workers** | Serverless compute for API endpoints |
| **Cloudflare D1** | SQLite database for feedback and digest storage |
| **Workers AI** | LLM analysis using `@cf/meta/llama-3-8b-instruct` |
| **Cloudflare Workflows** | Orchestrates the digest pipeline with durable execution |

## API Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /` | Landing page with sample digest visualization |
| `GET /run-digest` | Trigger the digest pipeline manually |
| `GET /latest-digest` | Retrieve the most recent digest as JSON |
| `GET /trigger-workflow` | Start the scheduled workflow |

## Digest Output

The AI analysis produces structured insights:

- **Top Themes** — Recurring topics with mention counts, quotes, and impact ratings
- **Sentiment Analysis** — Percentage breakdown (frustrated/neutral/positive) with trend
- **Feature Signals** — Implicit feature requests extracted from feedback
- **PM Actions** — Recommended next steps for docs, validation, and tracking

## Database Schema

```sql
-- Raw feedback items
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  source TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Summarized daily digests
CREATE TABLE daily_digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary TEXT NOT NULL,
  feedback_count INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
```

## Architecture

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Cron Trigger  │────▶│    Workflow     │────▶│   Workers AI    │
│   (9am daily)   │     │  (orchestrator) │     │  (Llama 3 8B)   │
└─────────────────┘     └────────┬────────┘     └─────────────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │       D1        │
                        │   (feedback +   │
                        │    digests)     │
                        └────────┬────────┘
                                 │
                                 ▼
                        ┌─────────────────┐
                        │  Slack (logged) │
                        └─────────────────┘
```

- **Cron trigger** — A real scheduled workflow runs daily at 9am UTC. In this prototype, you can also trigger it manually via `/trigger-workflow` to demonstrate the orchestration.
- **Slack delivery** — Simulated in this prototype. The formatted Block Kit payload is logged to the console rather than sent via webhook.

## Local Development

```bash
# Install dependencies
npm install

# Run locally
npm run dev

# Deploy to Cloudflare
npm run deploy
```

## Project Structure

```
├── src/
│   └── index.js          # Worker + Workflow logic
├── migrations/
│   └── 0001_init.sql     # D1 schema
├── wrangler.jsonc        # Cloudflare configuration
└── package.json
```

## Design Decisions

- **Single file architecture** — Keeps the prototype simple and easy to review
- **Workflow for orchestration** — Ensures durable execution with automatic retries
- **Structured AI prompts** — Returns consistent JSON for reliable parsing
- **Mock Slack delivery** — Logs payload instead of requiring OAuth setup
- **Static landing page** — Shows sample output without requiring live data

## Limitations (Prototype Scope)

- No authentication or user accounts
- Slack integration is logged, not live
- Mock/seeded feedback data
- No dashboard or analytics UI
