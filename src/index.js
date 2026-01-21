/**
 * Welcome to Cloudflare Workers! This is your first worker.
 *
 * - Run `npm run dev` in your terminal to start a development server
 * - Open a browser tab at http://localhost:8787/ to see your worker in action
 * - Run `npm run deploy` to publish your worker
 *
 * Learn more at https://developers.cloudflare.com/workers/
 */

export default {
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

			return new Response(JSON.stringify(digest, null, 2), {
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
