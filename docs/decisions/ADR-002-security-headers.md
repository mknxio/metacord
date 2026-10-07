# ADR-002: Security Headers

## Status

Accepted (2026-02-04). Amended 2026-10-06: `connect-src` allows `https://discord.com` for browser-direct widget requests (issue #10).

## Context

The PRD lists Content Security Policy (CSP) as a security requirement. The application loads external resources from several origins:

- **Google Fonts** — CSS from `fonts.googleapis.com`, font files from `fonts.gstatic.com`
- **Font Awesome** — CSS and font files from `cdnjs.cloudflare.com`
- **Discord CDN** — guild icons and banners from `cdn.discordapp.com`
- **Discord API** — public guild widget data from `discord.com/api/v10/guilds/{id}/widget.json`, requested directly by the browser (amendment, issue #10)

Without CSP and other security headers, the app is vulnerable to XSS injection, clickjacking, MIME-type confusion, and other common web attacks. Since the app handles Discord OAuth tokens and session cookies, defense-in-depth is critical.

## Decision

Apply a strict Content Security Policy and complementary security headers to **all responses** (both API and static assets) at the Worker level in `src/worker.ts`.

### Content Security Policy

| Directive | Value | Rationale |
|-----------|-------|-----------|
| `default-src` | `'self'` | Deny all resource types not explicitly listed |
| `script-src` | `'self'` | All scripts are bundled by Vite; no inline or third-party scripts |
| `style-src` | `'self' 'unsafe-inline' https://fonts.googleapis.com https://cdnjs.cloudflare.com` | Local styles, dynamic inline styles (e.g. `--delay` on elements), Google Fonts CSS, Font Awesome CSS |
| `font-src` | `'self' https://fonts.gstatic.com https://cdnjs.cloudflare.com` | Google Fonts files and Font Awesome icon fonts |
| `img-src` | `'self' https://cdn.discordapp.com data:` | Discord guild icons/banners and `data:` URIs for fallback images |
| `connect-src` | `'self' https://discord.com` | Application API calls are same-origin (`/api/*`); public widget data is fetched directly from Discord (see amendment) |
| `frame-ancestors` | `'none'` | Prevent the app from being embedded in iframes |
| `base-uri` | `'self'` | Prevent `<base>` tag injection |
| `form-action` | `'self'` | Prevent form submissions to external origins |

### Other Security Headers

| Header | Value | Purpose |
|--------|-------|---------|
| `X-Content-Type-Options` | `nosniff` | Prevent MIME-type sniffing |
| `X-Frame-Options` | `DENY` | Legacy clickjacking protection (supplements `frame-ancestors`) |
| `Referrer-Policy` | `strict-origin-when-cross-origin` | Limit referrer leakage to external origins |
| `Permissions-Policy` | `camera=(), microphone=(), geolocation=()` | Disable browser APIs the app does not use |

### Implementation

Headers are applied in `src/worker.ts` via an `addSecurityHeaders()` function that wraps every response before it is returned to the client. This placement ensures coverage of both Hono API responses and static asset responses, without requiring middleware in every route handler.

The CSP directives are defined as a module-level constant to avoid string construction on each request.

### Amendment: browser-direct widget requests (2026-10-06, issue #10)

`connect-src` adds `https://discord.com` so the client can fetch `GET /api/v10/guilds/{id}/widget.json` directly instead of through a Worker proxy.

- The widget endpoint is public and credential-free. The client sends it with `credentials: 'omit'`, no `Authorization` header, and no non-safelisted headers, so it needs no CORS preflight and never touches the server-side OAuth token boundary. Discord reflects the request `Origin` in `Access-Control-Allow-Origin` for both 200 and 404 responses (verified 2026-10-06).
- Discord rate-limits unauthenticated requests per client IP, including the invalid-request limit that counts the 403 and 404 responses returned by disabled widgets. Proxied from shared Worker egress IPs, those limits were shared with unrelated traffic; from the browser, each user gets their own.
- The allowance is the `https://discord.com` origin only. Authenticated Discord calls stay behind `/api/*` on the Worker. Images remain limited to `cdn.discordapp.com` under `img-src`.
- Discord sees the user's IP for widget requests, which is acceptable for a personal tool whose user already uses Discord directly.

## Consequences

### Positive

- **XSS mitigation** — `script-src 'self'` blocks inline script injection and external script loading
- **Clickjacking prevention** — `frame-ancestors 'none'` plus `X-Frame-Options: DENY` prevent embedding
- **Defense-in-depth** — multiple layers (CSP, XCTO, Permissions-Policy) reduce attack surface
- **Zero runtime cost** — headers are static strings appended to responses; no per-request computation

### Negative

- **Maintenance overhead** — adding a new external resource (CDN, analytics, etc.) requires updating CSP directives in `src/worker.ts` and this ADR
- **`'unsafe-inline'` for styles** — required for dynamic `style` attributes (e.g. `--delay` for animations); a future improvement could use CSP nonces, but this requires server-side HTML injection on each request

## Participants

Council members: backend-dev, frontend-dev, devops, qa
