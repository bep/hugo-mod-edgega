// Analytics beacon handler: POST /a. Identity is derived server-side per
// request — no cookies, no storage, and the visitor's browser never talks to
// Google:
//
//   daily salt = HMAC-SHA256(SALT_SECRET, UTC date)   // rotates by derivation, no cron
//   client id  = SHA-256(ip subnet | user agent | salt)
//   session id = current UTC hour bucket               // unique enough per client
//
// The salt secret never leaves the Worker, so a client id cannot be reversed
// or recomputed by anyone else, and after the UTC day rolls over, by us either.
// Geo comes from request.cf (country/region/city); the IP itself is never
// forwarded. Events go to GA4 via the Measurement Protocol (EU endpoint).
//
// The GA measurement id is injected at build time by Hugo (js.Build's params,
// from site.Params.gaMeasurementID); the secrets live in the Worker env.
import * as params from '@params';

const MP_URL = 'https://region1.google-analytics.com/mp/collect';
const MP_DEBUG_URL = 'https://www.google-analytics.com/debug/mp/collect';

const BOT_RE = /bot|crawl|spider|slurp|preview|scan|fetch|monitor|headless|lighthouse/i;

export default async function analytics(request, env, ctx) {
	const url = new URL(request.url);
	if (url.pathname !== '/a') {
		return null;
	}
	if (request.method !== 'POST') {
		return new Response(null, { status: 405 });
	}

	// Real beacon traffic is rejected silently (probes get no diagnostics),
	// but ?debug=1 exists for humans with curl, so there it says why.
	const debug = url.searchParams.has('debug');
	const reject = (status, error) =>
		debug ? Response.json({ error }, { status }) : new Response(null, { status });

	let body;
	try {
		body = await request.json();
	} catch {
		return reject(400, 'body must be JSON');
	}
	const page = typeof body.dl === 'string' ? body.dl.slice(0, 1000) : '';
	if (!page) {
		return reject(400, 'missing dl (page URL) field');
	}

	// MP hits bypass GA's known-bot filtering, so drop the obvious ones here.
	const ua = request.headers.get('user-agent') || '';
	if (!ua || BOT_RE.test(ua)) {
		return debug
			? Response.json({ dropped: 'bot or empty user-agent', ua })
			: new Response(null, { status: 204 });
	}

	// Deployed before secrets are set: accept and drop rather than error.
	if (!env.GA_API_SECRET || !env.SALT_SECRET || !params.measurementID) {
		const missing = [
			['GA_API_SECRET (secret)', env.GA_API_SECRET],
			['SALT_SECRET (secret)', env.SALT_SECRET],
			['gaMeasurementID (site param)', params.measurementID],
		]
			.filter(([, v]) => !v)
			.map(([k]) => k);
		return debug
			? Response.json({ error: 'worker config missing', missing }, { status: 503 })
			: new Response(null, { status: 204 });
	}

	const ip = request.headers.get('cf-connecting-ip') || '';
	const day = new Date().toISOString().slice(0, 10);
	const salt = await hmacHex(env.SALT_SECRET, day);
	const digest = await sha256(`${subnetOf(ip)}|${ua}|${salt}`);
	const dv = new DataView(digest);
	const clientID = `${dv.getUint32(0)}.${dv.getUint32(4)}`;
	const sessionID = Math.floor(Date.now() / 3.6e6) * 3600;

	// GA does not parse utm_* out of page_location on Measurement Protocol
	// hits — attribution only happens in gtag's session_start, which this
	// site never sends — so campaign params are lifted into event params
	// under their standard names. Registered once per site as event-scoped
	// custom dimensions in GA4 Admin, they slice sessions in Explorations.
	const utm = {};
	try {
		const q = new URL(page).searchParams;
		for (const k of ['utm_source', 'utm_medium', 'utm_campaign']) {
			const v = q.get(k);
			if (v) {
				utm[k] = v.slice(0, 100); // GA4 param value limit
			}
		}
	} catch {}

	const cf = request.cf || {};
	const payload = {
		client_id: clientID,
		user_agent: ua,
		user_location: {
			city: cf.city,
			region_id: cf.regionCode ? `${cf.country}-${cf.regionCode}` : undefined,
			country_id: cf.country,
		},
		consent: {
			ad_user_data: 'DENIED',
			ad_personalization: 'DENIED',
		},
		events: [
			{
				name: 'page_view',
				params: {
					session_id: sessionID,
					engagement_time_msec: 100,
					...utm,
					page_location: page,
					page_title: typeof body.dt === 'string' ? body.dt.slice(0, 300) : undefined,
					page_referrer: typeof body.dr === 'string' ? body.dr.slice(0, 1000) : undefined,
				},
			},
		],
	};

	const endpoint = debug ? MP_DEBUG_URL : MP_URL;
	const send = fetch(`${endpoint}?measurement_id=${params.measurementID}&api_secret=${env.GA_API_SECRET}`, {
		method: 'POST',
		body: JSON.stringify(payload),
	});

	if (debug) {
		// The debug endpoint validates the payload without recording it;
		// echo Google's verdict (plus what we sent) back to the caller.
		const res = await send;
		const verdict = await res.text();
		return Response.json({ status: res.status, verdict: JSON.parse(verdict), sent: payload });
	}

	ctx.waitUntil(send);
	return new Response(null, { status: 204 });
}

// /24 for IPv4, /64 for IPv6 — enough to blur the individual host while
// keeping same-household visits stable within the day.
function subnetOf(ip) {
	if (ip.includes(':')) {
		return ip.split(':').slice(0, 4).join(':');
	}
	return ip.split('.').slice(0, 3).join('.');
}

async function sha256(s) {
	return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
}

async function hmacHex(secret, msg) {
	const key = await crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign'],
	);
	const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
	return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
