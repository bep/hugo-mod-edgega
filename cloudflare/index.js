// The Cloudflare Worker entry point. Hugo bundles this file and everything it
// imports into public/_worker.js (js.Build, see
// layouts/partials/cloudflare-worker.html); wrangler.toml points `main` at the
// bundle, and a published .assetsignore keeps it out of the served assets.
//
// Handlers are imported explicitly and tried in order: the first one to return
// a Response wins, and anything unclaimed falls through to the static assets.
import analytics from './analytics.js';

export default {
	async fetch(request, env, ctx) {
		return (await analytics(request, env, ctx)) ?? env.ASSETS.fetch(request);
	},
};
