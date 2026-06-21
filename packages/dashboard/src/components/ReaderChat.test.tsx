// @vitest-environment jsdom

/**
 * Component tests for `<ReaderChat />`.
 *
 * The chat is the client surface of the Reader Agent. It owns the running
 * conversation and talks only to the `askReader` server action, which is
 * mocked here so the test never touches MemWal or the OpenAI SDK.
 *
 * Covered:
 *   - Submitting a message calls `askReader` with the running `messages`
 *     array (including the just-typed user turn) and the selected preset,
 *     then renders the assistant reply plus the "based on N memories"
 *     affordance.
 *   - A second turn forwards the full transcript (user, assistant, user) so
 *     the conversation is genuinely multi-turn.
 *   - A failed turn keeps the prior conversation on screen and shows an
 *     error banner.
 *
 * Notes on mechanics:
 *   - `vi.mock("../app/actions/reader", …)` is hoisted above the component
 *     import so the component picks up the mocked action.
 *   - The submit path is async; we use `findBy*` to await the reply.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

vi.mock("../app/actions/reader", () => ({
  askReader: vi.fn(),
}));

import { askReader } from "../app/actions/reader";
import { ReaderChat } from "./ReaderChat";

const askReaderMock = vi.mocked(askReader);

/** Type a message into the textarea and submit the form. */
function submitMessage(text: string) {
  const textarea = screen.getByLabelText("Message") as HTMLTextAreaElement;
  fireEvent.change(textarea, { target: { value: text } });
  fireEvent.submit(textarea.closest("form") as HTMLFormElement);
}

describe("<ReaderChat />", () => {
  beforeEach(() => {
    askReaderMock.mockReset();
  });

  afterEach(() => {
    cleanup();
  });

  it("submits the running messages array and renders the reply", async () => {
    askReaderMock.mockResolvedValueOnce({
      ok: true,
      reply: "Strong fit for a backend role.",
      usedMemories: [
        { text: "Built JWT auth", distance: 0.2 },
        { text: "Wrote integration tests", distance: 0.4 },
      ],
    });

    render(<ReaderChat />);

    submitMessage("Is this candidate a backend fit?");

    // The user turn renders immediately.
    expect(
      await screen.findByText("Is this candidate a backend fit?"),
    ).toBeTruthy();

    // The assistant reply renders once the action resolves.
    expect(
      await screen.findByText("Strong fit for a backend role."),
    ).toBeTruthy();

    // The "based on N memories" affordance reflects usedMemories.length.
    expect(await screen.findByText(/based on 2 memories/i)).toBeTruthy();

    // The action saw the running conversation (just the user turn so far)
    // and the default recruiting preset.
    expect(askReaderMock).toHaveBeenCalledTimes(1);
    expect(askReaderMock).toHaveBeenCalledWith({
      preset: "recruiting",
      messages: [
        { role: "user", content: "Is this candidate a backend fit?" },
      ],
    });
  });

  it("forwards the full transcript on a second turn", async () => {
    askReaderMock
      .mockResolvedValueOnce({
        ok: true,
        reply: "First reply.",
        usedMemories: [{ text: "m1", distance: 0.1 }],
      })
      .mockResolvedValueOnce({
        ok: true,
        reply: "Second reply.",
        usedMemories: [],
      });

    render(<ReaderChat />);

    submitMessage("first question");
    await screen.findByText("First reply.");

    submitMessage("second question");
    await screen.findByText("Second reply.");

    // The second call carries the whole multi-turn conversation.
    expect(askReaderMock).toHaveBeenLastCalledWith({
      preset: "recruiting",
      messages: [
        { role: "user", content: "first question" },
        { role: "assistant", content: "First reply." },
        { role: "user", content: "second question" },
      ],
    });

    // A reply grounded in zero memories shows the singular/plural-safe count.
    expect(screen.getByText(/based on 0 memories/i)).toBeTruthy();
  });

  it("keeps the conversation and shows an error banner on failure", async () => {
    askReaderMock
      .mockResolvedValueOnce({
        ok: true,
        reply: "An earlier reply.",
        usedMemories: [{ text: "m1", distance: 0.3 }],
      })
      .mockResolvedValueOnce({ ok: false, message: "Relayer unavailable" });

    render(<ReaderChat />);

    submitMessage("first question");
    await screen.findByText("An earlier reply.");

    submitMessage("doomed question");

    // The error banner appears with the action's message.
    const banner = await screen.findByRole("alert");
    expect(banner.textContent).toContain("The reader agent failed.");
    expect(banner.textContent).toContain("Relayer unavailable");

    // The prior conversation is retained — both the earlier reply and the
    // failing user turn stay on screen.
    await waitFor(() => {
      expect(screen.getByText("An earlier reply.")).toBeTruthy();
      expect(screen.getByText("first question")).toBeTruthy();
      expect(screen.getByText("doomed question")).toBeTruthy();
    });
  });
});
