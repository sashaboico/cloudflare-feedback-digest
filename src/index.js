import { WorkflowEntrypoint } from 'cloudflare:workers';

// Workflow for scheduled daily digest
export class DigestWorkflow extends WorkflowEntrypoint {
	async run(event, step) {
		const feedback = await step.do('fetch-feedback', async () => {
			const { results } = await this.env.DB.prepare(
				'SELECT content, source FROM feedback ORDER BY created_at DESC LIMIT 50'
			).all();
			return results;
		});

		if (feedback.length === 0) {
			return { status: 'skipped', reason: 'No feedback to analyze' };
		}

		const sources = [...new Set(feedback.map(f => f.source).filter(Boolean))];
		const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

		const digest = await step.do('analyze-with-ai', async () => {
			const feedbackText = feedback.map((f, i) => `${i + 1}. [${f.source || 'unknown'}] ${f.content}`).join('\n');
			const prompt = `You are a PM analyzing product feedback for Cloudflare D1 database. Analyze this feedback and return valid JSON only.

FEEDBACK:
${feedbackText}

Return this exact JSON structure:
{
  "top_themes": [
    {"theme": "theme name", "mentions": number, "quotes": ["quote1", "quote2"], "impact": "High/Medium/Low", "confidence": "High/Medium/Low"}
  ],
  "friction_points": [
    {"point": "description", "count": number}
  ],
  "sentiment": {
    "frustrated": number,
    "neutral": number,
    "positive": number,
    "trend": "up/down/stable"
  },
  "feature_signals": ["implicit feature request 1", "implicit feature request 2"],
  "pm_actions": {
    "docs_ux": ["action 1"],
    "validation": ["action 1"],
    "tracking": ["action 1"]
  }
}

JSON response:`;

			const aiResponse = await this.env.AI.run('@cf/meta/llama-3-8b-instruct', {
				messages: [{ role: 'user', content: prompt }],
				max_tokens: 1500,
			});

			try {
				const jsonMatch = aiResponse.response.match(/\{[\s\S]*\}/);
				const parsed = JSON.parse(jsonMatch[0]);
				// Normalize sentiment to percentages
				if (parsed.sentiment) {
					const total = parsed.sentiment.frustrated + parsed.sentiment.neutral + parsed.sentiment.positive;
					if (total > 0) {
						parsed.sentiment.frustrated = Math.round((parsed.sentiment.frustrated / total) * 100);
						parsed.sentiment.neutral = Math.round((parsed.sentiment.neutral / total) * 100);
						parsed.sentiment.positive = Math.round((parsed.sentiment.positive / total) * 100);
					}
				}
				parsed.metadata = { date: today, sources, feedback_count: feedback.length };
				return parsed;
			} catch {
				return {
					top_themes: [{ theme: 'Unable to parse', mentions: 0, quotes: [], impact: 'Unknown', confidence: 'Low' }],
					friction_points: [],
					sentiment: { frustrated: 0, neutral: 100, positive: 0, trend: 'stable' },
					feature_signals: [],
					pm_actions: { docs_ux: ['Review AI response manually'], validation: [], tracking: [] },
					metadata: { date: today, sources, feedback_count: feedback.length },
				};
			}
		});

		await step.do('store-digest', async () => {
			await this.env.DB.prepare(
				'INSERT INTO daily_digests (summary, feedback_count) VALUES (?, ?)'
			).bind(JSON.stringify(digest), feedback.length).run();
		});

		await step.do('notify-slack', async () => {
			const slackPayload = {
				text: `🗄️ D1 Feedback Digest — ${today}`,
				blocks: [
					{ type: 'header', text: { type: 'plain_text', text: `🗄️ D1 Feedback Digest — ${today}` } },
					{ type: 'section', text: { type: 'mrkdwn', text: `*Sources:* ${sources.join(', ')}\n*Volume:* ${feedback.length} feedback items analyzed` } },
					{ type: 'divider' },
					{ type: 'section', text: { type: 'mrkdwn', text: `*🔥 Top Themes*\n${digest.top_themes.map((t, i) => `${i + 1}. *${t.theme}* (${t.mentions} mentions) — Impact: ${t.impact}`).join('\n')}` } },
					{ type: 'section', text: { type: 'mrkdwn', text: `*😬 Sentiment*\n😠 Frustrated: ${digest.sentiment.frustrated}%\n😐 Neutral: ${digest.sentiment.neutral}%\n😊 Positive: ${digest.sentiment.positive}%` } },
					{ type: 'section', text: { type: 'mrkdwn', text: `*💡 Feature Signals*\n${digest.feature_signals.map(f => `• ${f}`).join('\n')}` } },
					{ type: 'section', text: { type: 'mrkdwn', text: `*✅ PM Actions*\n${digest.pm_actions.docs_ux.map(a => `• ${a}`).join('\n')}` } },
				],
			};
			console.log('[SLACK] Would send:', JSON.stringify(slackPayload, null, 2));
		});

		return { status: 'completed', digest };
	}
}

export default {
	// Cron trigger starts the workflow
	async scheduled(controller, env, ctx) {
		const instance = await env.DIGEST_WORKFLOW.create();
		console.log(`[CRON] Started digest workflow: ${instance.id}`);
	},
	async fetch(request, env, ctx) {
		const url = new URL(request.url);

		if (url.pathname === '/run-digest') {
			// Fetch recent feedback with sources
			const { results: feedback } = await env.DB.prepare(
				'SELECT content, source FROM feedback ORDER BY created_at DESC LIMIT 50'
			).all();

			if (feedback.length === 0) {
				return new Response(JSON.stringify({ error: 'No feedback to analyze' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const sources = [...new Set(feedback.map(f => f.source).filter(Boolean))];
			const feedbackText = feedback.map((f, i) => `${i + 1}. [${f.source || 'unknown'}] ${f.content}`).join('\n');
			const today = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

			const prompt = `You are a PM analyzing product feedback for Cloudflare D1 database. Analyze this feedback and return valid JSON only.

FEEDBACK:
${feedbackText}

Return this exact JSON structure:
{
  "top_themes": [
    {"theme": "theme name", "mentions": number, "quotes": ["quote1", "quote2"], "impact": "High/Medium/Low", "confidence": "High/Medium/Low"}
  ],
  "friction_points": [
    {"point": "description", "count": number}
  ],
  "sentiment": {
    "frustrated": number,
    "neutral": number,
    "positive": number,
    "trend": "up/down/stable"
  },
  "feature_signals": ["implicit feature request 1", "implicit feature request 2"],
  "pm_actions": {
    "docs_ux": ["action 1"],
    "validation": ["action 1"],
    "tracking": ["action 1"]
  }
}

JSON response:`;

			const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
				messages: [{ role: 'user', content: prompt }],
				max_tokens: 1500,
			});

			let digest;
			try {
				const jsonMatch = aiResponse.response.match(/\{[\s\S]*\}/);
				digest = JSON.parse(jsonMatch[0]);
				// Normalize sentiment to percentages
				if (digest.sentiment) {
					const total = digest.sentiment.frustrated + digest.sentiment.neutral + digest.sentiment.positive;
					if (total > 0) {
						digest.sentiment.frustrated = Math.round((digest.sentiment.frustrated / total) * 100);
						digest.sentiment.neutral = Math.round((digest.sentiment.neutral / total) * 100);
						digest.sentiment.positive = Math.round((digest.sentiment.positive / total) * 100);
					}
				}
			} catch {
				digest = {
					top_themes: [{ theme: 'Unable to parse', mentions: 0, quotes: [], impact: 'Unknown', confidence: 'Low' }],
					friction_points: [],
					sentiment: { frustrated: 0, neutral: 100, positive: 0, trend: 'stable' },
					feature_signals: [],
					pm_actions: { docs_ux: ['Review AI response manually'], validation: [], tracking: [] },
					raw_response: aiResponse.response,
				};
			}

			// Add metadata
			digest.metadata = {
				date: today,
				sources: sources,
				feedback_count: feedback.length,
			};

			// Store in daily_digests
			await env.DB.prepare(
				'INSERT INTO daily_digests (summary, feedback_count) VALUES (?, ?)'
			).bind(JSON.stringify(digest), feedback.length).run();

			// Log rich Slack payload
			const slackPayload = {
				text: `🗄️ D1 Feedback Digest — ${today}`,
				blocks: [
					{ type: 'header', text: { type: 'plain_text', text: `🗄️ D1 Feedback Digest — ${today}` } },
					{ type: 'section', text: { type: 'mrkdwn', text: `*Sources:* ${sources.join(', ')}\n*Volume:* ${feedback.length} feedback items analyzed` } },
					{ type: 'divider' },
					{ type: 'section', text: { type: 'mrkdwn', text: `*🔥 Top Themes*\n${digest.top_themes.map((t, i) => `${i + 1}. *${t.theme}* (${t.mentions} mentions) — Impact: ${t.impact}`).join('\n')}` } },
					{ type: 'section', text: { type: 'mrkdwn', text: `*😬 Sentiment*\n😠 Frustrated: ${digest.sentiment.frustrated}%\n😐 Neutral: ${digest.sentiment.neutral}%\n😊 Positive: ${digest.sentiment.positive}%` } },
					{ type: 'section', text: { type: 'mrkdwn', text: `*💡 Feature Signals*\n${digest.feature_signals.map(f => `• ${f}`).join('\n')}` } },
					{ type: 'section', text: { type: 'mrkdwn', text: `*✅ PM Actions*\n${digest.pm_actions.docs_ux.map(a => `• ${a}`).join('\n')}` } },
				],
			};
			console.log('[SLACK] Would send:', JSON.stringify(slackPayload, null, 2));

			return new Response(JSON.stringify(digest, null, 2), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.pathname === '/latest-digest') {
			const result = await env.DB.prepare(
				'SELECT * FROM daily_digests ORDER BY created_at DESC LIMIT 1'
			).first();

			if (!result) {
				return new Response(JSON.stringify({ error: 'No digests found' }), {
					status: 404,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			return new Response(JSON.stringify({
				id: result.id,
				...JSON.parse(result.summary),
				feedback_count: result.feedback_count,
				created_at: result.created_at,
			}, null, 2), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		if (url.pathname === '/trigger-workflow') {
			const instance = await env.DIGEST_WORKFLOW.create();
			return new Response(JSON.stringify({
				message: 'Workflow started',
				instanceId: instance.id
			}, null, 2), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Landing page with static digest for January 21
		const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Daily Feedback Digest</title>
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: 'Inter', sans-serif; background: #0a0a0a; color: #e5e5e5; line-height: 1.6; padding: 2rem; }
    .container { max-width: 800px; margin: 0 auto; }
    h1 { font-size: 2rem; font-weight: 700; margin-bottom: 0.5rem; color: #fff; }
    .subtitle { color: #888; font-size: 1rem; margin-bottom: 0.5rem; }
    .section { background: #111; border: 1px solid #222; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .section-title { font-size: 1rem; font-weight: 600; color: #fff; margin-bottom: 1rem; }
    .theme { margin-bottom: 1rem; padding-bottom: 1rem; border-bottom: 1px solid #222; }
    .theme:last-child { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
    .theme-name { font-weight: 600; color: #fff; }
    .theme-meta { font-size: 0.85rem; color: #888; margin-top: 0.25rem; }
    .quote { font-style: italic; color: #aaa; font-size: 0.9rem; margin: 0.5rem 0; padding-left: 1rem; border-left: 2px solid #333; }
    .sentiment-bar { display: flex; height: 8px; border-radius: 4px; overflow: hidden; margin: 1rem 0; }
    .sentiment-frustrated { background: #ef4444; }
    .sentiment-neutral { background: #888; }
    .sentiment-positive { background: #22c55e; }
    .sentiment-labels { display: flex; justify-content: space-between; font-size: 0.8rem; color: #888; }
    .list { list-style: none; }
    .list li { padding: 0.5rem 0; border-bottom: 1px solid #222; }
    .list li:last-child { border-bottom: none; }
    a { color: #f97316; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🗄️ Daily Feedback Digest</h1>
    <p class="subtitle">Made by Alexandra Boico</p>
    <p class="subtitle">A daily feedback digest for a PM on the D1 team. Analyzes the last 24 hours of noisy user feedback using Workers AI, stores digests in D1, and Workflows orchestrates the pipeline to deliver to Slack.</p>
    <p class="subtitle"><strong>Tech stack:</strong> Workers · D1 · Workers AI · Workflows</p>
    <p class="subtitle" style="color: #f97316; margin-top: 1rem;">⚠️ Sample digest for January 21 — this would be delivered to Slack daily.</p>
    <p style="color: #666; font-size: 0.9rem; margin: 1rem 0 1.5rem;">50 items analyzed from Discord, Twitter, GitHub Issues, Support Tickets</p>

    <div class="section">
      <div class="section-title">🔥 Top Themes</div>
      <div class="theme">
        <div class="theme-name">Performance</div>
        <div class="theme-meta">13 mentions · High impact</div>
        <div class="quote">"Batch inserts over 500 rows timeout frequently"</div>
        <div class="quote">"JOIN performance needs work — query with 3 tables takes 800ms"</div>
      </div>
      <div class="theme">
        <div class="theme-name">Feature Requests</div>
        <div class="theme-meta">11 mentions · High impact</div>
        <div class="quote">"Please add full-text search. Using LIKE queries on 100k rows is painfully slow."</div>
        <div class="quote">"Would pay extra for automatic point-in-time backups."</div>
      </div>
      <div class="theme">
        <div class="theme-name">Documentation Gaps</div>
        <div class="theme-meta">5 mentions · Medium impact</div>
        <div class="quote">"Concurrency docs are unclear — getting SQLITE_BUSY errors"</div>
        <div class="quote">"Connection pooling documentation is nonexistent"</div>
      </div>
    </div>

    <div class="section">
      <div class="section-title">📊 Sentiment</div>
      <div class="sentiment-bar">
        <div class="sentiment-frustrated" style="width: 20%"></div>
        <div class="sentiment-neutral" style="width: 35%"></div>
        <div class="sentiment-positive" style="width: 45%"></div>
      </div>
      <div class="sentiment-labels">
        <span>😠 Frustrated 20%</span>
        <span>😐 Neutral 35%</span>
        <span>😊 Positive 45%</span>
      </div>
    </div>

    <div class="section">
      <div class="section-title">💡 Feature Signals</div>
      <ul class="list">
        <li>Full-text search</li>
        <li>Row-level security</li>
        <li>JSON columns and JSON path queries</li>
        <li>Automatic backups</li>
        <li>Read replicas for global latency</li>
      </ul>
    </div>

    <div class="section">
      <div class="section-title">✅ Recommended Actions</div>
      <ul class="list">
        <li>Improve documentation for concurrency and connection pooling</li>
        <li>Investigate batch insert timeouts and optimize write performance</li>
        <li>Validate demand for full-text search with user interviews</li>
      </ul>
    </div>

    <div class="section" style="background: transparent; border: 1px dashed #333;">
      <div class="section-title">🔗 API Endpoints</div>
      <ul class="list">
        <li><a href="/run-digest">/run-digest</a> — Generate a new digest</li>
        <li><a href="/latest-digest">/latest-digest</a> — Get latest digest (JSON)</li>
        <li><a href="/trigger-workflow">/trigger-workflow</a> — Trigger scheduled workflow</li>
      </ul>
    </div>
  </div>
</body>
</html>`;

		return new Response(html, {
			headers: { 'Content-Type': 'text/html' },
		});
	},
};
