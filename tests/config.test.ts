import { describe, it, expect, beforeEach } from "vitest";
import { loadConfig, resetConfig } from "../src/config/index.js";

describe("loadConfig", () => {
  beforeEach(() => {
    resetConfig();
    // Clear env vars that might interfere
    delete process.env.NODE_ENV;
    delete process.env.LOG_LEVEL;
    delete process.env.DATABASE_URL;
    delete process.env.MNEMOS_TRANSPORT;
  });

  it("returns defaults when no env vars are set", () => {
    const config = loadConfig();
    expect(config.nodeEnv).toBe("development");
    expect(config.logLevel).toBe("info");
    expect(config.databaseUrl).toBe("postgres://mnemos:mnemos@localhost:5432/mnemos");
    expect(config.transport).toBe("stdio");
    expect(config.http.port).toBe(3100);
    expect(config.embedding.dimensions).toBe(384);
    expect(config.limits.defaultContextLimit).toBe(20);
    expect(config.limits.proposalTtl).toBe(604800);
  });

  it("reads values from environment variables", () => {
    process.env.NODE_ENV = "production";
    process.env.LOG_LEVEL = "debug";
    process.env.DATABASE_URL = "postgres://user:pass@remote:5432/mnemos";
    process.env.MNEMOS_TRANSPORT = "http";
    process.env.HTTP_PORT = "4000";
    process.env.EMBEDDING_DIMENSIONS = "768";
    process.env.DEFAULT_CONTEXT_LIMIT = "50";

    const config = loadConfig();
    expect(config.nodeEnv).toBe("production");
    expect(config.logLevel).toBe("debug");
    expect(config.databaseUrl).toBe("postgres://user:pass@remote:5432/mnemos");
    expect(config.transport).toBe("http");
    expect(config.http.port).toBe(4000);
    expect(config.embedding.dimensions).toBe(768);
    expect(config.limits.defaultContextLimit).toBe(50);
  });

  it("caches the config and returns the same object", () => {
    const a = loadConfig();
    const b = loadConfig();
    expect(a).toBe(b);
  });

  it("reloads after resetConfig", () => {
    const a = loadConfig();
    resetConfig();
    const b = loadConfig();
    expect(a).not.toBe(b);
  });
});