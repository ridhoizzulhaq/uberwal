/**
 * Unit tests for the server-only Reader Agent (`runReader`).
 *
 * `runReader` is the recall + reason core behind the dashboard's assistant
 * chat. These tests pin its contract without touching the network:
 *
 *   - **Recall targeting** — the recruiting preset recalls only from
 *     `skills`; the productivity preset recalls from both `productivity`
 *     and `reports`. Each recall uses the latest user message as its query.
 *   - **Grounding** — the recalled `text` is injected into the Claude
 *     `system` prompt's "Context memories" block, and the preset persona is
 *     present, so the model reasons over real memory rather than inventing.
 *   - **Discriminated union** — success returns `{ ok: true, reply,
 *     usedMemories }`; no-session, missing API key, and thrown errors all
 *     collapse to `{ ok: false, message }`.
 *
 * Both the per-request `MemWalClient` factory and the `openai` module are
 * mocked, so the test never builds a real client or reaches the cookie /
 * relayer / OpenAI boundaries.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Hoisted handles for the mocked factory and OpenAI client.
 *
 * `vi.mock` is hoisted above imports, so the factory bodies cannot close over
 * regular module-scope variables. `vi.hoisted` opts these handles into the
 * same hoisting pass.
 */
const mocks = vi.hoisted(() => ({
  getMemWalClientFromSession: vi.fn(),
  /** Captures the params passed to `chat.completions.create`. */
  create: vi.fn(),
}));

// `reader-agent` is the module under test, so (unlike the recall tests, which
// mock the whole factory) we import it for real — which pulls in its
// top-level `import "server-only"`. That guard package throws outside a React
// Server Component bundler, so we stub it to an empty module here.
vi.mock("server-only", () => ({}));

vi.mock("./memwal-factory.js", () => ({
  getMemWalClientFromSession: mocks.getMemWalClientFromSession,
}));

// Mock the OpenAI SDK so `new OpenAI({ apiKey })` yields a client whose
// `chat.completions.create` is our spy. `OpenAI` is the default export.
vi.mock("openai", () => ({
  default: class {
    chat = { completions: { create: mocks.create } };
  },
}));

// Import after mocks are registered.
import { runReader } from "./reader-agent.js";

/** Build a mock MemWalClient whose `recall` records calls and returns rows. */
function makeClient(
  rowsByNamespace: Record<string, { blob_id: string; text: string; distance: number }[]>,
) {
  const recall = vi.fn(async (params: { namespace: string }) => {
    const results = rowsByNamespace[params.namespace] ?? [];
    return { results, total: results.length };
  });
  return { client: { recall }, recall };
}

/** A well-formed OpenAI chat-completion response. */
function textResponse(text: string) {
  return { choices: [{ message: { content: text } }] };
}

describe("runReader — recall + reason", () => {
  beforeEach(() => {
    process.env["RELAYER_URL"] = "https://relayer.example";
    process.env["SESSION_SECRET"] = "x".repeat(64);
    process.env["OPENAI_API_KEY"] = "test-openai-key";
    delete process.env["OPENAI_MODEL"];
    delete process.env["OPENAI_BASE_URL"];

    mocks.getMemWalClientFromSession.mockReset();
    mocks.create.mockReset();
  });

  it("returns 'Not authenticated' when there is no session", async () => {
    mocks.getMemWalClientFromSession.mockResolvedValueOnce(null);

    const result = await runReader({
      preset: "recruiting",
      messages: [{ role: "user", content: "Is this candidate strong in TS?" }],
    });

    expect(result).toEqual({ ok: false, message: "Not authenticated" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("collapses an OpenAI auth failure into the failure union", async () => {
    // A missing/invalid API key surfaces when `chat.completions.create`
    // runs; that thrown error must collapse into the failure union rather
    // than escaping runReader.
    const { client } = makeClient({ skills: [] });
    mocks.getMemWalClientFromSession.mockResolvedValueOnce(client);
    mocks.create.mockRejectedValueOnce(
      new Error("401 Incorrect API key provided"),
    );

    const result = await runReader({
      preset: "recruiting",
      messages: [{ role: "user", content: "skills?" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("API key");
    }
  });

  it("recalls only the skills namespace for the recruiting preset", async () => {
    const { client, recall } = makeClient({
      skills: [
        { blob_id: "b1", text: "Built JWT auth. Evidence: shipped middleware", distance: 0.2 },
      ],
    });
    mocks.getMemWalClientFromSession.mockResolvedValueOnce(client);
    mocks.create.mockResolvedValueOnce(textResponse("Strong TypeScript evidence."));

    const result = await runReader({
      preset: "recruiting",
      messages: [{ role: "user", content: "TypeScript fit?" }],
    });

    expect(recall).toHaveBeenCalledTimes(1);
    expect(recall).toHaveBeenCalledWith({
      namespace: "skills",
      query: "TypeScript fit?",
      limit: 10,
      maxDistance: 1.0,
    });
    expect(result).toEqual({
      ok: true,
      reply: "Strong TypeScript evidence.",
      usedMemories: [
        { text: "Built JWT auth. Evidence: shipped middleware", distance: 0.2 },
      ],
    });
  });

  it("recalls productivity and reports namespaces for the productivity preset", async () => {
    const { client, recall } = makeClient({
      productivity: [{ blob_id: "p1", text: "Shipped 3 features", distance: 0.5 }],
      reports: [{ blob_id: "r1", text: "Weekly report: steady output", distance: 0.1 }],
    });
    mocks.getMemWalClientFromSession.mockResolvedValueOnce(client);
    mocks.create.mockResolvedValueOnce(textResponse("Consistent shipping cadence."));

    const result = await runReader({
      preset: "productivity",
      messages: [{ role: "user", content: "How productive were they?" }],
    });

    expect(recall).toHaveBeenCalledTimes(2);
    expect(recall).toHaveBeenNthCalledWith(1, {
      namespace: "productivity",
      query: "How productive were they?",
      limit: 10,
      maxDistance: 1.0,
    });
    expect(recall).toHaveBeenNthCalledWith(2, {
      namespace: "reports",
      query: "How productive were they?",
      limit: 10,
      maxDistance: 1.0,
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      // Merged + sorted by ascending distance (most relevant first).
      expect(result.usedMemories).toEqual([
        { text: "Weekly report: steady output", distance: 0.1 },
        { text: "Shipped 3 features", distance: 0.5 },
      ]);
    }
  });

  it("injects the recalled context and preset persona into the system prompt", async () => {
    const { client } = makeClient({
      skills: [{ blob_id: "b1", text: "Expert in Rust async", distance: 0.3 }],
    });
    mocks.getMemWalClientFromSession.mockResolvedValueOnce(client);
    mocks.create.mockResolvedValueOnce(textResponse("ok"));

    await runReader({
      preset: "recruiting",
      messages: [
        { role: "user", content: "first" },
        { role: "assistant", content: "earlier reply" },
        { role: "user", content: "Rust experience?" },
      ],
    });

    expect(mocks.create).toHaveBeenCalledTimes(1);
    const params = mocks.create.mock.calls[0]?.[0];
    expect(params?.model).toBe("openai.gpt-oss-120b");
    // The system prompt is the first message; persona marker + recalled text
    // both present in it.
    const systemMessage = params?.messages?.[0];
    expect(systemMessage?.role).toBe("system");
    expect(systemMessage?.content).toContain("technical recruiter");
    expect(systemMessage?.content).toContain("Context memories:");
    expect(systemMessage?.content).toContain("Expert in Rust async");
    // The full running conversation is forwarded after the system message.
    expect(params?.messages?.slice(1)).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "earlier reply" },
      { role: "user", content: "Rust experience?" },
    ]);
  });

  it("uses the latest user message as the recall query", async () => {
    const { client, recall } = makeClient({ skills: [] });
    mocks.getMemWalClientFromSession.mockResolvedValueOnce(client);
    mocks.create.mockResolvedValueOnce(textResponse("no context"));

    await runReader({
      preset: "recruiting",
      messages: [
        { role: "user", content: "old question" },
        { role: "assistant", content: "old answer" },
        { role: "user", content: "newest question" },
      ],
    });

    expect(recall).toHaveBeenCalledWith(
      expect.objectContaining({ query: "newest question" }),
    );
  });

  it("collapses a thrown recall error into the failure union", async () => {
    const recall = vi.fn().mockRejectedValueOnce(new Error("relayer unreachable"));
    mocks.getMemWalClientFromSession.mockResolvedValueOnce({ recall });

    const result = await runReader({
      preset: "recruiting",
      messages: [{ role: "user", content: "skills?" }],
    });

    expect(result).toEqual({ ok: false, message: "relayer unreachable" });
  });

  it("returns a failure when the model reply is empty", async () => {
    const { client } = makeClient({ skills: [] });
    mocks.getMemWalClientFromSession.mockResolvedValueOnce(client);
    mocks.create.mockResolvedValueOnce(textResponse("   "));

    const result = await runReader({
      preset: "recruiting",
      messages: [{ role: "user", content: "skills?" }],
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.message).toContain("empty reply");
    }
  });
});
