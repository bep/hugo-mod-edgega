// The Cloudflare Worker entry point. Hugo bundles this file and everything it
// imports into public/_worker.js (js.Build, see
// cloudflare/worker.html); wrangler.toml points `main` at the bundle, and a
// published .assetsignore keeps it out of the served assets.
//
// Handlers are imported explicitly and tried in order: the first one to return
// a Response wins, and anything unclaimed falls through to the static assets.
//
// A site can replace this file by providing its own
// assets/edgega/cloudflare/js/index.js, e.g. to compose more handlers.
// js.Build params are namespaced per module (params.edgega here) so that
// handlers from several modules can share one bundle.
import analytics from './analytics.js';

export default {
	async fetch(request, env, ctx) {
		return (await analytics(request, env, ctx)) ?? env.ASSETS.fetch(request);
	},
};
