export const MEMORY_TYPES = [
  "semantic",
  "preference",
  "episodic",
  "project",
  "decision",
  "procedural",
] as const;

export type MemoryType = (typeof MEMORY_TYPES)[number];

export const SCOPES = ["global", "project", "private"] as const;
export type Scope = (typeof SCOPES)[number];

export const MEMORY_STATUSES = ["active", "archived", "superseded", "deleted"] as const;
export type MemoryStatus = (typeof MEMORY_STATUSES)[number];

export const SOURCE_KINDS = [
  "agent_submission",
  "import",
  "manual_entry",
  "system_operation",
] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export const AGENT_STATUSES = ["active", "disabled", "revoked"] as const;
export type AgentStatus = (typeof AGENT_STATUSES)[number];

export interface Actor {
  agentId: string;
}

export interface Agent {
  id: string;
  name: string;
  status: AgentStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface Source {
  id: string;
  agentId: string;
  sourceKind: SourceKind;
  externalRef: string | null;
  createdAt: Date;
}

export interface Memory {
  id: string;
  content: string;
  type: MemoryType;
  scope: Scope;
  projectId: string | null;
  status: MemoryStatus;
  importance: number;
  confidence: number;
  sourceId: string;
  createdByAgent: string;
  currentVersion: number;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  archivedAt: Date | null;
}

export interface MemoryVersion {
  id: string;
  memoryId: string;
  version: number;
  content: string;
  type: MemoryType;
  scope: Scope;
  projectId: string | null;
  status: MemoryStatus;
  importance: number;
  confidence: number;
  sourceId: string;
  createdAt: Date;
}

export interface CreateMemoryInput {
  content: string;
  type: MemoryType;
  scope: Scope;
  projectId?: string | null;
  importance?: number;
  confidence?: number;
  tags?: string[];
  sourceKind?: SourceKind;
  externalRef?: string | null;
}

export interface UpdateMemoryInput {
  content?: string;
  type?: MemoryType;
  scope?: Scope;
  projectId?: string | null;
  importance?: number;
  confidence?: number;
  tags?: string[];
  sourceKind?: SourceKind;
  externalRef?: string | null;
}

export interface ListMemoriesFilter {
  projectId?: string;
  scope?: Scope;
  types?: MemoryType[];
  statuses?: MemoryStatus[];
  tags?: string[];
  limit?: number;
  offset?: number;
}

export interface MemoryListResult {
  items: Memory[];
  total: number;
  limit: number;
  offset: number;
}

export interface SearchInput {
  query: string;
  projectIds?: string[];
  types?: MemoryType[];
  tags?: string[];
  statuses?: MemoryStatus[];
  limit?: number;
}

export interface SearchHitResult {
  memory: Memory;
  rank: number;
  score: number;
}

export interface SearchResult {
  items: SearchHitResult[];
  // Per-leg hit counts before fusion; useful for observability and for
  // confirming the keyword-only degrade when no provider is configured.
  legs: { semantic: number; keyword: number };
  fused: number;
}
