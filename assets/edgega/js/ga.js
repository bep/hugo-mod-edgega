// Analytics beacon. All identity derivation happens server-side at the edge
// (see handler.js): no cookies, no localStorage, no
// third-party requests.
// UTM params travel on the page URL for the landing hit only — nothing is
// persisted client-side.
import * as params from '@params';

(() => {
	const path = params.path || '/a';
	const send = () => {
		const data = JSON.stringify({
			dl: location.href,
			dt: document.title,
			dr: document.referrer,
		});
		if (navigator.sendBeacon) {
			navigator.sendBeacon(path, new Blob([data], { type: 'application/json' }));
		} else {
			fetch(path, { method: 'POST', body: data, keepalive: true }).catch(() => {});
		}
	};
	if (document.readyState === 'loading') {
		document.addEventListener('DOMContentLoaded', send, { once: true });
	} else {
		send();
	}
})();
