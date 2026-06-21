// @vitest-environment jsdom

/**
 * Component tests for `<SearchBox />`.
 *
 * These cover the two input paths the dashboard exposes for triggering a
 * recall: pressing Enter inside the input (native form submission) and
 * activating the visible Search button (Reqs 8.3, 9.2). Both routes funnel
 * through the same `<form>` `onSubmit`, so we assert the handler receives
 * the typed query verbatim regardless of which path the viewer takes.
 *
 * The default `placeholder` and `aria-label` (`"Search…"` and `"Search"`)
 * are also verified so single-instance usage of the component remains
 * keyboard- and assistive-technology-friendly without per-page wiring.
 *
 * Validates: Requirements 8.3, 9.2
 *
 * Notes on test mechanics:
 *  - jsdom's form submission requires a real button click (or
 *    `fireEvent.submit` on the form). We use the button click path to
 *    cover the more user-realistic interaction; for the Enter path we
 *    submit the form directly, which is the same event jsdom dispatches
 *    when Enter is pressed inside a single-input form.
 *  - `cleanup()` runs after each test to unmount React trees so the
 *    next test starts from a fresh DOM.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SearchBox } from "./SearchBox";

describe("<SearchBox />", () => {
  afterEach(() => {
    cleanup();
  });

  it("calls onSubmit once with the typed value when Enter is pressed (Reqs 8.3, 9.2)", () => {
    const handler = vi.fn<(query: string) => void>();
    render(<SearchBox onSubmit={handler} />);

    const input = screen.getByRole("searchbox") as HTMLInputElement;

    // Type "hello" character-by-character — fireEvent.change is the
    // standard RTL way to drive a controlled input's state.
    fireEvent.change(input, { target: { value: "hello" } });
    expect(input.value).toBe("hello");

    // Pressing Enter inside a form input dispatches a `submit` event
    // on the surrounding form. We trigger the same event explicitly to
    // exercise the Enter path deterministically.
    const form = screen.getByRole("search");
    fireEvent.submit(form);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("hello");
  });

  it("calls onSubmit with the typed value when the search button is clicked (Reqs 8.3, 9.2)", () => {
    const handler = vi.fn<(query: string) => void>();
    render(<SearchBox onSubmit={handler} />);

    const input = screen.getByRole("searchbox") as HTMLInputElement;

    fireEvent.change(input, { target: { value: "world" } });
    expect(input.value).toBe("world");

    const button = screen.getByRole("button", { name: /search/i });
    fireEvent.click(button);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith("world");
  });

  it("renders the default placeholder and aria-label", () => {
    const handler = vi.fn();
    render(<SearchBox onSubmit={handler} />);

    // The default aria-label is "Search" — `getByRole("searchbox")`
    // finds the input by role; we read the attribute directly to
    // confirm the default copy.
    const input = screen.getByRole("searchbox") as HTMLInputElement;
    expect(input.getAttribute("aria-label")).toBe("Search");
    expect(input.placeholder).toBe("Search\u2026"); // the default uses the unicode ellipsis character.

    // The form has the search landmark role and the button is keyboard-activatable.
    expect(screen.getByRole("search")).toBeTruthy();
    expect(screen.getByRole("button", { name: /search/i })).toBeTruthy();
  });
});
