// @vitest-environment jsdom

/**
 * Component tests for `<DistanceSlider />`.
 *
 * These exercise the slider's input contract end-to-end inside jsdom:
 *  - The 300ms debounce window collapses a flurry of drag events into a
 *    single `onChange` invocation, with the *final* value, so each
 *    debounce window produces exactly one re-recall (Req 12.2).
 *  - The visible numeric label updates on every drag tick to the formatted
 *    distance, so the viewer always sees the live value while dragging
 *    (Req 12.3).
 *  - The underlying `<input type="range">` renders with `min=0`,
 *    `max=1`, and `step=0.01`, the only valid bounds and step for the
 *    relevance filter (Req 12.1).
 *
 * Validates: Requirements 12.1, 12.2
 *
 * Notes on test mechanics:
 *  - `vi.useFakeTimers()` is required because the debounce uses
 *    `setTimeout`; without fake timers we would have to wait for real
 *    wall-clock time on every assertion.
 *  - `cleanup()` runs after each test to unmount React trees so the
 *    next test starts from a fresh DOM and timer queue.
 *  - Fake timers must be torn down at the end of each test (and any
 *    pending async microtasks flushed) to avoid leaking state between
 *    tests in the same Vitest run.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

import { DistanceSlider } from "./DistanceSlider";
import { formatDistance } from "../lib/format";

describe("<DistanceSlider />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Drain any pending timers, restore real timers, and unmount the
    // React tree so the next test starts with a clean DOM.
    vi.clearAllTimers();
    vi.useRealTimers();
    cleanup();
  });

  it("renders the range input with min=0, max=1, step=0.01 (Req 12.1)", () => {
    const handler = vi.fn();
    render(<DistanceSlider onChange={handler} />);

    const slider = screen.getByRole("slider");
    expect(slider).toBeInstanceOf(HTMLInputElement);
    const input = slider as HTMLInputElement;
    expect(input.type).toBe("range");
    expect(input.min).toBe("0");
    expect(input.max).toBe("1");
    expect(input.step).toBe("0.01");
  });

  it("debounces rapid input and fires onChange exactly once with the final value (Req 12.2)", () => {
    const handler = vi.fn<(maxDistance: number) => void>();
    render(<DistanceSlider onChange={handler} />);

    const slider = screen.getByRole("slider") as HTMLInputElement;

    // Three rapid drags inside a single debounce window. Each fires
    // synchronously while the timer is still pending; the previous
    // `setTimeout` is cleared on every change so only the timer
    // scheduled by the last drag survives.
    act(() => {
      fireEvent.change(slider, { target: { value: "0.5" } });
      fireEvent.change(slider, { target: { value: "0.6" } });
      fireEvent.change(slider, { target: { value: "0.7" } });
    });

    // Advance the clock past the most recent debounce window but stop
    // short of the 300ms threshold so the surviving timer is still
    // pending. The handler must not fire yet (Req 12.2).
    act(() => {
      vi.advanceTimersByTime(299);
    });
    expect(handler).not.toHaveBeenCalled();

    // Cross the threshold. Exactly one handler call, with the final
    // dragged value (0.7), regardless of how many intermediate drag
    // events preceded it (Req 12.2).
    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(0.7);
  });

  it("updates the displayed value to the formatted distance on every change (Req 12.3)", () => {
    const handler = vi.fn();
    render(<DistanceSlider onChange={handler} />);

    const slider = screen.getByRole("slider") as HTMLInputElement;

    // The default value is 1.0 (Req 12.1) — the readout reflects it
    // before any drag occurs.
    expect(screen.getByText(formatDistance(1.0))).toBeTruthy();

    // Each change updates the visible readout immediately, even though
    // the debounced `onChange` callback has not fired yet.
    act(() => {
      fireEvent.change(slider, { target: { value: "0.5" } });
    });
    expect(screen.getByText(formatDistance(0.5))).toBeTruthy();

    act(() => {
      fireEvent.change(slider, { target: { value: "0.6" } });
    });
    expect(screen.getByText(formatDistance(0.6))).toBeTruthy();

    act(() => {
      fireEvent.change(slider, { target: { value: "0.7" } });
    });
    expect(screen.getByText(formatDistance(0.7))).toBeTruthy();

    // The callback is still pending at this point — debounce hasn't
    // elapsed — so the visible-vs-callback decoupling holds.
    expect(handler).not.toHaveBeenCalled();
  });
});
