# Architecture

## Purpose and authority

This document defines Metacord's durable logical boundaries and architectural constraints. It intentionally avoids binding the system model to a frontend framework, runtime, hosting vendor, or storage product. Concrete implementation choices belong in ADRs and the current implementation snapshot in `AGENTS.md`.

## System boundaries

### Client application

The client presents and organizes a user's Discord footprint, owns interaction state, and combines normalized membership data with private personal annotations. It receives only the derived data needed for the product experience and never receives raw upstream credentials.

### Authenticated application API

The API brokers authentication, session validation, upstream access, normalization, and server-side policy. It is the security boundary between the browser and credentialed external requests.

### External Discord integration

One integration boundary owns upstream protocol details, response normalization, error translation, and rate-limit observations. Product code consumes stable internal contracts rather than depending directly on upstream payload shapes.

### Session and secret storage

Server-side storage retains the minimum session and credential material required to authenticate upstream requests. Stored credentials are encrypted, scoped, expiring, and inaccessible to browser code. Once the agreed opt-in backup ships, the server will also hold personal-data backups that the browser has already encrypted, and nothing it can read (see [Opt-in encrypted backup](#opt-in-encrypted-backup-agreed-not-yet-implemented)).

### User-owned personal data

Favorites, names, notes, organization, and other personal context remain user-controlled. The format is schema-versioned and portable through explicit export and import paths so a hosting or runtime change does not strand personal data.

Because the upstream API exposes only current memberships, departed-server history is derived on the client: each complete, successful membership load updates per-server snapshots in this user-owned data, and a server absent from such a load is marked departed. Failed or partial loads never change departure state. Departure is non-destructive; only an explicit, confirmed forget removes a server's snapshot and annotations. Membership facts and rejoin invites can only be captured while the user is still a member, so they are recorded by explicit user action.

Personal data is isolated per upstream account. Each signed-in account's data is stored separately, keyed by its stable account identifier, and the client reads and writes only the signed-in account's data. Nothing is loaded before identity is known, and signing out clears it from memory while it stays at rest for that account. Membership data is applied only to the account it was issued for: the API identifies the account with each membership list and membership detail, and the client refuses either for any other account (for example after another tab signs in as someone else), without reconciling or writing. Responses that arrive after the active account changed are dropped, and every account change clears the account's data and views at once. Demo data has its own separate store. Data stored by earlier versions under a single shared location could belong to any account, so it is discarded rather than migrated (builder decision 2026-10-07, [#9](https://github.com/mknxio/metacord/issues/9)).

### Shared request coordination and caching

Shared coordination protects constrained upstream requests from unsafe concurrency and observed throttling. Caching reduces repeated work but does not become the authoritative source of membership or personal state.

## Core flows

### Authentication

The client initiates delegated authentication through the application API. The API validates the callback, stores credentials within the server-side session boundary, and returns only a secure session reference to the browser.

### Membership retrieval

The client requests membership information through the API. The integration boundary retrieves and normalizes upstream data, using coordination and caching where safe, before the client combines it with personal annotations.

### Personal data portability

Personal annotations are read and written within the user-owned data boundary of the signed-in account. Export produces a versioned portable representation; import validates compatibility before replacing or merging supported state, writes only to the signed-in account's data, and must fail visibly without partial silent loss.

#### Opt-in encrypted backup (agreed, not yet implemented)

The builder agreed this direction on 2026-10-07; delivery is tracked in [#15](https://github.com/mknxio/metacord/issues/15). Until it ships, export and import remain the only recovery path, and the recovery open decision below stays open.

Personal data may leave the browser only through an explicit, user-initiated backup. The browser encrypts the backup before upload with a key derived from a passphrase only the user holds, and the server stores and returns an envelope it cannot decrypt. These invariants define the direction:

- **Opt-in per action.** Upload, restore and delete each happen only on explicit user action, after a confirmation and a plain-language disclosure. Login, logout and data changes never upload, restore or sync automatically.
- **Server-blind storage.** The plaintext is exactly the export representation. That covers the annotations plus derived data such as cached widget details. The browser encrypts it with authenticated encryption under a key from a salted, iterated passphrase KDF, using its built-in cryptography and no added dependency. A minimum passphrase length is enforced. The passphrase and derived key are never sent, logged or persisted. The envelope records and authenticates its KDF and cipher parameters, so a stronger KDF can be adopted later without stranding existing backups. Concrete parameters are specified in [#15](https://github.com/mknxio/metacord/issues/15) and will live beside the implementation.
- **Account binding from the server session.** A backup belongs to the account identity in the server-side session. The server never accepts an identity from the request.
- **Bounded server holding.** Backups use storage separate from sessions. At most two versions are kept per account (latest and previous). They expire 12 months after the last upload, and the user's delete removes both immediately. Request size and upload frequency are capped. Envelope bodies are never logged.
- **Restore is an import.** Restore decrypts in the browser and replaces local data through the same validation, migration and single-save path as file import. A backup written by a newer schema version is refused without changing local data. Restore depends on file import's newer-version refusal, which [#9](https://github.com/mknxio/metacord/issues/9) introduces.
- **Export stays first-class.** Backup adds a recovery path. It never replaces or weakens file export and import, and local data remains the working copy.

Rejected alternatives:

- **Export and import only.** Recovery would depend on user discipline, and membership history that can only be captured while the user is a member could not be rebuilt once lost.
- **Server-side encryption with an application secret.** The operator, or anyone who compromises the server or its secret, could read every user's notes. That contradicts user ownership. It would also tie backup readability to the secret, so rotating the secret would strand or force re-encryption of every backup.
- **Continuous sync or multi-device merge.** This is the cloud-first storage the vision excludes, and it would need per-field conflict rules.

Accepted limits:

- A forgotten passphrase makes a backup unrecoverable.
- The passphrase KDF is not memory-hard, so a leaked envelope with a weak passphrase can be guessed offline.
- The protection covers stored data and a passive operator, not an active one. The same origin serves the encrypting client code, so a compromised deploy could capture passphrases. This is inherent to browser-delivered encryption, but still stronger than server-side encryption, where reading stored data needs no code change.
- The server learns which account has a backup, plus its size and upload times.
- Whoever holds a user's session can overwrite or delete that user's backups, but not read them.
- When this ships, the "No data stored on our servers" promise and its variants must be replaced everywhere they appear.

## Architectural principles

- Keep identity credentials and upstream authorization server-side; expose only the minimum derived data needed by the client.
- Keep personal annotations user-owned, portable, schema-versioned, and recoverable without binding them to a hosting vendor.
- Isolate upstream API access behind one integration boundary; coordinate and cache requests without making cache state the source of truth.
- Contain runtime-, hosting-, storage-, and UI-framework-specific code behind replaceable adapters or entry points.
- Design failure states explicitly: expired sessions, partial upstream data, throttling, unavailable coordination or storage, and incompatible imports must degrade visibly without silent data loss.
- Emit enough diagnostics to operate the system while never logging credentials, session secrets, personal notes, or imported private data.
- Make broad implementation substitutions through a reviewed ADR and a separately shaped Change.

## Open decisions

- Whether the current hosting and runtime remain the best fit once rate-limit behavior, operational evidence, cost, portability, and deployment complexity are compared.
- Whether the current framework-free client remains the clearest maintainable option as product behavior grows, or a UI framework earns its migration cost.
- What recovery guarantees personal browser-owned data needs beyond manual export and import without turning cloud sync into implicit scope.
- Which coordination and caching behavior is required by observed upstream limits rather than inherited assumptions.
- How to prove local, development, and production parity without committing sensitive configuration or personal data.
