# Mnemos

A shared, persistent memory service for multiple independent AI agents and LLM platforms. Mnemos is an MCP server that gives connected agents access to one canonical memory store — submit information, retrieve relevant memories, and share project context.

> **Status:** Early development (M1 complete, M2 memory core in verification)

> **Note:** `pnpm migrate` is the only schema path and requires the PostgreSQL
> container from `docker compose up -d` (the pgvector image — `CREATE EXTENSION
> vector` fails on stock PostgreSQL). Configuration is read from environment
> variables; copy `.env.example` to `.env` and the scripts load it automatically.

## Features

- **Shared memory** — one store, many agents, permission-controlled access
- **Semantic search** — retrieve memories by meaning, keywords, and metadata
- **Structured proposals** — assisted memory creation with an extraction LLM
- **MCP transport** — supports both STDIO and Streamable HTTP
- **PostgreSQL + pgvector** — durable storage with vector similarity search
- **Modular monolith** — clean internal modules, single deployable service

## Prerequisites

- [Node.js](https://nodejs.org/) >= 22
- [pnpm](https://pnpm.io/) >= 12.16
- [Docker](https://www.docker.com/) (for local PostgreSQL)

## Quick start

```bash
# Install dependencies
pnpm install

# Start PostgreSQL
docker compose up -d

# Run database migrations
pnpm migrate

# Start the server
pnpm dev
```

## Scripts

| Command | Description |
|---|---|
| `pnpm build` | Compile TypeScript |
| `pnpm start` | Run compiled server |
| `pnpm dev` | Watch mode with hot reload |
| `pnpm test` | Run test suite |
| `pnpm test:watch` | Run tests in watch mode |
| `pnpm migrate` | Run database migrations |
| `pnpm lint` | Type-check without emitting |
| `pnpm clean` | Remove build output |

## Project structure

```
src/
├── config/         # Configuration loader
├── core/           # Domain types, validation, typed errors
├── db/             # Connection, migrations, repositories
├── logger/         # Structured logging
├── services/       # Memory manager, access manager
└── types/          # Shared type definitions
```

## License

MIT