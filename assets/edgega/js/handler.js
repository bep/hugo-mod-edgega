// Platform-neutral analytics beacon handler: POST {path}. Identity is derived
// server-side per request — no cookies, no storage, and the visitor's browser
// never talks to Google:
//
//   daily salt = HMAC-SHA256(saltSecret, UTC date)    // rotates by derivation, no cron
//   client id  = SHA-256(ip subnet | user agent | salt)
//   session id = current UTC hour bucket               // unique enough per client
//
// The salt secret never leaves the edge, so a client id cannot be reversed
// or recomputed by anyone else, and after the UTC day rolls over, by us either.
// Geo comes from the platform's edge geolocation; the IP itself is never
// forwarded. Events go to GA4 via the Measurement Protocol.
//
// This file uses only Web-standard APIs. The platform adapters (e.g.
// cloudflare/analytics.js) extract the client IP, geo, secrets and waitUntil
// from their runtime and pass them in via opts:
//
//   path           beacon path, must match the one in ga.js (default /a)
//   region         Measurement Protocol endpoint, 'eu' (default) or 'global'
//   debug          enables ?debug=1 diagnostics; keep off in production
//   ip             client IP address
//   geo            { country, regionCode, city }, all optional
//   measurementID  GA4 measurement id (a site param, baked in at build time)
//   gaApiSecret    GA4 Measurement Protocol API secret
//   saltSecret     secret for the daily salt
//   waitUntil      function(promise) extending the request lifetime

const MP_URLS = {
	eu: 'https://region1.google-analytics.com/mp/collect',
	global: 'https://www.google-analytics.com/mp/collect',
};
const MP_DEBUG_URL = 'https://www.google-analytics.com/debug/mp/collect';

const BOT_RE = /bot|crawl|spider|slurp|preview|scan|fetch|monitor|headless|lighthouse/i;

export async function handle(request, opts) {
	const { path = '/a', region = 'eu', ip = '', geo = {}, measurementID, gaApiSecret, saltSecret, waitUntil } = opts;
	const url = new URL(request.url);
	if (url.pathname !== path) {
		return null;
	}
	if (request.method !== 'POST') {
		return new Response(null, { status: 405 });
	}

	// Real beacon traffic is rejected silently (probes get no diagnostics),
	// but with the debug option enabled, ?debug=1 exists for humans with curl,
	// so there it says why.
	const debug = opts.debug === true && url.searchParams.has('debug');
	const reject = (status, error) => (debug ? Response.json({ error }, { status }) : new Response(null, { status }));

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

	// Only count pages on this site, reported by a browser on this site:
	// anything else is someone injecting pageviews into the GA property.
	// Browsers always send Sec-Fetch-Site; non-browser clients can forge
	// both checks, but then they can't spoof another site's pages.
	let pageURL;
	try {
		pageURL = new URL(page);
	} catch {
		return reject(400, 'dl is not a valid URL');
	}
	if (pageURL.host !== url.host) {
		return reject(403, `dl host ${pageURL.host} does not match ${url.host}`);
	}
	const fetchSite = request.headers.get('sec-fetch-site');
	if (fetchSite && fetchSite !== 'same-origin') {
		return reject(403, `cross-site beacon (sec-fetch-site: ${fetchSite})`);
	}

	// MP hits bypass GA's known-bot filtering, so drop the obvious ones here.
	const ua = request.headers.get('user-agent') || '';
	if (!ua || BOT_RE.test(ua)) {
		return debug ? Response.json({ dropped: 'bot or empty user-agent', ua }) : new Response(null, { status: 204 });
	}

	// Deployed before secrets are set: accept and drop rather than error.
	if (!gaApiSecret || !saltSecret || !measurementID) {
		const missing = [
			['GA_API_SECRET (secret)', gaApiSecret],
			['SALT_SECRET (secret)', saltSecret],
			['edgega.ga_measurement_id (site param)', measurementID],
		]
			.filter(([, v]) => !v)
			.map(([k]) => k);
		return debug
			? Response.json({ error: 'worker config missing', missing }, { status: 503 })
			: new Response(null, { status: 204 });
	}

	const day = new Date().toISOString().slice(0, 10);
	const salt = await hmacHex(saltSecret, day);
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
	for (const k of ['utm_source', 'utm_medium', 'utm_campaign']) {
		const v = pageURL.searchParams.get(k);
		if (v) {
			utm[k] = v.slice(0, 100); // GA4 param value limit
		}
	}

	const payload = {
		client_id: clientID,
		user_agent: ua,
		user_location: {
			city: geo.city,
			region_id: geo.country && geo.regionCode ? `${geo.country}-${geo.regionCode}` : undefined,
			country_id: geo.country,
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

	const endpoint = debug ? MP_DEBUG_URL : MP_URLS[region] || MP_URLS.eu;
	const send = fetch(`${endpoint}?measurement_id=${measurementID}&api_secret=${gaApiSecret}`, {
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

	waitUntil(send);
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
