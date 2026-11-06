import { z } from "zod";
import type { AppConfig } from "../types/index.js";

const envSchema = z.object({
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  DATABASE_URL: z.url().default("postgres://mnemos:mnemos@localhost:5432/mnemos"),
  MNEMOS_TRANSPORT: z.enum(["stdio", "http", "both"]).default("stdio"),
  HTTP_HOST: z.string().default("0.0.0.0"),
  HTTP_PORT: z.coerce.number().int().positive().default(3100),
  HTTP_PATH: z.string().default("/mcp"),
  HTTP_AUTH_MODE: z.string().default("none"),
  EMBEDDING_PROVIDER: z.string().default("none"),
  EMBEDDING_MODEL: z.string().default(""),
  EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().default(384),
  EXTRACTION_PROVIDER: z.string().default("none"),
  EXTRACTION_MODEL: z.string().default(""),
  DEFAULT_CONTEXT_LIMIT: z.coerce.number().int().positive().default(20),
  DEFAULT_SEARCH_LIMIT: z.coerce.number().int().positive().default(20),
  PROPOSAL_TTL: z.coerce.number().int().nonnegative().default(604800),
});

export type EnvVars = z.infer<typeof envSchema>;

let cachedConfig: AppConfig | null = null;

export function loadConfig(): AppConfig {
  if (cachedConfig) return cachedConfig;

  const result = envSchema.safeParse(process.env);

  if (!result.success) {
    const issues = result.error.issues.map(
      (i) => `  ${i.path.join(".")}: ${i.message}`
    );
    throw new Error(
      `Configuration validation failed:\n${issues.join("\n")}`
    );
  }

  const env = result.data;

  const config: AppConfig = {
    nodeEnv: env.NODE_ENV,
    logLevel: env.LOG_LEVEL,
    databaseUrl: env.DATABASE_URL,
    transport: env.MNEMOS_TRANSPORT,
    http: {
      host: env.HTTP_HOST,
      port: env.HTTP_PORT,
      path: env.HTTP_PATH,
      authMode: env.HTTP_AUTH_MODE,
    },
    embedding: {
      provider: env.EMBEDDING_PROVIDER,
      model: env.EMBEDDING_MODEL,
      dimensions: env.EMBEDDING_DIMENSIONS,
    },
    extraction: {
      provider: env.EXTRACTION_PROVIDER,
      model: env.EXTRACTION_MODEL,
    },
    limits: {
      defaultContextLimit: env.DEFAULT_CONTEXT_LIMIT,
      defaultSearchLimit: env.DEFAULT_SEARCH_LIMIT,
      proposalTtl: env.PROPOSAL_TTL,
    },
  };

  cachedConfig = config;
  return config;
}

export function resetConfig(): void {
  cachedConfig = null;
}