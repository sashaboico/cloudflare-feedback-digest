-- Raw feedback items collected from various sources
CREATE TABLE feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL,
  source TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

-- Summarized daily digest output from Workers AI
CREATE TABLE daily_digests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  summary TEXT NOT NULL,
  feedback_count INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
