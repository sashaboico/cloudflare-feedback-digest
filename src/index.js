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
