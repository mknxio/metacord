# ADR-003: Personal Data Leaves the Browser Only as an Opt-In, Client-Encrypted Backup

Decision status: Proposed. The builder made the choices below while shaping [mknxio/metacord#15](https://github.com/mknxio/metacord/issues/15). The record becomes accepted when its pull request is reviewed and merged. Acceptance is the decision, not delivery; delivery is tracked in #15.

Recorded: 2026-10-07

Current architecture: [docs/ARCHITECTURE.md](../ARCHITECTURE.md), under "User-owned personal data" and "Session and secret storage".

## Context and Alternatives

Personal data is browser-owned. Favorites, notes, nicknames and categories live in localStorage, and #9 adds per-server snapshots and departed-server history. The data is schema-versioned and portable only through manual export and import. ADR-001 (written before the current decision-record model) describes the storage scope as "localStorage only". It is historical context, not a binding constraint. The login screen and footer promise "No data stored on our servers", and the server holds only a 30-minute session record with encrypted Discord tokens.

That leaves one recovery path: remembering to export and keeping the file. Clearing site data, switching browsers or losing a device destroys anything not exported. #9 makes this costlier. Membership facts and rejoin invites can only be captured while the user is still a member, so lost history cannot be rebuilt from Discord. Both `docs/STRATEGY.md` and `docs/ARCHITECTURE.md` leave open what recovery guarantees browser-owned data needs beyond manual export and import, "without turning cloud sync into implicit scope". VISION keeps cloud-first storage a non-goal and local ownership the default.

The builder asked for an explicit "save to cloud" tied to the existing Discord login. This record is separate from the topic documentation because the choice changes Metacord's privacy promise and trust boundary. Before it, the server never holds personal annotations. After it, the server holds them for opted-in users, but only as data it cannot read. Reversing or weakening that later, for example to server-readable storage or automatic sync, would be a different product promise. It should be visible as a deliberate change rather than drift inside a topic.

### Alternatives weighed

1. **Keep manual export/import as the only recovery path.** This needs no server change and keeps the existing promise exactly. It was rejected because it depends on user discipline, and the history added by #9 cannot be recreated once lost.
2. **Server-side encryption at rest with an application secret.** The UX is simpler (no passphrase) and recovery is possible. It was rejected because the operator, or anyone who compromises the Worker or its secret, could read every user's notes. That contradicts VISION's "without surrendering ownership of my notes". It would also tie backup readability to the application secret, so rotating the secret would strand or force re-encryption of every backup. The current token helper derives its key with a plain SHA-256 of a high-entropy secret, which suits that purpose but is not a model for human-held keys.
3. **Continuous cloud sync or multi-device merge.** This was rejected as the cloud-first scope VISION excludes. It would also need per-field conflict rules, and #9 deliberately kept import as a replace.
4. **Opt-in backup encrypted in the browser with a passphrase-derived key.** This is chosen; see below.

## Decision

Personal data may leave the browser only through an explicit, user-initiated backup. The browser encrypts the backup before upload with a key derived from a passphrase that only the user holds. The server stores and returns an opaque envelope it cannot decrypt.

The following invariants define the decision. Changing any of them requires a new decision.

- **Opt-in per action.** Upload, restore and delete each happen only on explicit user action, with a confirmation and a plain-language disclosure. Login, logout and data changes never upload, restore or sync automatically.
- **Zero-knowledge storage.** The browser encrypts the exact Export data payload with authenticated encryption. The key comes from the user's passphrase through a salted, iterated KDF. The passphrase and derived key are never sent to the server, logged or persisted. The initial parameters use only native Web Crypto with no new dependency: PBKDF2-HMAC-SHA256 with at least 600,000 iterations (the current OWASP floor for this KDF), a random salt per upload, AES-256-GCM with a random IV per upload, and the envelope's format and parameters authenticated as associated data. Exact envelope layout lives beside the implementation.
- **Account binding from the server session.** A backup belongs to the Discord user ID in the server-side session record. The server never accepts a user identity from the request.
- **Bounded server holding.** Backups use storage separate from sessions. At most two versions are kept per user (latest and previous). They expire 12 months after the last upload, and a user's delete removes both immediately. Request size and upload frequency are capped. Envelope bodies are never logged.
- **Restore is an import.** Restore decrypts in the browser and goes through the same validation, migration and single-save path as file import, replacing local data. A backup written by a newer schema version is refused without changing local data.
- **Export stays first-class.** Backup adds a recovery path. It does not replace or weaken file export/import, and local data remains the working copy.

Personal data remains localStorage-first, but it may also exist server-side as a user-initiated encrypted backup. ADR-001's "localStorage only" storage scope therefore no longer describes the system once this ships. Session and token handling are unchanged.

## Consequences

### Positive

- This answers the open recovery question with a guarantee the user controls: a device or browser loss is recoverable if the user has backed up and remembers the passphrase.
- The server, its operator and the hosting provider cannot read personal notes, so a server-side breach exposes ciphertext and metadata, not annotations.
- Restore reuses the import path, so schema migration, newer-version refusal and round-trip tests protect cloud restore without a second validation implementation.
- No new dependency is needed; the browser's built-in cryptography is enough.

### Negative

- A forgotten passphrase makes the backup permanently unrecoverable. This is intended and must be stated before every upload.
- PBKDF2 is not memory-hard, so a leaked envelope with a weak passphrase can be brute-forced offline with GPUs. A memory-hard KDF (Argon2id, scrypt) would need a dependency and is deferred. A minimum passphrase length and iteration floor partly compensate. The envelope records its KDF parameters, so a later KDF can be added without breaking existing backups.
- The server learns metadata: the Discord user ID that has a backup, envelope sizes and upload times.
- Anyone holding the user's Discord session can overwrite or delete the user's backups, though not read them. The previous slot limits the damage of one bad overwrite.
- The privacy posture and its copy change. "No data stored on our servers" stops being true and must be replaced everywhere it appears, and an in-app privacy note must state what the server holds.
- The design adds a dedicated KV namespace. Creating it in dev and production is a Cloudflare mutation that needs separate approval. KV's eventual consistency means a restore on a second device immediately after an upload may briefly see the older version, and frequency limits checked against KV are best-effort.

### Follow-up obligations (tracked in #15)

- When this ships, note on ADR-001's storage scope that it no longer applies and link here, so readers of the historical record find the current choice.
- Update `docs/ARCHITECTURE.md` (personal-data and server-storage boundaries, and remove the recovery item from open decisions) and `docs/STRATEGY.md` (resolve the recovery open question) when the behavior ships, not before.
- VISION's "cloud-first storage" non-goal stays unchanged: an opt-in encrypted backup is not cloud-first storage.
