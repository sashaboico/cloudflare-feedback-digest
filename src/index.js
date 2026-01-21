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

		// Health check
		return new Response('Hello World!');
	},
};
