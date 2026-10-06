# Metacord - Your Personal Discord Server Directory

[![CI](https://github.com/levifig/metacord/actions/workflows/ci.yml/badge.svg)](https://github.com/levifig/metacord/actions/workflows/ci.yml)

Metacord is a personal Discord server directory, allowing to keep track of current (and previous) servers, adding notes, keeping track of invite links (so you can leave and rejoin later), etc...

## Features

- **Discord OAuth Login** - One-click authentication with PKCE flow
- **Server List** - View all servers with icons, names, and join dates
- **Organization** - Favorites, custom nicknames, and personal notes
- **Server history** - Every successful server-list load keeps a local snapshot (name, icon, member and online counts). Servers missing from a later list move to a **Departed** section with their notes, nickname, favorite and category intact; departure dates are when Metacord noticed, not when you left. Servers left before snapshots existed appear there as "Unknown server" with their ID. **Forget** removes a departed server and all its data after confirmation
- **Save for later** - From a server's details, capture join date, server nickname, role count, counts, an optional reason, and a rejoin invite before leaving: a pasted `discord.gg/…` or `discord.com/invite/…` link when you provide one (useful for a permanent invite), otherwise the server widget's invite when it has one. The widget request is skipped while Discord rate limiting is active
- **Filters** - Partner, Verified, Boosted, Discoverable, Owner
- **Search** - Filter servers by name in real-time
- **Export/Import** - Backup and restore your user data (schema-versioned JSON; older exports are migrated on import, newer ones are rejected). An import replaces your data and is reconciled against the server list already loaded, so imported history shows up without a reload. If this browser holds data from a newer Metacord version, it is preserved rather than loaded, and a notice offers to download or discard it; if storage has no room for a separate copy, saving is paused until you download or discard it
- **Demo Mode** - Preview UI without OAuth setup via `?demo=1`

## Architecture

- **Frontend**: Static SPA (Vite + TypeScript) served by Cloudflare Workers assets
- **Backend**: Hono catch-all router in a Workers entry (`/api/*`)
- **Auth**: Discord OAuth with PKCE, AES-GCM encrypted tokens in Workers KV
- **Storage**: KV for sessions, localStorage for user preferences

## Project Operating Model

Metacord uses `main` as its target integration line and short-lived branches attached to one bounded Loaf Change. The existing `dev` branch is transitional and must be reconciled before it is retired.

- [Vision](docs/VISION.md) — product purpose, users, success, and non-goals
- [Strategy](docs/STRATEGY.md) — current focus, constraints, and open questions
- [Architecture](docs/ARCHITECTURE.md) — technology-neutral system boundaries and principles
- [Decisions](docs/decisions/) — concrete implementation decisions
- [Deployment](docs/deployment.md) — environment and deployment guidance

`docs/PRD.md` is retained as a historical requirements snapshot; the operating documents above are current authority.

## Development

### Prerequisites

- Node.js 22 with pnpm
- Cloudflare account
- Discord application ([discord.com/developers](https://discord.com/developers/applications))

### Setup

1. Clone and install:

   ```bash
   pnpm install
   ```

2. Create Discord application:
   - Go to [Discord Developer Portal](https://discord.com/developers/applications)
   - Create new application, go to OAuth2 settings
   - Add redirect URL: `http://localhost:8787/api/auth/callback`
   - Copy Client ID and Client Secret

3. Create KV namespace:

   ```bash
   pnpm wrangler kv:namespace create "SESSIONS"
   pnpm wrangler kv:namespace create "SESSIONS" --preview
   ```

   Add the IDs to `wrangler.toml`

4. Configure local secrets for Wrangler:

   ```bash
   cp .dev.vars.development.example .dev.vars.development
   # Edit .dev.vars.development with your Discord credentials, SESSION_SECRET, and DEV_ASSETS_URL
   ```

5. Start development:

   ```bash
   pnpm dev
   ```

Local development runs Vite on `http://localhost:5173` and Wrangler on `http://localhost:8787`. Wrangler v4 no longer supports `--proxy`, so the worker proxies non-API requests to the Vite dev server when `DEV_ASSETS_URL` is set (defaulted in `.dev.vars.development.example`) while keeping HMR active.

> **Tip**: Use `?demo=1` to preview the UI without setting up OAuth. Demo mode loads mock data from a `guilds_api.json` that you can extract from the Console of your browser in a logged in session.

### Verification

Run the complete local evidence sequence before proposing a Change for landing:

```bash
pnpm install --frozen-lockfile
pnpm types
pnpm exec tsc --noEmit
pnpm exec tsc --noEmit -p tsconfig.backend.json
pnpm build
pnpm test
```

Local checks do not prove a deployment. Record development and production smoke results separately without committing credentials or personal Discord data.

### Scripts

| Command | Description |
|---------|-------------|
| `pnpm dev` | Run Vite + Wrangler concurrently |
| `pnpm types` | Generate Cloudflare Worker binding types |
| `pnpm build` | Build frontend for production |
| `pnpm test` | Run the complete Vitest suite |
| `pnpm preview` | Preview production build locally |

### Deployment

See `docs/deployment.md`.

## Project Structure

```
metacord/
├── src/
│   ├── index.html          # SPA entry point
│   ├── main.ts             # Application logic
│   ├── worker.ts           # Cloudflare Worker entry (assets + API)
│   ├── style.css           # Styles with CSS variables
│   ├── components/         # UI components (modal, serverCard, toast)
│   └── lib/                # Frontend helpers (api, storage, utils)
├── functions/
│   ├── api/
│   │   └── [[route]].ts    # Hono catch-all router
│   └── lib/                # Backend helpers (session, cache, crypto, cookies, http, types)
├── shared/                 # Shared types (placeholder)
├── docs/
│   ├── VISION.md           # Product purpose and boundaries
│   ├── STRATEGY.md         # Current focus and open questions
│   ├── ARCHITECTURE.md     # Durable logical system model
│   ├── decisions/          # Concrete implementation decisions
│   └── PRD.md              # Historical requirements snapshot
├── vite.config.ts          # Vite build config
├── wrangler.toml           # Cloudflare config
├── tsconfig.json           # TypeScript config
└── .dev.vars.development.example # Local Wrangler dev secrets template
```

## License

Private - Personal use only
