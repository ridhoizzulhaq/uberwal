// @vitest-environment jsdom

/**
 * Component tests for the dashboard login page.
 *
 * These tests cover the client-side behavior the login page is responsible
 * for, isolating it from the real `login` server action and from
 * `next/navigation` so we can drive each branch deterministically:
 *
 *   1. **Empty fields → submit disabled** (Req 7.3). With no input typed
 *      yet, the submit button is in `disabled` state so a stray click
 *      cannot dispatch an action.
 *   2. **Invalid format → submit disabled** (Req 7.4). A delegate key
 *      that is not 64 hex characters keeps the button disabled even
 *      after both fields are non-empty, because format validation reuses
 *      the same shared predicates the server action uses.
 *   3. **Happy path → router.push to `/`**. With both fields well-formed
 *      and the server action resolving `{ ok: true }`, the page navigates
 *      to the consolidated workspace at `/` (login always opens a
 *      `"developer"` session; there is no role selector).
 *   4. **invalid-credentials response → red banner + fields preserved**
 *      (Req 7.2). The discriminated `kind` ends up on the rendered
 *      banner via `data-error-kind`, and the typed values stay in their
 *      inputs so the viewer can correct a typo.
 *   5. **connectivity response → amber banner + fields preserved**
 *      (Req 7.5). Distinct `data-error-kind` so styling diverges from
 *      the invalid-credentials branch and form fields are preserved.
 *   6. **(removed)** The role selector was removed when the dashboard
 *      consolidated into a single workspace; login always opens a
 *      `"developer"` session and redirects to `/`.
 *
 * The `next/navigation` mock surfaces a `router.push` spy that lets us
 * assert the redirect target. The `../actions/auth` mock returns a
 * deferred result on each call so the test controls when each `login()`
 * promise settles.
 *
 * Validates: Requirements 7.2, 7.3, 7.4, 7.5, 13.1
 *
 * Notes on test mechanics:
 *  - `vi.useFakeTimers()` is enabled per test so any `setTimeout`
 *    inside `login` (the action under real conditions has a 10s
 *    timeout) cannot leak into the next test. The mock resolves
 *    synchronously here, so timers stay idle in practice.
 *  - `cleanup()` runs after each test to unmount React trees so the
 *    next test starts from a fresh DOM and `sessionStorage`.
 *  - We reset `sessionStorage` between tests so the role selector's
 *    default-on-mount path is exercised independently each time.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";

/**
 * Hoisted mock state.
 *
 * `vi.mock(...)` factories run before module-scope `const`s are
 * initialized, so we use `vi.hoisted` to pre-create the spies and let
 * the factories close over them.
 */
const mocks = vi.hoisted(() => ({
  /** Spy for `useRouter().push`. */
  push: vi.fn<(path: string) => void>(),
  /** Spy for the `login` server action. */
  login: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mocks.push,
    replace: vi.fn(),
    refresh: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
}));

vi.mock("../actions/auth", () => ({
  login: mocks.login,
}));

// `LoginPage` must be imported AFTER `vi.mock(...)` so it picks up the mocks.
import LoginPage from "./page";

/** A 64-char hex string accepted by `isValidDelegateKey`. */
const VALID_DELEGATE_KEY = "a".repeat(64);
/** A `0x`-prefixed 64-char hex string accepted by `isValidAccountId`. */
const VALID_ACCOUNT_ID = "0x" + "b".repeat(64);

/** A delegate key the format validator must reject (only 32 chars). */
const INVALID_DELEGATE_KEY = "a".repeat(32);

/**
 * Convenience for typing into the three login fields. Uses
 * `fireEvent.change` (RTL's recommended path for controlled inputs) so
 * each call mirrors React's onChange contract.
 */
function fillCredentials(delegateKey: string, accountId: string): void {
  const delegateInput = screen.getByLabelText(
    /delegate key/i,
  ) as HTMLInputElement;
  const accountInput = screen.getByLabelText(/account id/i) as HTMLInputElement;
  fireEvent.change(delegateInput, { target: { value: delegateKey } });
  fireEvent.change(accountInput, { target: { value: accountId } });
}

describe("<LoginPage />", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.push.mockReset();
    mocks.login.mockReset();
    // The login page hydrates the role from sessionStorage on mount,
    // so clear it between tests to keep the default-role path testable.
    if (typeof window !== "undefined") {
      window.sessionStorage.clear();
    }
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    cleanup();
  });

  it("disables the submit button while either field is empty (Req 7.3)", () => {
    render(<LoginPage />);

    const submit = screen.getByRole("button", {
      name: /sign in/i,
    }) as HTMLButtonElement;

    // No input typed yet: both fields empty → submit disabled (Req 7.3).
    expect(submit.disabled).toBe(true);

    // Typing only the delegate key still leaves the account ID empty,
    // so the button must remain disabled (Req 7.3 covers either field).
    fireEvent.change(screen.getByLabelText(/delegate key/i), {
      target: { value: VALID_DELEGATE_KEY },
    });
    expect(submit.disabled).toBe(true);
  });

  it("disables the submit button when the delegate key has an invalid format (Req 7.4)", () => {
    render(<LoginPage />);

    fillCredentials(INVALID_DELEGATE_KEY, VALID_ACCOUNT_ID);

    const submit = screen.getByRole("button", {
      name: /sign in/i,
    }) as HTMLButtonElement;

    // Both fields are non-empty but the delegate key isn't 64 hex chars,
    // so format validation must keep the button disabled (Req 7.4).
    expect(submit.disabled).toBe(true);

    // The page surfaces a per-field validation message describing the
    // expected format so the viewer knows what to correct.
    expect(
      screen.getByText(/64 hexadecimal characters/i),
    ).toBeTruthy();

    // No round-trip should have happened — the disabled button blocks
    // submission entirely.
    expect(mocks.login).not.toHaveBeenCalled();
  });

  it("on a valid submission, opens a developer session and navigates to /", async () => {
    mocks.login.mockResolvedValueOnce({ ok: true });

    render(<LoginPage />);

    fillCredentials(VALID_DELEGATE_KEY, VALID_ACCOUNT_ID);

    const submit = screen.getByRole("button", {
      name: /sign in/i,
    }) as HTMLButtonElement;
    expect(submit.disabled).toBe(false);

    // Submitting the form invokes the mocked `login` action and, on
    // resolution, the page redirects to the consolidated workspace at `/`.
    await act(async () => {
      fireEvent.click(submit);
      // Flush the resolved-promise microtask so the redirect runs.
      await Promise.resolve();
    });

    expect(mocks.login).toHaveBeenCalledTimes(1);
    expect(mocks.login).toHaveBeenCalledWith({
      delegateKey: VALID_DELEGATE_KEY,
      accountId: VALID_ACCOUNT_ID,
      role: "developer",
    });
    expect(mocks.push).toHaveBeenCalledTimes(1);
    expect(mocks.push).toHaveBeenCalledWith("/");
  });

  it("renders the red invalid-credentials banner and preserves field values (Req 7.2)", async () => {
    mocks.login.mockResolvedValueOnce({
      ok: false,
      kind: "invalid-credentials",
      message: "Invalid credentials",
    });

    render(<LoginPage />);

    fillCredentials(VALID_DELEGATE_KEY, VALID_ACCOUNT_ID);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
      await Promise.resolve();
    });

    // The banner carries the discriminated `kind` so styling can
    // diverge between the two failure modes (Req 7.2 vs 7.5).
    const banner = screen.getByRole("alert");
    expect(banner.getAttribute("data-error-kind")).toBe("invalid-credentials");

    // Form fields preserved so the viewer can fix a typo without
    // re-entering both 64-character hex strings (Req 7.2).
    const delegateInput = screen.getByLabelText(
      /delegate key/i,
    ) as HTMLInputElement;
    const accountInput = screen.getByLabelText(
      /account id/i,
    ) as HTMLInputElement;
    expect(delegateInput.value).toBe(VALID_DELEGATE_KEY);
    expect(accountInput.value).toBe(VALID_ACCOUNT_ID);

    // No navigation on a failed login.
    expect(mocks.push).not.toHaveBeenCalled();
  });

  it("renders the amber connectivity banner and preserves field values (Req 7.5)", async () => {
    mocks.login.mockResolvedValueOnce({
      ok: false,
      kind: "connectivity",
      message: "Could not reach the relayer.",
    });

    render(<LoginPage />);

    fillCredentials(VALID_DELEGATE_KEY, VALID_ACCOUNT_ID);

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /sign in/i }));
      await Promise.resolve();
    });

    const banner = screen.getByRole("alert");
    expect(banner.getAttribute("data-error-kind")).toBe("connectivity");

    // Different copy from the invalid-credentials path so the two
    // banners are visually distinct (Req 7.5).
    expect(banner.textContent).toMatch(/connection/i);

    // Form fields preserved so the viewer can retry without re-typing.
    const delegateInput = screen.getByLabelText(
      /delegate key/i,
    ) as HTMLInputElement;
    const accountInput = screen.getByLabelText(
      /account id/i,
    ) as HTMLInputElement;
    expect(delegateInput.value).toBe(VALID_DELEGATE_KEY);
    expect(accountInput.value).toBe(VALID_ACCOUNT_ID);

    expect(mocks.push).not.toHaveBeenCalled();
  });
});
