import { describe, it, expect } from "vitest";
import { FakeExtractionProvider } from "../src/providers/fake-extraction-provider.js";

const provider = new FakeExtractionProvider();
const projectId = "00000000-0000-4000-8000-000000000001";

describe("FakeExtractionProvider", () => {
  it("splits sentences and drops fragments with too few tokens", async () => {
    const out = await provider.extract({
      text: "The payment engine uses Go. Yes. PostgreSQL stores everything here.",
    });
    expect(out.map((c) => c.content)).toEqual([
      "The payment engine uses Go.",
      "PostgreSQL stores everything here.",
    ]);
  });

  it("classifies by first matching keyword rule", async () => {
    const out = await provider.extract({
      text:
        "We decided to use Kafka because throughput matters. " +
        "Always run migrations before deploy. " +
        "I prefer tabs over spaces. " +
        "The release deadline slipped. " +
        "We shipped the fix yesterday. " +
        "The gateway listens on port 8443.",
    });
    expect(out.map((c) => c.type)).toEqual([
      "decision",
      "procedural",
      "preference",
      "project",
      "episodic",
      "semantic",
    ]);
  });

  it("defaults to global scope and never invents a project", async () => {
    const out = await provider.extract({ text: "The build runs on Node 22 now." });
    expect(out[0]).toMatchObject({ scope: "global", projectId: null });
  });

  it("takes project id only from hints", async () => {
    const out = await provider.extract({
      text: "The build runs on Node 22 now.",
      hints: { scope: "project", projectId },
    });
    expect(out[0]).toMatchObject({ scope: "project", projectId });
  });

  it("hint type overrides classification", async () => {
    const out = await provider.extract({
      text: "We decided to use Kafka because throughput matters.",
      hints: { type: "episodic" },
    });
    expect(out[0].type).toBe("episodic");
  });

  it("marks urgency words higher importance", async () => {
    const out = await provider.extract({
      text: "This blocker is critical for launch. The sky is blue today.",
    });
    expect(out.some((c) => c.importance === 7)).toBe(true);
  });

  it("dedupes repeated sentences and caps at ten candidates", async () => {
    const sentences = Array.from({ length: 14 }, (_, i) => `Fact number ${i} about widgets.`);
    const text = [sentences[0], ...sentences].join(" ");
    const out = await provider.extract({ text });
    expect(out.length).toBe(10);
    expect(new Set(out.map((c) => c.content)).size).toBe(10);
  });

  it("is deterministic across calls", async () => {
    const text = "The cache expires after five minutes. Always prune stale rows.";
    const a = await provider.extract({ text });
    const b = await provider.extract({ text });
    expect(a).toEqual(b);
  });
});
