# ADR-001: Stack and Auth Architecture

## Status

Accepted (2026-01-19). Amended 2026-10-06: the `/api/widget/:id` proxy was removed; the browser fetches public widget data directly from Discord (issue #10, see ADR-002).

## Context

Metacord - Your Personal Discord Server Directory needs a full-stack architecture to support:
- Discord OAuth authentication
- Server list fetching and caching
- Local-first user data storage
- Fast, lightweight frontend

We needed to decide on tooling, session management, API caching strategy, and design collaboration workflow.

## Decision

### Stack

| Layer | Choice | Rationale |
|-------|--------|-----------|
| Runtime | pnpm + Wrangler | Package manager + local dev parity with production |
| Backend | Hono on Cloudflare Workers | Lightweight, edge-native, catch-all routing |
| Frontend | Vite + TypeScript | Fast HMR, modern bundling, type safety |
| Hosting | Cloudflare Workers | Static assets + Worker entry, single deployment |
| Sessions | Workers KV | Low-latency key-value, integrated with Workers |

### OAuth and Session Handling

- PKCE flow (code_challenge + code_verifier)
- Session cookie: `__Host-session` (30m TTL, rolling)
- Refresh token: 90 days (Discord default)
- Token encryption: AES-GCM with `SESSION_SECRET`
- Refresh strategy: proactive when <5 min to expiry, or on 401

### API Caching

| Endpoint | TTL | SWR | Visibility |
|----------|-----|-----|------------|
| `/api/guilds` | 600s | 300s | private |
| `/api/guilds/:id` | 45s | 60s | private |

The `/api/widget/:id` proxy (60s TTL, 120s SWR, public) was removed on 2026-10-06 (issue #10). Proxied from shared Worker egress IPs, widget requests competed for Discord's per-IP limits for unauthenticated requests. The browser now calls Discord's public, credential-free widget endpoint directly, with no Worker-side cache.

### Storage Scope

- User data (favorites, nicknames, notes): localStorage only
- Sessions and tokens: Workers KV (encrypted)

## Consequences

### Positive

- Single platform (Cloudflare) simplifies deployment and billing
- No CORS issues (assets + Worker same origin) for the application API; public widget data is the one cross-origin request (issue #10)
- Edge-native performance globally
- Local-first user data respects privacy

### Negative

- Requires Wrangler for local dev (can't test Workers in plain Node)
- KV eventually consistent (acceptable for sessions)
- No offline support without additional service worker work

### Risks

- Discord API rate limits require careful caching
- `__Host-` cookie prefix requires HTTPS (complicates local OAuth testing)

## Participants

Council members: frontend-dev, backend-dev, devops, qa, design
