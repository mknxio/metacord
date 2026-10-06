# Metacord Project Instructions

## Product authority

- `docs/VISION.md` defines why Metacord exists, who it serves, its success criteria, and its non-goals.
- `docs/STRATEGY.md` defines the current focus, sequencing, constraints, and open strategic questions.
- `docs/ARCHITECTURE.md` defines durable logical boundaries and principles without binding them to a framework, runtime, or vendor.
- `docs/decisions/` records accepted implementation decisions. When an ADR conflicts with the code, verify the shipped behavior and update or supersede the ADR explicitly.
- `docs/PRD.md` is a historical requirements snapshot, not current strategic authority.

## Current implementation snapshot

- Frontend: Vite and vanilla TypeScript SPA.
- API: Hono application behind a Cloudflare Worker entry point.
- Authentication: Discord OAuth with PKCE; tokens are encrypted server-side and referenced by an HttpOnly session cookie.
- Persistence: Workers KV for sessions, browser storage for personal annotations, and portable JSON export/import.
- Upstream access: credentialed Discord calls go through the Worker API; the browser fetches public guild widget data directly from Discord without credentials, in paced batches that back off on 429.
- Package manager: pnpm, pinned by `packageManager` in `package.json`.

This list describes the code as it exists. It does not override the technology-neutral architecture or pre-decide the open frontend and hosting reviews.

## Work model

- `main` is the sole target integration line. Use short-lived branches attached to one bounded Loaf Change and land them through reviewed pull requests.
- The existing `dev` branch contains unreconciled work. Do not delete it or describe it as landed until a dedicated Change verifies and preserves its five commits.
- A Change is an interactive shaping and convergence unit. Creating one does not authorize implementation; implementation begins only after explicit handoff.
- Use Loaf native state for tasks, Intents, research reports, findings, plans, handoffs, and journal continuity. Do not recreate those operational surfaces as ad hoc Markdown.
- Keep authored operating documents, ADRs, Change contracts, and historical records in Git.
- Never deploy, merge, push, delete a branch, mutate Cloudflare resources, or change Discord application settings without explicit approval.

## Setup

```bash
pnpm install --frozen-lockfile
cp .dev.vars.development.example .dev.vars.development
pnpm types
pnpm dev
```

Populate `.dev.vars.development` locally. Never commit credentials, OAuth tokens, session secrets, exported personal data, captured Discord payloads, or other sensitive files.

## Required verification

Run the relevant subset during development and the complete sequence before proposing a Change for landing:

```bash
pnpm install --frozen-lockfile
pnpm types
pnpm exec tsc --noEmit
pnpm exec tsc --noEmit -p tsconfig.backend.json
pnpm build
pnpm test
```

Generated `worker-configuration.d.ts`, build output, local Wrangler state, and local secret files remain untracked. A green build or test suite is not deployment proof; record local, development, and production smoke evidence separately.

## Project structure

- `src/` contains the browser application and Worker entry point.
- `functions/api/` contains the application API router.
- `functions/lib/` contains server-side session, crypto, cache, HTTP, and request-coordination code.
- `shared/` contains contracts used across client and server boundaries.
- `tests/` and colocated `__tests__/` directories contain shared, frontend, and Worker tests.
- `docs/` contains operating documents, ADRs, design material, deployment guidance, the knowledge base, and historical records.

## Engineering constraints

- Preserve the browser/server credential boundary: raw OAuth tokens never reach client code.
- Treat browser-owned personal data and import/export compatibility as data-loss-sensitive surfaces. Schema changes require migration tests and round-trip verification.
- Keep platform- and framework-specific choices behind explicit boundaries. Broad substitutions require a reviewed ADR and a separately shaped Change.
- Do not add third-party dependencies without explicit approval.
- Bug fixes require a falsification check: demonstrate that the regression test fails without the fix and passes with it restored.
- Keep documentation synchronized with shipped behavior; do not document planned endpoints as if they exist.

## Skill routing

- Use `research` for the hosting and frontend decision investigations, then `architecture` for the resulting ADRs.
- Use `shape` to converge one captured Change before implementation.
- Use `implement` only after an explicit handoff from an approved Change.
- Use `typescript-development`, `interface-design`, `debugging`, and `security-compliance` for their respective implementation concerns.
- Use `ship` to verify and land one reviewed pull request; use `release` only for already-landed work.

<!-- loaf:managed:start sha256=ac6debb93fcd1b2d7806681c446f3b7d9691a43a872831a969c82a7470b0b30d -->
<!-- Maintained by loaf install/upgrade - do not edit manually -->
## Loaf Framework

**Journal Entry Types:**
- `decision(scope)`: Key decisions with rationale
- `discover(scope)`: Something learned
- `block(scope)` / `unblock(scope)`: Blockers and resolutions
- `spark(scope)`: Ideas to promote via `/idea`
- `todo(scope)`: Action items to promote to tasks

**CLI Commands:**
- `loaf journal log/recent/search/context` - Project journal
- `loaf check` - Run enforcement hooks
- `loaf task/spec/kb` - Task and knowledge management

**Journal Discipline:**
Before completing any response that includes edits, commits, or significant decisions, log journal entries using `loaf journal log "type(scope): description"`. Entry types: `decision`, `discover`, `wrap`. Do not defer journaling - log before responding.
In Codex Auto mode, when the user explicitly installed the managed basic-command policy, use the exact path-pinned Loaf executable in the managed `CODEX_HOME/AGENTS.md` block; do not substitute a bare `loaf`. The policy authorizes only explicitly classified basic Loaf command leaves and does not grant unclassified/operator commands, a bare Loaf namespace, or general filesystem access. Other harness adapters are not implied.

See the Loaf `orchestration` skill for full details.
<!-- loaf:managed:end -->
