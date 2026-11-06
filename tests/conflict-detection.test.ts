import { describe, it, expect } from "vitest";
import {
  decideConflict,
  looksLikeSecret,
  tokenContainment,
  tokenize,
  type ConflictPoolItem,
} from "../src/services/conflict-detection.js";

const item = (id: string, content: string): ConflictPoolItem => ({
  id,
  content,
  type: "semantic",
  currentVersion: 2,
});

describe("tokenize / tokenContainment", () => {
  it("drops stopwords, short tokens, and punctuation", () => {
    // "the" is a stopword; "go" is under the 3-char floor.
    expect(tokenize("The payment engine uses Go!")).toEqual(["payment", "engine", "uses"]);
  });

  it("measures containment asymmetrically", () => {
    const short = tokenContainment(
      "payment engine written in Go",
      "the payment engine uses Go and PostgreSQL for storage",
    );
    const long = tokenContainment(
      "the payment engine uses Go and PostgreSQL for storage",
      "payment engine written in Go",
    );
    expect(short.containment).toBeGreaterThan(long.containment);
    expect(short.shared).toBe(long.shared);
  });
});

describe("decideConflict", () => {
  it("proposes an update for a strong partial overlap", () => {
    const pool = [
      item("00000000-0000-4000-8000-000000000001",
        "the payment engine uses Go and PostgreSQL for storage"),
    ];
    const d = decideConflict(
      { content: "the payment engine uses Go with MySQL instead", type: "semantic" },
      pool,
    );
    expect(d.action).toBe("update");
    expect(d.targetVersion).toBe(2);
  });

  it("ignores pool items of a different type", () => {
    const pool = [item("00000000-0000-4000-8000-000000000001",
      "the payment engine uses Go and PostgreSQL")];
    pool[0].type = "preference";
    const d = decideConflict(
      { content: "the payment engine uses Go and PostgreSQL", type: "semantic" },
      pool,
    );
    expect(d.action).toBe("create");
    expect(d.duplicate).toBeUndefined();
  });

  it("flags exact token-set matches as duplicates", () => {
    const pool = [item("00000000-0000-4000-8000-000000000002",
      "Payment engine uses Go and PostgreSQL.")];
    const d = decideConflict(
      { content: "the payment engine uses go AND postgresql", type: "semantic" },
      pool,
    );
    expect(d.duplicate).toBe(true);
  });

  it("stays on create below the shared-token floor", () => {
    const pool = [item("00000000-0000-4000-8000-000000000003",
      "the engine and the gateway and the broker share metrics")];
    const d = decideConflict({ content: "the engine exports latency", type: "semantic" }, pool);
    expect(d.action).toBe("create");
  });

  it("picks the highest containment, deterministically on ties", () => {
    const pool = [
      item("00000000-0000-4000-8000-000000000005", "alpha beta gamma delta epsilon"),
      item("00000000-0000-4000-8000-000000000004", "alpha beta gamma zeta eta"),
    ];
    const d = decideConflict({ content: "alpha beta gamma delta", type: "semantic" }, pool);
    expect(d.targetMemoryId).toBe(pool[0].id);
  });
});

describe("looksLikeSecret", () => {
  it("rejects common credential shapes", () => {
    for (const text of [
      "key AKIAIOSFODNN7EXAMPLE for s3",
      "-----BEGIN RSA PRIVATE KEY-----",
      "sk-abcdefghijklmnopqrstuvwxyz012345",
      "ghp_abcdefghijklmnopqrstuvwxyz123456",
      "AIzaSyABCDEFGHIJKLMNOPQRSTUVWXYZabcdefg",
      "password = SuperSecret123456",
    ]) {
      expect(looksLikeSecret(text), text).toBe(true);
    }
  });

  it("accepts ordinary technical prose", () => {
    for (const text of [
      "The payment engine uses Go and PostgreSQL.",
      "Rotate the API key before the release deadline.",
      "The base64 blob is stored in the config column",
    ]) {
      expect(looksLikeSecret(text), text).toBe(false);
    }
  });
});
