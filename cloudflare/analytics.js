// Cloudflare adapter for the platform-neutral analytics handler in
// assets/edgega/js/handler.js: maps request.cf, the cf-connecting-ip header,
// the Worker env and ctx.waitUntil onto the handler's opts.
//
// The GA measurement id is injected at build time by Hugo (js.Build's params,
// namespaced under edgega, from site.Params.edgega.gaMeasurementID); the
// secrets live in the Worker env (`wrangler secret put`).
import * as params from '@params';
import { handle } from 'edgega/js/handler.js';

export default async function analytics(request, env, ctx) {
	const cf = request.cf || {};
	return handle(request, {
		ip: request.headers.get('cf-connecting-ip') || '',
		geo: { country: cf.country, regionCode: cf.regionCode, city: cf.city },
		measurementID: params.edgega?.measurementID,
		gaApiSecret: env.GA_API_SECRET,
		saltSecret: env.SALT_SECRET,
		waitUntil: (p) => ctx.waitUntil(p),
	});
}
