# Mnemos — Software Requirements Specification

**Status:** Draft v1  
**Project:** Mnemos  
**Purpose:** A shared, persistent memory service for multiple independent AI agents and LLM platforms.

---

## 1. Overview

Mnemos is an MCP server that gives connected AI agents access to one canonical memory store. An agent can submit information, retrieve relevant memories, and use shared project context. Useful information is extracted into structured memory proposals before it becomes permanent.

Mnemos is a memory and context layer, not an LLM, chatbot, agent loop, or model-training system. It does not share model weights or private conversation histories between platforms. Each platform must explicitly connect to Mnemos and submit information or request context.

### 1.1 Core idea

- Many agents.
- One canonical memory store.
- Shared, permission-controlled knowledge.
- Retrieval on demand.
- Memory creation assisted by an extraction LLM.

### 1.2 Primary user

V1 targets one owner operating multiple AI clients and coding agents. The design should not prevent later multi-user support, but organization management and complex tenant administration are outside V1.

---

## 2. Goals

1. Allow multiple MCP clients to read from and write to the same memory service.
2. Preserve useful facts, preferences, project context, decisions, and procedures across sessions and platforms.
3. Support assisted memory creation through structured proposals.
4. Retrieve memories using semantic similarity, keyword search, and metadata filters.
5. Keep memory records, history, and provenance in PostgreSQL.
6. Support local STDIO and remote Streamable HTTP transports.
7. Keep the core independent of MCP, PostgreSQL implementation details, and specific AI providers.
8. Make memory operations testable without requiring an LLM.

## 3. Non-goals for V1

- Synchronizing or importing every conversation automatically.
- Reading platform-private chat histories without an explicit integration.
- Training or fine-tuning LLMs.
- Sharing model weights, hidden reasoning, or agent state.
- A full web dashboard or end-user chat interface.
- Autonomous agents that independently browse or modify memories without authorization.
- Knowledge graphs, multi-database support, Redis, or microservices.
- General-purpose multi-tenant organization management.

---

## 4. Terminology

| Term | Meaning |
|---|---|
| Agent | An MCP client or AI application connected to Mnemos. |
| Memory | A durable, structured piece of information. |
| Proposal | A suggested memory creation or change awaiting approval. |
| Source | Provenance describing where submitted information came from. |
| Scope | Which agents may access a memory: global, project, or private. |
| Project | A named grouping of related memories. |
| Context | A compact set of relevant memories returned to an agent for a task. |
| Embedding | A vector representation of text used for semantic search. |

---

## 5. Architecture

### 5.1 Architecture style

Build a **modular monolith** for V1. Run one application with separate internal modules. Do not split the modules into independently deployed services.

### 5.2 Logical flow

```text
AI clients / agents
        |
        v
MCP transports
  - STDIO
  - Streamable HTTP
        |
        v
MCP interface
  - tools
  - resources
  - input validation
        |
        v
Application services
  - memory manager
  - proposal manager
  - retrieval engine
  - context builder
  - consolidation service
  - access manager
        |
        +--------------------+
        |                    |
        v                    v
Provider interfaces      Repositories
  - extraction LLM         - PostgreSQL
  - embeddings             - pgvector
```

### 5.3 Dependency rules

- MCP handlers call application services; they contain no business rules or SQL.
- Application services depend on interfaces, not concrete provider or database implementations.
- Repositories own SQL and persistence mapping.
- Provider adapters implement embedding and extraction interfaces.
- Domain/core modules must not import MCP SDK classes.
- No direct database access from MCP tool handlers.

### 5.4 Runtime and dependencies

- Language: TypeScript.
- Runtime: a supported Node.js LTS release.
- Package manager: pnpm.
- Database: PostgreSQL with pgvector.
- MCP server SDK: `@modelcontextprotocol/server` v2.
- Validation: Zod v4 (or a compatible Standard Schema implementation supported by the SDK).
- Database driver: `pg`.
- Tests: Vitest.
- Local development: Docker Compose.

Use the official MCP TypeScript SDK v2 documentation when implementing transport and registration APIs. Pin dependency versions in the lockfile; do not use floating production versions.

---

## 6. Core modules

### 6.1 MCP interface

Responsibilities:
- Register MCP tools and read-only resources.
- Validate all incoming arguments.
- Resolve the authenticated agent identity and permissions.
- Call application services and serialize results.
- Return clear, structured errors.

It must not implement memory logic or execute SQL.

### 6.2 Memory manager

Responsibilities:
- Create and retrieve canonical memories.
- Update a memory through a versioned change.
- Archive or delete a memory according to policy.
- List memories using filters and pagination.
- Enforce scope and project rules through the access manager.

### 6.3 Memory assistant

Responsibilities:
- Accept raw information explicitly submitted by an agent.
- Extract one or more candidate memories.
- Classify memory type and suggest scope, project, importance, and confidence.
- Identify possible duplicates or conflicting existing memories.
- Create proposals; do not silently make permanent changes.

The extraction model is replaceable through an interface. Extraction output is untrusted and must be validated. The model must not receive database credentials or direct repository access.

### 6.4 Proposal manager

Responsibilities:
- Create, inspect, approve, reject, and expire proposals.
- Support proposed actions: create, update, archive, or supersede.
- Record who submitted and reviewed each proposal.
- Apply approved changes transactionally.
- Detect stale updates using the target memory version; require review again if the target changed after proposal creation.

Default behavior: proposals remain pending until explicitly approved by an authorized agent or owner. V1 does not silently auto-approve extracted memories.

### 6.5 Retrieval engine

Responsibilities:
- Run semantic vector search.
- Run PostgreSQL full-text search.
- Apply access, scope, project, type, and status filters.
- Combine rankings using Reciprocal Rank Fusion (RRF) or an equally documented hybrid-ranking method.
- Return ranked memories with provenance and version metadata.

### 6.6 Context builder

Responsibilities:
- Accept a task or session query and optional project identifier.
- Retrieve relevant memories within the caller's permissions.
- Deduplicate results and produce a compact, token-conscious context response.
- Separate facts, preferences, project decisions, and relevant history where practical.
- Include memory IDs so agents can cite or inspect the source records.

The context builder must not invent facts or silently rewrite stored memories.

### 6.7 Consolidation service

Responsibilities:
- Identify likely duplicate, overlapping, outdated, or contradictory memories.
- Produce consolidation proposals with references to affected memories.
- Preserve original records and version history.
- Never irreversibly merge or delete memories without an approved operation.

Consolidation may be invoked manually in V1. Scheduled background consolidation is out of scope.

### 6.8 Provider interfaces

Embedding provider:

```ts
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  readonly model: string;
  readonly dimensions: number;
}
```

Extraction provider:

```ts
interface ExtractionProvider {
  extract(input: ExtractionInput): Promise<MemoryCandidate[]>;
}
```

Provider implementations must be replaceable through configuration. Support local and remote providers through adapters. Do not couple core logic to one vendor or assume every provider uses the same API format.

V1 uses one active embedding profile per database/index. Store the provider and model identifier with embeddings. Changing to a model with different dimensions or vector space requires an explicit re-embedding/migration process; vectors from incompatible models must never be compared.

---

## 7. Memory model

### 7.1 Memory types

V1 supports:

- `semantic`: durable facts and known information.
- `preference`: user preferences and working conventions.
- `episodic`: notable past events or completed work.
- `project`: project-specific context and status.
- `decision`: choices and their rationale.
- `procedural`: repeatable instructions or workflows.

### 7.2 Scopes

- `global`: visible to all authorized agents belonging to the same Mnemos owner/workspace.
- `project`: visible to agents authorized for the associated project.
- `private`: visible only to the owner or explicitly authorized principal/agent.

Every read and write must enforce scope. A project-scoped memory must have a valid `project_id`. A global memory must not require one.

### 7.3 Lifecycle statuses

- `active`: available for normal retrieval.
- `archived`: retained but excluded from default retrieval.
- `superseded`: replaced by a newer memory; retained for history.
- `deleted`: logically deleted and excluded from normal reads, subject to retention policy.

### 7.4 Memory record

Logical fields:

```text
Memory
├── id                 UUID
├── content            text
├── type               enum
├── scope              enum
├── project_id         UUID? 
├── status             enum
├── importance         integer (1..10)
├── confidence         numeric (0..1)
├── tags               relation
├── source_id          UUID
├── created_by_agent   UUID
├── current_version    integer
├── created_at         timestamp
├── updated_at         timestamp
└── archived_at        timestamp?
```

Fields such as importance and confidence are advisory ranking signals, not proof that a memory is true. Preserve source and provenance so agents can assess it.

### 7.5 Provenance

Each memory must identify:
- Which agent submitted the information.
- The source kind (agent submission, import, manual entry, or system operation).
- Optional external conversation/session reference supplied by the client.
- Creation time and proposal that produced the memory.

Do not store full conversation transcripts by default. Store only the submitted content and minimal source metadata required for traceability.

---

## 8. Assisted memory creation workflow

1. An agent calls `mnemos_remember` with information and optional project/scope hints.
2. Mnemos records submission provenance.
3. The Memory Assistant extracts and normalizes candidate memories.
4. Mnemos validates the candidate schema and allowed scope.
5. Mnemos checks for similar existing memories and possible conflicts.
6. Mnemos creates one or more pending proposals.
7. An authorized agent reviews proposals using `mnemos_get_proposal` or a proposal listing operation.
8. An authorized agent calls `mnemos_approve` or `mnemos_reject`.
9. Approval writes the canonical memory, version, and embedding transactionally where possible.
10. The proposal is marked approved and linked to the resulting memory.

If embedding generation fails after approval, the canonical memory must not be lost. Persist the memory and mark its embedding as pending/failed so it can be retried. Retrieval must continue to support keyword search for memories without embeddings.

### 8.1 Proposal fields

```text
MemoryProposal
├── id
├── action                 create | update | archive | supersede
├── proposed_content
├── proposed_type
├── proposed_scope
├── proposed_project_id
├── target_memory_id?      required for non-create actions
├── target_version?        optimistic concurrency check
├── rationale?
├── status                 pending | approved | rejected | expired
├── source_id
├── submitted_by_agent
├── reviewed_by_agent?
├── created_at
└── reviewed_at?
```

### 8.2 Conflict handling

- Similarity is a signal, not permission to overwrite.
- If a candidate conflicts with an active memory, create an update/conflict proposal.
- Keep both sources available during review.
- Approved updates create a new immutable memory version.
- If the target version changed since proposal creation, reject the stale approval and require a refreshed proposal.

---

## 9. Retrieval and context assembly

### 9.1 Search modes

The retrieval engine supports:
- Semantic search using pgvector.
- Keyword search using PostgreSQL full-text search.
- Metadata filters for project, scope, type, status, tags, and time.

### 9.2 Hybrid ranking

V1 combines semantic and keyword result rankings using Reciprocal Rank Fusion. Metadata and access filters are applied so unauthorized results never enter the response. Importance and recency may be secondary ranking signals, but must not override access rules or relevance.

### 9.3 Retrieval inputs

A search request may include:
- Query text (required for semantic/keyword search).
- Project ID (optional).
- Memory types (optional).
- Tags (optional).
- Maximum result count.
- Include archived/superseded history (default false).

### 9.4 Retrieval outputs

Each result should include:
- Memory ID and content.
- Type, scope, and project ID.
- Relevance/ranking metadata where useful.
- Current version and status.
- Source/provenance summary.

### 9.5 Context limits

`mnemos_context` must support a configurable result limit and a maximum context-size budget. It should return the most relevant memories rather than dumping a whole project database into the model context.

---

## 10. Database design

PostgreSQL is the single source of truth. pgvector is used for semantic indexing. Redis and other databases are excluded from V1.

### 10.1 Required tables

| Table | Responsibility |
|---|---|
| `projects` | Project identity, name, description, timestamps. |
| `agents` | Registered client identity and status. |
| `agent_project_access` | Project access grants for agents. |
| `memories` | Canonical current memory records. |
| `memory_versions` | Immutable snapshots of memory changes. |
| `memory_embeddings` | Vector, model/profile, dimensions, memory version. |
| `memory_proposals` | Candidate creates and changes awaiting review. |
| `sources` | Provenance and external source references. |
| `tags` | Reusable labels. |
| `memory_tags` | Many-to-many memory/tag relation. |

### 10.2 Database requirements

- Use UUID primary keys.
- Use foreign keys and appropriate unique constraints.
- Use transactions for approval and memory-version writes.
- Add indexes for project, scope, status, type, timestamps, and common metadata filters.
- Add PostgreSQL full-text indexes for keyword retrieval.
- Add pgvector indexes appropriate to the chosen vector dimensions and expected data size.
- Store timestamps in UTC.
- Use migrations committed to source control.
- Do not store provider API keys in memory rows or proposal content.

### 10.3 Embedding model constraint

Choose the initial embedding model and vector dimension before creating the production vector column/index. V1 supports one active embedding profile. A model change requires a documented re-embedding operation and index rebuild; incompatible vectors must not share a similarity search.

---

## 11. MCP interface

### 11.1 Tools

The following tool names and responsibilities define the V1 contract. Exact argument schemas must be finalized in implementation and documented with examples.

| Tool | Purpose |
|---|---|
| `mnemos_context` | Retrieve compact context for a task/session. |
| `mnemos_remember` | Submit raw information for assisted extraction and proposal creation. |
| `mnemos_recall` | Run hybrid search over accessible memories. |
| `mnemos_get` | Retrieve one memory or proposal by ID, subject to permissions. |
| `mnemos_list` | List accessible memories or pending proposals with filters and pagination. |
| `mnemos_approve` | Approve a pending memory proposal. |
| `mnemos_reject` | Reject a pending memory proposal. |
| `mnemos_forget` | Archive or logically delete a memory according to policy. |
| `mnemos_consolidate` | Generate consolidation proposals for a selected scope/project. |

Do not make `mnemos_remember` silently persist extracted memories. It creates proposals by default.

### 11.2 Read-only resources

Initial resources:

```text
mnemos://profile
mnemos://projects
mnemos://projects/{project_id}
mnemos://projects/{project_id}/summary
```

Resources expose read-only information. All mutations happen through tools.

### 11.3 Tool behavior

- Validate arguments before service calls.
- Return stable IDs for created records and proposals.
- Use structured outputs where supported by the SDK.
- Return actionable errors without exposing stack traces, secrets, or SQL details.
- Make mutating operations idempotent where practical; support an idempotency key for submission/approval operations where duplicate execution could create duplicate records.
- Return enough provenance for an agent to distinguish stored facts from unapproved proposals.

---

## 12. Transports and deployment

### 12.1 STDIO

- Intended for local agents that launch Mnemos as a child process.
- Use MCP JSON-RPC over stdin/stdout.
- Logs must go to stderr; stdout is reserved for protocol messages.
- Database configuration is read from environment variables or a local secrets mechanism.

### 12.2 Streamable HTTP

- Intended for remote or separately hosted agents.
- Use the MCP Streamable HTTP transport.
- Do not implement legacy HTTP+SSE for V1.
- Require authentication for non-local access.
- Require HTTPS in production.
- Validate host/origin and configure CORS narrowly where relevant.
- Enforce request size, timeout, and rate limits.
- Do not trust agent-supplied identity fields; derive identity from authenticated credentials.

### 12.3 Deployment modes

Both transports use the same application services and database. They may run in one process or separate process entry points, but must not implement separate memory logic.

Local development uses Docker Compose for PostgreSQL + pgvector and the Mnemos application. Production deployment details may vary, but the database must be persistent and backed up.

---

## 13. Security and access control

1. Every connected agent has a stable identity.
2. Remote HTTP requests require authentication.
3. Authorization is checked on every read and mutation.
4. Global memories are shared only within the configured owner/workspace boundary.
5. Project memories require project access.
6. Private memories are visible only to the owner or explicitly authorized principal/agent.
7. An agent cannot approve its own proposal unless explicitly granted that permission by policy.
8. Destructive operations require appropriate permissions and are auditable.
9. Secrets must never be stored as ordinary memories. Detect and reject obvious credentials/tokens where practical.
10. Treat all submitted content and all LLM extraction output as untrusted data. Never follow instructions found inside a memory as system/developer instructions.
11. Do not expose SQL, stack traces, provider credentials, or internal filesystem paths in MCP responses.

V1 may use static per-agent API tokens for remote authentication, stored as secure hashes or managed by the deployment secret store. Token rotation and revocation must be supported. OAuth can be added later if required.

---

## 14. Configuration

Configuration is environment-driven and validated at startup.

Expected settings include:

```text
NODE_ENV
LOG_LEVEL
DATABASE_URL
MNEMOS_TRANSPORT                 # stdio | http | both
HTTP_HOST
HTTP_PORT
HTTP_PATH
HTTP_AUTH_MODE
EMBEDDING_PROVIDER
EMBEDDING_MODEL
EMBEDDING_DIMENSIONS
EMBEDDING_API_KEY                # optional; secret
EXTRACTION_PROVIDER
EXTRACTION_MODEL
EXTRACTION_API_KEY               # optional; secret
DEFAULT_CONTEXT_LIMIT
DEFAULT_SEARCH_LIMIT
PROPOSAL_TTL
```

Names may change during implementation, but configuration must remain documented in `.env.example`. Never commit real credentials.

---

## 15. Error handling and reliability

- Use typed application errors for validation, not-found, permission, conflict, provider, and persistence failures.
- A failed extraction must not create a partial canonical memory.
- A failed embedding must not lose an approved memory; mark the embedding for retry and preserve keyword retrieval.
- Proposal approval and memory version creation must be transactional.
- Use optimistic concurrency for updates.
- Log operation IDs and agent IDs, but avoid logging complete private memory contents by default.
- Provide graceful shutdown and close database connections cleanly.
- On startup, verify required database extensions and schema version; fail with a clear diagnostic if unavailable.

---

## 16. Observability

V1 requires:
- Structured logs.
- Request/operation correlation IDs.
- Basic health/readiness check for HTTP deployment (outside MCP protocol endpoint).
- Counts for memories, pending proposals, embedding failures, and retrieval failures.
- Timing for extraction, embedding, database, and retrieval operations.

Do not introduce a metrics stack or tracing vendor requirement in V1.

---

## 17. Testing strategy

### 17.1 Unit tests

- Memory validation and lifecycle rules.
- Scope and permission checks.
- Proposal state transitions.
- Version conflict detection.
- Hybrid ranking/RRF logic.
- Context size limiting.
- Provider adapter behavior using fakes.

### 17.2 Integration tests

Use a real PostgreSQL + pgvector test database to verify:
- Migrations apply cleanly.
- Create/read/update/archive flows.
- Version history is preserved.
- Proposals approve/reject correctly.
- Embeddings persist and semantic search works.
- Full-text and metadata filters work.
- Hybrid results combine correctly.
- Project/private scopes do not leak across agents.

### 17.3 MCP tests

- Tool discovery and invocation over STDIO.
- Tool discovery and invocation over Streamable HTTP.
- Invalid arguments return useful errors.
- Authentication and authorization are enforced for HTTP.

### 17.4 End-to-end acceptance test

1. Agent A connects to Mnemos.
2. Agent A submits: "The payment engine uses Go and PostgreSQL."
3. Mnemos creates a pending proposal.
4. An authorized reviewer approves it.
5. Agent B connects independently.
6. Agent B calls `mnemos_context` or `mnemos_recall` with a related query.
7. Agent B receives the approved memory with its source and project metadata.
8. Restart Mnemos and repeat the retrieval to verify persistence.

---

## 18. V1 acceptance criteria

V1 is complete when:

- [ ] Two independent MCP clients can connect to the same Mnemos instance.
- [ ] A client can submit raw information and receive memory proposals.
- [ ] An authorized client can approve and reject proposals.
- [ ] Approved memories persist in PostgreSQL across restarts.
- [ ] Another client can retrieve shared memories.
- [ ] Semantic, keyword, and metadata-filtered retrieval work.
- [ ] Hybrid ranking returns useful combined results.
- [ ] Global, project, and private scopes are enforced.
- [ ] Updates preserve immutable version history.
- [ ] Conflicting or stale updates require review.
- [ ] Both STDIO and Streamable HTTP transports work.
- [ ] HTTP authentication and per-agent authorization work.
- [ ] Provider implementations can be changed through configuration.
- [ ] Embedding failure does not cause approved memory loss.
- [ ] Automated unit, integration, MCP, and end-to-end tests pass.

---

## 19. Implementation milestones

### M1 — Foundation

- Initialize TypeScript/pnpm project.
- Add configuration and logging.
- Add Docker Compose with PostgreSQL + pgvector.
- Add migrations and database health checks.

**Exit condition:** Application starts and connects to the database.

### M2 — Memory core

- Implement domain types and validation.
- Implement repositories and memory manager.
- Add projects, scopes, and basic access rules.
- Add version history and lifecycle operations.

**Exit condition:** Memories can be created, retrieved, updated, archived, and survive restart without any LLM or MCP dependency.

### M3 — Embeddings and retrieval

- Implement embedding provider interface and one provider adapter.
- Add embedding persistence.
- Implement vector and PostgreSQL full-text search.
- Combine rankings and apply metadata/access filters.

**Exit condition:** Hybrid search returns relevant authorized memories.

### M4 — Assisted memory

- Implement extraction provider interface and one adapter.
- Implement proposals, review, approval, rejection, and conflict handling.
- Make approval transactional and embedding failures recoverable.

**Exit condition:** Raw submissions become reviewable proposals and approved memories.

### M5 — MCP interface

- Register V1 tools and resources.
- Map tool calls to application services.
- Add structured outputs and error mapping.

**Exit condition:** MCP clients can use the memory system through tools and resources.

### M6 — Transports and hardening

- Add STDIO transport.
- Add Streamable HTTP transport.
- Add HTTP authentication, agent identity, authorization, limits, and health checks.
- Complete end-to-end tests and deployment documentation.

**Exit condition:** Two independent clients can share memory over the supported transports.

---

## 20. Open decisions to settle before implementation

These are intentionally left configurable or unresolved rather than guessed:

1. **Embedding model:** Select the first model and vector dimension before the initial vector migration.
2. **Extraction model:** Select a local or hosted model and its API format.
3. **Proposal review policy:** V1 default is explicit approval; decide whether the owner, a designated reviewer, or multiple authorized agents can approve.
4. **Private scope semantics:** Confirm whether private means owner-only or creator-agent-only in the first deployment.
5. **Deletion policy:** Choose soft-delete retention and whether permanent purge is exposed in V1.
6. **HTTP authentication:** Static per-agent tokens are the proposed V1 default; confirm whether this is sufficient for the first deployment.

These choices must not block work on the database foundation or memory CRUD, except the embedding model choice, which must be settled before the vector schema/index is finalized.

---

## 21. Design principles

1. **One source of truth:** PostgreSQL owns canonical memory.
2. **Agents remain independent:** Mnemos shares knowledge, not model intelligence.
3. **Explicit memory creation:** Submitted information becomes a proposal before permanent storage.
4. **Retrieval is scoped:** Relevance never overrides access permissions.
5. **History is preserved:** Updates do not silently erase previous decisions.
6. **Providers are replaceable:** Core logic does not depend on one LLM or embedding vendor.
7. **MCP is an interface, not the core:** Other interfaces can be added without rewriting memory logic.
8. **Start simple:** One deployable application, one PostgreSQL database, no Redis, no microservices in V1.

