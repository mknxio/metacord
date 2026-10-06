# Architecture

## Purpose and authority

This document defines Metacord's durable logical boundaries and architectural constraints. It intentionally avoids binding the system model to a frontend framework, runtime, hosting vendor, or storage product. Concrete implementation choices belong in ADRs and the current implementation snapshot in `AGENTS.md`.

## System boundaries

### Client application

The client presents and organizes a user's Discord footprint, owns interaction state, and combines normalized membership data with private personal annotations. It receives only the derived data needed for the product experience and never receives raw upstream credentials.

### Authenticated application API

The API brokers authentication, session validation, upstream access, normalization, and server-side policy. It is the security boundary between the browser and credentialed external requests.

### External Discord integration

One integration boundary owns upstream protocol details, response normalization, error translation, and rate-limit observations for credentialed upstream access. Product code consumes stable internal contracts rather than depending directly on upstream payload shapes.

Public, credential-free upstream data may be requested by the client directly, so upstream throttling applies to each user rather than to shared infrastructure. A single client-side adapter owns those requests and translates their responses, errors, and throttling into the same kind of stable internal contract. It never attaches credentials.

### Session and secret storage

Server-side storage retains the minimum session and credential material required to authenticate upstream requests. Stored credentials are encrypted, scoped, expiring, and inaccessible to browser code.

### User-owned personal data

Favorites, names, notes, organization, and other personal context remain user-controlled. The format is schema-versioned and portable through explicit export and import paths so a hosting or runtime change does not strand personal data.

### Shared request coordination and caching

Shared coordination protects constrained upstream requests from unsafe concurrency and observed throttling. Caching reduces repeated work but does not become the authoritative source of membership or personal state.

## Core flows

### Authentication

The client initiates delegated authentication through the application API. The API validates the callback, stores credentials within the server-side session boundary, and returns only a secure session reference to the browser.

### Membership retrieval

The client requests membership information through the API. The integration boundary retrieves and normalizes upstream data, using coordination and caching where safe, before the client combines it with personal annotations. Public per-server data that needs no credentials is requested by the client-side adapter directly.

### Personal data portability

Personal annotations are read and written within the user-owned data boundary. Export produces a versioned portable representation; import validates compatibility before replacing or merging supported state and must fail visibly without partial silent loss.

## Architectural principles

- Keep identity credentials and upstream authorization server-side; expose only the minimum derived data needed by the client.
- Keep personal annotations user-owned, portable, schema-versioned, and recoverable without binding them to a hosting vendor.
- Isolate credentialed upstream API access behind one integration boundary, and public credential-free upstream access behind one client-side adapter; coordinate and cache requests without making cache state the source of truth.
- Contain runtime-, hosting-, storage-, and UI-framework-specific code behind replaceable adapters or entry points.
- Design failure states explicitly: expired sessions, partial upstream data, throttling, unavailable coordination or storage, and incompatible imports must degrade visibly without silent data loss.
- Emit enough diagnostics to operate the system while never logging credentials, session secrets, personal notes, or imported private data.
- Make broad implementation substitutions through a reviewed ADR and a separately shaped Change.

## Open decisions

- Whether the current hosting and runtime remain the best fit once rate-limit behavior, operational evidence, cost, portability, and deployment complexity are compared.
- Whether the current framework-free client remains the clearest maintainable option as product behavior grows, or a UI framework earns its migration cost.
- How departed-server history and rejoin information can remain useful when the upstream API exposes only current memberships.
- What recovery guarantees personal browser-owned data needs beyond manual export and import without turning cloud sync into implicit scope.
- Which coordination and caching behavior is required by observed upstream limits rather than inherited assumptions.
- How to prove local, development, and production parity without committing sensitive configuration or personal data.
