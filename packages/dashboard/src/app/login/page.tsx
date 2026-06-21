"use client";

/**
 * Dashboard login page - split-screen layout.
 *
 * Left panel: branding and product copy.
 * Right panel: credential form.
 *
 * The owner now sees everything in one consolidated workspace, so there is no
 * role selector — login always opens a `"developer"` session and redirects to
 * the workspace at `/`.
 *
 * Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5
 */

import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Stack, Warning } from "@phosphor-icons/react";

import { isValidAccountId, isValidDelegateKey } from "@uberwal/shared";

import { login } from "../actions/auth";
import { Button, IconBadge } from "../../components/ui";

type LoginErrorKind = "invalid-credentials" | "connectivity";

export default function LoginPage() {
  const router = useRouter();

  const [delegateKey, setDelegateKey] = useState<string>("");
  const [accountId, setAccountId] = useState<string>("");
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<{ kind: LoginErrorKind; message: string } | null>(null);

  const delegateKeyEmpty = delegateKey.length === 0;
  const accountIdEmpty = accountId.length === 0;
  const delegateKeyFormatOk = isValidDelegateKey(delegateKey);
  const accountIdFormatOk = isValidAccountId(accountId);

  const delegateKeyError: string | null = delegateKeyEmpty
    ? "Delegate key is required."
    : delegateKeyFormatOk
      ? null
      : "Must be 64 hexadecimal characters.";

  const accountIdError: string | null = accountIdEmpty
    ? "Account ID is required."
    : accountIdFormatOk
      ? null
      : "Must be 0x followed by 64 hex characters.";

  const formInvalid = delegateKeyError !== null || accountIdError !== null;
  const submitDisabled = formInvalid || submitting;

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (formInvalid || submitting) return;
    setError(null);
    setSubmitting(true);
    try {
      const result = await login({ delegateKey, accountId, role: "developer" });
      if (result.ok) {
        router.push("/");
        return;
      }
      setError({ kind: result.kind, message: result.message });
    } catch {
      setError({
        kind: "connectivity",
        message: "Could not reach the server. Check your connection and try again.",
      });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex min-h-[100dvh]">
      {/* Left panel - editorial branding */}
      <div className="relative hidden w-[480px] flex-shrink-0 flex-col justify-between overflow-hidden bg-ink lg:flex">
        <div className="flex flex-col gap-8 px-12 pt-16">
          {/* Logo */}
          <div className="flex items-center gap-2.5">
            <IconBadge tone="neutral" className="h-8 w-8">
              <Stack size={18} weight="bold" aria-hidden="true" />
            </IconBadge>
            <span className="font-serif text-base font-semibold tracking-tight text-surface">Uberwal</span>
          </div>

          {/* Copy */}
          <div className="flex flex-col gap-4">
            <h1 className="font-serif text-4xl font-semibold leading-tight tracking-tight text-surface">
              Your memory,<br />indexed and searchable.
            </h1>
            <p className="max-w-[34ch] text-sm leading-relaxed text-border">
              Browse skills, productivity records, sessions, and generated reports stored in Walrus Memory.
            </p>
          </div>

          {/* Feature list */}
          <ul className="flex flex-col gap-3">
            {[
              { label: "Skills", desc: "Vector recall over your skill namespace", dot: "bg-pastel-blueText" },
              { label: "Productivity", desc: "Output and focus data across time", dot: "bg-pastel-greenText" },
              { label: "Sessions", desc: "Expandable coding session summaries", dot: "bg-pastel-yellowText" },
              { label: "Reports", desc: "Generated prose reports on demand", dot: "bg-pastel-redText" },
            ].map((item) => (
              <li key={item.label} className="flex items-start gap-3">
                <span className="mt-1.5 flex h-1.5 w-1.5 flex-shrink-0 items-center justify-center">
                  <span className={`h-1.5 w-1.5 rounded-full ${item.dot}`} />
                </span>
                <span className="text-sm text-border">
                  <span className="font-medium text-surface">{item.label}</span>
                  {" "}{item.desc}
                </span>
              </li>
            ))}
          </ul>
        </div>

        <div className="px-12 pb-10">
          <p className="font-mono text-xs text-muted">Walrus Memory Protocol</p>
        </div>
      </div>

      {/* Right panel - form */}
      <div className="flex flex-1 flex-col justify-center bg-canvas px-6 py-12 lg:px-16">
        {/* Mobile logo */}
        <div className="mb-10 flex items-center gap-2.5 lg:hidden">
          <span className="font-serif text-base font-semibold tracking-tight text-ink">Uberwal</span>
        </div>

        <div className="w-full max-w-sm">
          <div className="mb-8">
            <h2 className="font-serif text-2xl font-semibold tracking-tight text-ink">Sign in</h2>
            <p className="mt-1 text-sm text-muted">Enter the delegate credentials for this session.</p>
          </div>

          {/* Error banner */}
          {error !== null ? (
            <div
              role="alert"
              data-error-kind={error.kind}
              className={[
                "mb-6 flex items-start gap-2.5 rounded-md border px-4 py-3 text-sm",
                error.kind === "invalid-credentials"
                  ? "border-pastel-red bg-pastel-red text-pastel-redText"
                  : "border-pastel-yellow bg-pastel-yellow text-pastel-yellowText",
              ].join(" ")}
            >
              <Warning size={16} weight="bold" className="mt-0.5 flex-shrink-0" aria-hidden="true" />
              <span>
                <span className="font-medium">
                  {error.kind === "invalid-credentials" ? "Invalid credentials." : "Connection problem."}
                </span>{" "}
                {error.message}
              </span>
            </div>
          ) : null}

          <form onSubmit={(e) => { void handleSubmit(e); }} className="flex flex-col gap-5" noValidate>
            {/* Delegate key */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="delegateKey" className="text-sm font-medium text-ink">
                Delegate key
              </label>
              <input
                id="delegateKey"
                name="delegateKey"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={delegateKey}
                onChange={(e) => setDelegateKey(e.currentTarget.value)}
                aria-invalid={delegateKeyError !== null}
                aria-describedby={delegateKeyError !== null ? "delegateKey-error" : undefined}
                placeholder="64-character hex"
                className={[
                  "w-full rounded-md border bg-surface px-3 py-2.5 font-mono text-sm text-ink placeholder:text-muted",
                  "transition-colors duration-150",
                  "focus:outline-none focus:ring-1",
                  delegateKeyError !== null && !delegateKeyEmpty
                    ? "border-pastel-redText focus:border-pastel-redText focus:ring-pastel-redText/20"
                    : "border-border focus:border-ink focus:ring-ink/20",
                ].join(" ")}
              />
              {delegateKeyError !== null && !delegateKeyEmpty ? (
                <p id="delegateKey-error" className="text-xs text-pastel-redText">{delegateKeyError}</p>
              ) : null}
            </div>

            {/* Account ID */}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="accountId" className="text-sm font-medium text-ink">
                Account ID
              </label>
              <input
                id="accountId"
                name="accountId"
                type="text"
                autoComplete="off"
                spellCheck={false}
                value={accountId}
                onChange={(e) => setAccountId(e.currentTarget.value)}
                aria-invalid={accountIdError !== null}
                aria-describedby={accountIdError !== null ? "accountId-error" : undefined}
                placeholder="0x followed by 64 hex characters"
                className={[
                  "w-full rounded-md border bg-surface px-3 py-2.5 font-mono text-sm text-ink placeholder:text-muted",
                  "transition-colors duration-150",
                  "focus:outline-none focus:ring-1",
                  accountIdError !== null && !accountIdEmpty
                    ? "border-pastel-redText focus:border-pastel-redText focus:ring-pastel-redText/20"
                    : "border-border focus:border-ink focus:ring-ink/20",
                ].join(" ")}
              />
              {accountIdError !== null && !accountIdEmpty ? (
                <p id="accountId-error" className="text-xs text-pastel-redText">{accountIdError}</p>
              ) : null}
            </div>

            <Button
              type="submit"
              variant="primary"
              disabled={submitDisabled}
              className="mt-1 w-full"
            >
              {submitting ? "Signing in..." : "Sign in"}
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
