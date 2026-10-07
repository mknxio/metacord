# Deployment Checklist

Deployment checklist for Metacord - Your Personal Discord Server Directory.

## Branch strategy

- `main` is the sole target integration line and the production source.
- Work happens on short-lived branches attached to one bounded Loaf Change and lands through reviewed pull requests to `main`.
- The existing `dev` branch contains unreconciled commits from the former promotion model. It is transitional evidence, not the integration line; do not delete it until a dedicated Change verifies and preserves its work.
- The development Worker is an environment target, not a long-lived Git branch. Deploy it explicitly from the Change being tested.
- Tag semantic versions only from verified `main` commits (example: `v1.4.2`).

## Deployment commands

```bash
# Deploy to production (main branch)
pnpm run deploy

# Deploy to development (dev branch)
pnpm run deploy:dev
```

## Local dev secrets

Wrangler reads local Worker secrets from `.dev.vars.development` when using `wrangler dev --env development`.
Copy `.dev.vars.development.example` to `.dev.vars.development` for local development instead of using `.envrc`.

## Cloudflare Workers

Metacord runs as Cloudflare Workers with static assets served from the bundled `dist` directory.

### Production worker
- **Worker name**: `metacord-prod`
- **Branch**: `main`
- **Custom domain**: `metacord.app`
- **Deploy command**: `pnpm run deploy`
- **KV namespace binding**: `SESSIONS`
- **Env vars**: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET`, `DISCORD_REDIRECT_URI`

### Development worker
- **Worker name**: `metacord-dev`
- **Branch**: `dev`
- **Custom domain**: `dev.metacord.app`
- **Deploy command**: `pnpm run deploy:dev`
- **KV namespace binding**: `SESSIONS`
- **Env vars**: `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET`, `SESSION_SECRET`, `DISCORD_REDIRECT_URI`

### Durable Object migrations
- No Durable Object bindings remain. `wrangler.toml` keeps the migration history, which both environments inherit: `v1` created `DiscordRateLimiter` and `v2` deletes it.
- The first deploy of `v2` to each environment permanently deletes the `DiscordRateLimiter` class and its stored state. This cannot be undone, so deploy it only with explicit approval.
- Validate the configuration without deploying: `pnpm build`, then `pnpm exec wrangler deploy --dry-run --env="" --outdir <tmp>` and `pnpm exec wrangler deploy --dry-run --env production --outdir <tmp>`.

### Dashboard setup
- Create two KV namespaces (dev + prod) and fill in the `id` values in `wrangler.toml` for each environment.
- Add Worker routes or custom domains:
  - `metacord.app/*` -> `metacord-prod`
  - `dev.metacord.app/*` -> `metacord-dev`
- Keep `DISCORD_REDIRECT_URI` set per environment in `wrangler.toml`.
- Set secrets per environment (recommended via CLI):
  - `wrangler secret put DISCORD_CLIENT_ID --env production`
  - `wrangler secret put DISCORD_CLIENT_SECRET --env production`
  - `wrangler secret put SESSION_SECRET --env production`
  - `wrangler secret put DISCORD_CLIENT_ID --env development`
  - `wrangler secret put DISCORD_CLIENT_SECRET --env development`
  - `wrangler secret put SESSION_SECRET --env development`

## Branch protection

`main`:
- Require PRs
- Require status checks
- Require linear history
- Block force pushes and deletions

Short-lived Change branches:
- Require the same local evidence sequence as CI before review.
- Merge only through a reviewed PR to `main`.
- Delete after landing unless retained temporarily for incident or provenance needs.
