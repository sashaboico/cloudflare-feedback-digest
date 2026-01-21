import { WorkflowEntrypoint } from 'cloudflare:workers';

// Workflow for scheduled daily digest
export class DigestWorkflow extends WorkflowEntrypoint {
	async run(event, step) {
		const feedback = await step.do('fetch-feedback', async () => {
			const { results } = await this.env.DB.prepare(
				'SELECT content FROM feedback ORDER BY created_at DESC LIMIT 20'
			).all();
			return results;
		});

		if (feedback.length === 0) {
			return { status: 'skipped', reason: 'No feedback to analyze' };
		}

		const digest = await step.do('analyze-with-ai', async () => {
			const feedbackText = feedback.map((f, i) => `${i + 1}. ${f.content}`).join('\n');
			const prompt = `Analyze this product feedback and respond with valid JSON only:

${feedbackText}

Return JSON with:
- top_themes: array of 3 main themes
- overall_sentiment: "positive", "neutral", or "negative"
- recommended_actions: array of 2-3 action items

JSON response:`;

			const aiResponse = await this.env.AI.run('@cf/meta/llama-3-8b-instruct', {
				messages: [{ role: 'user', content: prompt }],
				max_tokens: 512,
			});

			try {
				const jsonMatch = aiResponse.response.match(/\{[\s\S]*\}/);
				return JSON.parse(jsonMatch[0]);
			} catch {
				return {
					top_themes: ['Unable to parse themes'],
					overall_sentiment: 'neutral',
					recommended_actions: ['Review AI response manually'],
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
				text: `📊 *Daily Feedback Digest*`,
				blocks: [
					{ type: 'header', text: { type: 'plain_text', text: '📊 Daily Feedback Digest' } },
					{ type: 'section', text: { type: 'mrkdwn', text: `*Sentiment:* ${digest.overall_sentiment}\n*Feedback analyzed:* ${feedback.length}` } },
					{ type: 'section', text: { type: 'mrkdwn', text: `*Top Themes:*\n${digest.top_themes.map(t => `• ${t}`).join('\n')}` } },
					{ type: 'section', text: { type: 'mrkdwn', text: `*Recommended Actions:*\n${digest.recommended_actions.map(a => `• ${a}`).join('\n')}` } },
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
			// Fetch recent feedback
			const { results: feedback } = await env.DB.prepare(
				'SELECT content FROM feedback ORDER BY created_at DESC LIMIT 20'
			).all();

			if (feedback.length === 0) {
				return new Response(JSON.stringify({ error: 'No feedback to analyze' }), {
					status: 400,
					headers: { 'Content-Type': 'application/json' },
				});
			}

			const feedbackText = feedback.map((f, i) => `${i + 1}. ${f.content}`).join('\n');

			const prompt = `Analyze this product feedback and respond with valid JSON only:

${feedbackText}

Return JSON with:
- top_themes: array of 3 main themes
- overall_sentiment: "positive", "neutral", or "negative"
- recommended_actions: array of 2-3 action items

JSON response:`;

			const aiResponse = await env.AI.run('@cf/meta/llama-3-8b-instruct', {
				messages: [{ role: 'user', content: prompt }],
				max_tokens: 512,
			});

			let digest;
			try {
				// Extract JSON object from response
				const jsonMatch = aiResponse.response.match(/\{[\s\S]*\}/);
				digest = JSON.parse(jsonMatch[0]);
			} catch {
				digest = {
					top_themes: ['Unable to parse themes'],
					overall_sentiment: 'neutral',
					recommended_actions: ['Review AI response manually'],
					raw_response: aiResponse.response,
				};
			}

			// Store in daily_digests
			await env.DB.prepare(
				'INSERT INTO daily_digests (summary, feedback_count) VALUES (?, ?)'
			).bind(JSON.stringify(digest), feedback.length).run();

			// Log Slack payload (mock delivery)
			const slackPayload = {
				text: `📊 *Daily Feedback Digest*`,
				blocks: [
					{
						type: 'header',
						text: { type: 'plain_text', text: '📊 Daily Feedback Digest' },
					},
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `*Sentiment:* ${digest.overall_sentiment}\n*Feedback analyzed:* ${feedback.length}`,
						},
					},
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `*Top Themes:*\n${digest.top_themes.map(t => `• ${t}`).join('\n')}`,
						},
					},
					{
						type: 'section',
						text: {
							type: 'mrkdwn',
							text: `*Recommended Actions:*\n${digest.recommended_actions.map(a => `• ${a}`).join('\n')}`,
						},
					},
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

		if (url.pathname === '/db-test') {
			// Insert sample feedback
			await env.DB.prepare(
				'INSERT INTO feedback (content, source) VALUES (?, ?)'
			).bind('Sample feedback at ' + new Date().toISOString(), 'db-test').run();

			// Get 5 most recent rows
			const { results } = await env.DB.prepare(
				'SELECT * FROM feedback ORDER BY created_at DESC LIMIT 5'
			).all();

			return new Response(JSON.stringify(results, null, 2), {
				headers: { 'Content-Type': 'application/json' },
			});
		}

		// Health check
		return new Response('Hello World!');
	},
};
