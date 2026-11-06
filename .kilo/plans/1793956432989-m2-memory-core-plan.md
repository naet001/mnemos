# M2 — Memory Core (Mnemos) Implementation Plan

**Goal (SPEC M2 exit, `SPEC.md:643-651`):** Implement domain types/validation, repositories, memory manager, projects/scopes/basic access rules, and version history/lifecycle so memories can be created/retrieved/updated/archived and survive restart **without LLM or MCP dependency**.

**Decisions locked (user):**
- **A (scope/private identity):** `private` = `created_by_agent == actor.agentId`. No MCP/HTTP auth in M2; service methods take explicit `actor: { agentId: string }` (extendable later). Access Manager enforces scope + project access; M6 maps credentials → actor.
- **A (creation path):** Add `MemoryManager.createMemory(...)` that performs a direct canonical transactional write (`sources` + `memories` + `memory_versions` v1). No assisted proposal flow in M2 (deferred to M4/M5); approval in M4 reuses this path.
- **A (lifecycle/delete):** `archive` and `softDelete` (status `deleted`, excluded from normal reads/lists). No hard purge in M2. Version history preserved.
- **A (tags):** Minimal tag support — create/update can set/replace tags (upsert `tags.name`, link `memory_tags`), list can filter by tag names, reads return tags. **Replace-all on update** (simple, deterministic).

**Out of scope (M2):** MCP tools/resources/transports, extraction/embedding providers, proposal creation/approval UI flow, vector/FTS retrieval engine (exists in schema only), consolidation, HTTP auth, hard purge/retention jobs.

## 1) Domain model & validation (`src/core/` or `src/domain/`)
- Add domain types (align with `SPEC.md:233-295` and M1 schema `src/db/migrations/001_initial.sql`): `MemoryType`, `Scope`, `MemoryStatus`, `Memory`, `MemoryVersion`, `Project`, `Agent` (minimal), `Source`/`SourceKind`, tag types, `Actor`.
- Add Zod schemas for inputs: create memory, update memory (optimistic `expectedVersion`/`currentVersion` check support), list filters (project/scope/type/status/tags/pagination, default exclude archived/superseded/deleted), archive/softDelete.
- Validation rules: `project` scope requires `project_id`; `global` must not require one (SPEC §7.2). `importance` 1..10, `confidence` 0..1. UUID validation for IDs. Unknown/extra fields handled per existing Zod style.
- Typed app errors (SPEC §15): `ValidationError`, `NotFoundError`, `PermissionError`, `ConflictError` (version mismatch), `PersistenceError`. No SQL/stack/secrets in messages returned by future interfaces.

## 2) Access Manager (`src/services/access-manager.ts`, pure/service layer)
- `assertCanRead(actor, memory)` / `assertCanWrite(actor, memory)` and project-access checks.
- Rules (M2, single-owner V1):
  - **global:** readable by active/authorized actor in workspace (M2: agent must exist/active where checked; keep rule centralized).
  - **project:** requires `project_id` and `agent_project_access` for `actor.agentId` (role present is sufficient in M2 unless policy added).
  - **private:** only `created_by_agent == actor.agentId`.
  - `deleted` excluded from normal read/list unless an explicit internal/admin path is added later (not required now); treat as not-found/forbidden for normal actor reads.
- All read paths and mutations must enforce scope (SPEC §13, §21.4). No MCP SDK imports.

## 3) Repositories (SQL only, `src/db/repositories/`)
Use `pg`/`getPool()` via existing `src/db/index.ts`. Repositories own SQL + row mapping; accept optional `client`/query executor for transactions.
- `memory-repository.ts`: insert memory + v1, fetch by id (with tags), list with filters/pagination and access-aware joins/criteria hooks (or service supplies allowed project set — choose one approach and keep consistent), update-as-new-version (increment `current_version`, insert `memory_versions`, update `memories`), set archived/soft-deleted (new version row; see lifecycle note), tag replacement.
- `version-repository.ts` or part of memory repo: read versions/history.
- `project-repository.ts`: minimal create/get/list needed for project-scoped memories and access tests.
- `agent-repository.ts`, `agent-project-access-repository.ts`, `source-repository.ts`, `tag-repository.ts`: minimal operations required by M2 flows (register/test-seed agent, grant access, create source, upsert tags).
- Transactions (SPEC §15): `createMemory` and `update/archive/softDelete` that change canonical state + version run in a DB transaction.

## 4) Memory Manager service (`src/services/memory-manager.ts`)
Constructor-injected repos + access manager (interfaces or concrete types acceptable in monolith; avoid DB/SQL in service).
- `createMemory(actor, input)`: validate → ensure actor/project access as applicable → create `source` (`source_kind='agent_submission'` or `manual_entry`/`system_operation` as appropriate; include `external_ref` optional) → transaction: insert `memories` (status `active`, `current_version=1`) + `memory_versions` v1 + replace tags → return memory with tags/version/provenance summary.
- `getMemory(actor, id, opts?)`: enforce read access; return 404-style domain error when missing/inaccessible (avoid leaking existence across scopes except where policy dictates; default to NotFound for unauthorized reads to reduce oracle risk).
- `listMemories(actor, filters)`: scoped, paginated; defaults exclude non-active statuses; supports project/type/scope/tags/status filters per SPEC §9.3 where sensible for core listing.
- `updateMemory(actor, id, input, expectedVersion)`: optimistic concurrency (SPEC §15, §8.1 intent) — reject `ConflictError` if `current_version != expectedVersion`; transaction: new immutable `memory_versions` row, bump `current_version`, update `memories` fields/timestamps, replace tags.
- `archiveMemory(actor, id, expectedVersion?)`: set `status='archived'`, `archived_at`, preserve history via new version row (recommended; consistent with “updates preserve history”).
- `softDeleteMemory(actor, id, expectedVersion?)`: set `status='deleted'` (and `archived_at` only if desired — specify in implementation; keep behavior documented), preserve history via new version row; normal reads/lists exclude.
- `getMemoryHistory(actor, id)`: list `memory_versions` (access-checked).

## 5) Lifecycle/versioning details (verify during implementation)
- `memory_versions` rows must be immutable snapshots; never edit past versions.
- `archive`/`softDelete` create a version snapshot reflecting the status transition (so history is complete). If a migration/schema constraint blocks this, document and use the least-invasive fix consistent with SPEC (avoid silent history loss).
- Tag changes on update are reflected in canonical current state; version snapshot stores memory fields per schema (tags not in `memory_versions` table — acceptable; document).

## 6) Integration points (no behavior change required now)
- `src/index.ts` remains M1 startup; M2 services are library-level and testable via direct construction with a DB pool/test DB.
- Optional: export a small composition helper/factory in `src/services/index.ts` for tests; keep it free of MCP.

## 7) Testing (Vitest, `tests/**/*.test.ts`)
**Unit (no DB, fakes/mocks):** validation schemas, scope rules (global/project/private A), version conflict detection, lifecycle transitions/state rules, tag normalization/replace behavior.
**Integration (real PostgreSQL+pgvector; use `docker-compose.yml` DB / `DATABASE_URL`):**
- Migrations apply (or assume applied); tests isolate data (transaction rollback per test or truncate tables in dependency order) and create their own `agents/projects/access/sources` fixtures.
- Create/get/list/update/archive/softDelete flows; restart-survival covered by persistence test (insert, new pool/query sees data) — actual process restart not required in unit test harness.
- Version history preserved on update/archive/softDelete.
- Project/private scopes do not leak across agents; global accessible as defined; project requires `agent_project_access`.
- Optimistic concurrency rejects stale updates.
- Tags: create/replace/filter.

Run: `pnpm test` (may need DB available; document in PR/notes). Keep `pnpm lint` (`tsc --noEmit`) passing.

## 8) Risks / watchouts
- **Access + list queries:** avoid N+1 and avoid leaking unauthorized rows; prefer SQL filtering or a clearly tested two-step with bounded sets.
- **Error mapping:** domain errors must not include raw SQL/paths (SPEC §13.11, §15).
- **`deleted` semantics:** ensure `get/list` default behavior matches SPEC §7.3 and M2 choice A.
- **No embedding work:** ignore `memory_embeddings` except not breaking schema assumptions.

## 9) Done checklist
- [ ] Domain types + Zod validation + typed errors.
- [ ] Access Manager implements A (private=creator) + project/global rules.
- [ ] Repositories + transactional create/update/lifecycle with `memory_versions`.
- [ ] MemoryManager API: create/get/list/update/archive/softDelete/history (+ tags).
- [ ] Unit + integration tests cover M2 exit scenarios and scope isolation.
- [ ] `pnpm test` and `pnpm lint` pass (with DB available for integration tests).
- [ ] No MCP/LLM/provider coupling introduced.
