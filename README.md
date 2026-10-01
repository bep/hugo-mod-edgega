## Configuration

```toml
[params.edgega]
ga_measurement_id = "G-XXXXJ4EC9B"
# Optional, with defaults:
path   = "/a"    # beacon endpoint, used by both the script and the edge handler
region = "eu"    # Measurement Protocol endpoint: "eu" or "global"
debug  = false   # enables ?debug=1 diagnostics on the beacon endpoint
```

These are baked into the bundles at build time, so any of them can be set from the environment, e.g. to enable debugging for a preview deploy:

```sh
HUGO_PARAMS_EDGEGA_DEBUG=true hugo
```

With `debug` enabled, `POST {path}?debug=1` reports why a hit was rejected and validates the payload against GA's debug endpoint without recording it. Keep it off in production.

The handler only accepts beacons for pages on the same host as the request (`dl` must match), and rejects browser requests that aren't `same-origin` (`Sec-Fetch-Site`).

## Templates

Include the beacon script in `<head>` on every page:

```go-html-template
{{ partial "edgega/script.html" . }}
```

## Cloudflare setup

Publish the Worker from a template that is always rendered, e.g. `layouts/home.html`:

```go-html-template
{{ partialCached "edgega/cloudflare/worker.html" . }}
```

The Worker (`_worker.js`) is published as a side effect of this partial, so if no rendered page calls it, there will be no Worker in `public`.

As a shortcut, `edgega/cloudflare/main.html` does both: it publishes the Worker and renders the beacon script. If you include it in the `<head>` of every page, you can skip the two partials above.

Point `wrangler.toml` at the bundle:

```toml
main = './public/_worker.js'

[assets]
	directory = './public'
	binding   = 'ASSETS'
```

Then set the secrets:

```sh
wrangler secret put GA_API_SECRET
wrangler secret put SALT_SECRET
```

### .assetsignore

The Worker partial also publishes a `.assetsignore` containing `_worker.js`, so the bundle is not served as a static asset. This will overwrite any `.assetsignore` the site (or another module) provides, e.g. in `static/`. If you need more entries, make sure the final file in `public` also includes `_worker.js`.
