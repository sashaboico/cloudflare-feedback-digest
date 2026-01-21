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

		// Landing page with description and latest digest
		const latestDigest = await env.DB.prepare(
			'SELECT * FROM daily_digests ORDER BY created_at DESC LIMIT 1'
		).first();

		const digest = latestDigest ? JSON.parse(latestDigest.summary) : null;

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
    .subtitle { color: #888; font-size: 1rem; margin-bottom: 2rem; }
    .tech { display: flex; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 2rem; }
    .tag { background: #1a1a1a; border: 1px solid #333; padding: 0.25rem 0.75rem; border-radius: 999px; font-size: 0.8rem; color: #f97316; }
    .section { background: #111; border: 1px solid #222; border-radius: 12px; padding: 1.5rem; margin-bottom: 1.5rem; }
    .section-title { font-size: 1rem; font-weight: 600; color: #fff; margin-bottom: 1rem; display: flex; align-items: center; gap: 0.5rem; }
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
    .actions { display: grid; gap: 0.75rem; }
    .action-category { font-size: 0.75rem; text-transform: uppercase; color: #f97316; margin-bottom: 0.25rem; }
    .meta { display: flex; gap: 2rem; flex-wrap: wrap; font-size: 0.85rem; color: #888; }
    a { color: #f97316; text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <div class="container">
    <h1>🗄️ Daily Feedback Digest</h1>
    <p class="subtitle">Made by Alexandra Boico — A daily feedback digest for a PM on the D1 team. Takes noisy feedback from D1 users, analyzes it using Workers AI, stores digests in a D1 table, and Workflows orchestrates the pipeline to deliver to Slack.</p>
    <p class="subtitle"><strong>Tech stack:</strong> Workers · D1 · Workers AI · Workflows</p>
    <p class="subtitle" style="color: #f97316;">⚠️ This digest corresponds to ${digest?.metadata?.date || new Date(latestDigest?.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric' }) || 'today'} and would be delivered to Slack.</p>

    <div class="tech">
      <span class="tag">Cloudflare Workers</span>
      <span class="tag">Workers AI</span>
      <span class="tag">D1 Database</span>
      <span class="tag">Workflows</span>
    </div>

    ${digest ? `
    <div class="meta" style="margin-bottom: 1.5rem;">
      <span>📅 ${digest.metadata?.date || 'Today'}</span>
      <span>📊 ${latestDigest.feedback_count} items analyzed</span>
      <span>🕐 Updated ${latestDigest.created_at}</span>
    </div>

    <div class="section">
      <div class="section-title">🔥 Top Themes</div>
      ${digest.top_themes.map(t => `
        <div class="theme">
          <div class="theme-name">${t.theme}</div>
          <div class="theme-meta">${t.mentions} mentions · Impact: ${t.impact} · Confidence: ${t.confidence}</div>
          ${t.quotes?.slice(0, 2).map(q => `<div class="quote">"${q}"</div>`).join('') || ''}
        </div>
      `).join('')}
    </div>

    <div class="section">
      <div class="section-title">😬 Sentiment Breakdown</div>
      <div class="sentiment-bar">
        <div class="sentiment-frustrated" style="width: ${digest.sentiment.frustrated}%"></div>
        <div class="sentiment-neutral" style="width: ${digest.sentiment.neutral}%"></div>
        <div class="sentiment-positive" style="width: ${digest.sentiment.positive}%"></div>
      </div>
      <div class="sentiment-labels">
        <span>😠 Frustrated ${digest.sentiment.frustrated}%</span>
        <span>😐 Neutral ${digest.sentiment.neutral}%</span>
        <span>😊 Positive ${digest.sentiment.positive}%</span>
      </div>
    </div>

    <div class="section">
      <div class="section-title">💡 Feature Signals</div>
      <ul class="list">
        ${digest.feature_signals.map(f => `<li>${f}</li>`).join('')}
      </ul>
    </div>

    <div class="section">
      <div class="section-title">✅ PM Actions</div>
      <div class="actions">
        ${digest.pm_actions.docs_ux?.length ? `<div><div class="action-category">Docs / UX</div>${digest.pm_actions.docs_ux.map(a => `<div>${a}</div>`).join('')}</div>` : ''}
        ${digest.pm_actions.validation?.length ? `<div><div class="action-category">Validation</div>${digest.pm_actions.validation.map(a => `<div>${a}</div>`).join('')}</div>` : ''}
        ${digest.pm_actions.tracking?.length ? `<div><div class="action-category">Tracking</div>${digest.pm_actions.tracking.map(a => `<div>${a}</div>`).join('')}</div>` : ''}
      </div>
    </div>
    ` : '<p>No digest available yet. <a href="/run-digest">Generate one</a>.</p>'}

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
