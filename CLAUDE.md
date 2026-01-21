# Claude Instructions — Cloudflare Feedback Digest

You are assisting with a **Cloudflare Workers prototype** for a **PM Intern take-home assignment**.

## Project Goal
Build a **Daily Product Feedback Digest** that aggregates feedback, summarizes it using Workers AI, stores results in D1, and delivers a daily digest to Slack.

This is a **prototype**, not a production system.

---

## Constraints (must follow)
- Keep everything minimal and scrappy
- Mock data is allowed and encouraged
- No real third-party integrations required (Slack can be logged)
- Timebox total build to ~2 hours
- Prefer clarity over completeness
- Avoid over-engineering

---

## Tech Stack (do not change)
- Cloudflare Workers
- Cloudflare Workflows
- Workers AI
- D1 Database

---

## Required Endpoints
- `GET /run-digest`
  - Trigger the digest pipeline
  - Fetch feedback from D1
  - Analyze with Workers AI
  - Store digest in D1
  - Deliver (or log) Slack payload

- `GET /latest-digest`
  - Return the most recent digest from D1 as JSON

- `GET /`
  - Simple health/status response

---

## Data Model (keep minimal)
- `feedback` table — raw feedback items
- `daily_digests` table — summarized daily output

Do not add additional tables unless explicitly instructed.

---

## Non-Goals (do NOT implement)
- Authentication or user accounts
- UI or frontend
- Dashboards or analytics views
- OAuth or complex Slack integrations
- Production hardening

---

## Agent Behavior Rules
- Make **one change at a time**
- Ask before expanding scope
- Reuse existing logic where possible
- Explain tradeoffs briefly when relevant
- Do not refactor working code unless asked
