// Cloudflare adapter for the platform-neutral analytics handler in
// assets/edgega/js/handler.js: maps request.cf, the cf-connecting-ip header,
// the Worker env and ctx.waitUntil onto the handler's opts.
//
// site.Params.edgega is injected at build time by Hugo (js.Build's params,
// namespaced under edgega). Hugo lower-cases param keys, hence e.g.
// ga_measurement_id. The secrets live in the Worker env (`wrangler secret put`).
import * as params from '@params';
import { handle } from 'edgega/js/handler.js';

const p = params.edgega || {};

export default async function analytics(request, env, ctx) {
	const cf = request.cf || {};
	return handle(request, {
		path: p.path,
		region: p.region,
		// HUGO_PARAMS_EDGEGA_DEBUG=true may arrive as a string.
		debug: p.debug === true || p.debug === 'true',
		ip: request.headers.get('cf-connecting-ip') || '',
		geo: { country: cf.country, regionCode: cf.regionCode, city: cf.city },
		measurementID: p.ga_measurement_id,
		gaApiSecret: env.GA_API_SECRET,
		saltSecret: env.SALT_SECRET,
		waitUntil: (p) => ctx.waitUntil(p),
	});
}
