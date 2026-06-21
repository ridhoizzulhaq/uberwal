"use client";

/**
 * LinkEmailCard — link the logged-in owner's email to their account id.
 *
 * Lets others address a share to this email (resolved to the account id at
 * share-create time). The mapping is self-asserted (no email-ownership
 * verification), so it is a convenience directory only. The account id is
 * always taken from the session server-side; this card only submits the email.
 */

import { useEffect, useState } from "react";
import { EnvelopeSimple, CircleNotch, Check, Warning } from "@phosphor-icons/react";

import { getMyEmail, registerEmail } from "../app/actions/directory";
import { Button, Card } from "./ui";

type State =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "saving" }
  | { kind: "saved" }
  | { kind: "error"; message: string };

/** Shorten an account id for compact display. */
function shortId(id: string): string {
  return id.length <= 12 ? id : `${id.slice(0, 6)}…${id.slice(-4)}`;
}

export function LinkEmailCard() {
  const [email, setEmail] = useState<string>("");
  const [accountId, setAccountId] = useState<string | null>(null);
  const [linkedEmail, setLinkedEmail] = useState<string | null>(null);
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    void (async () => {
      const res = await getMyEmail();
      if (!active) return;
      if (res.ok) {
        setAccountId(res.accountId);
        setLinkedEmail(res.email);
        if (res.email) setEmail(res.email);
        setState({ kind: "ready" });
      } else {
        setState({ kind: "error", message: res.message });
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const handleSave = async () => {
    setState({ kind: "saving" });
    try {
      const res = await registerEmail({ email });
      if (res.ok) {
        setLinkedEmail(res.email);
        setAccountId(res.accountId);
        setState({ kind: "saved" });
      } else {
        setState({ kind: "error", message: res.message });
      }
    } catch {
      setState({ kind: "error", message: "Could not save. Try again." });
    }
  };

  return (
    <Card className="flex flex-col gap-3 p-5">
      <div className="flex items-center gap-2.5">
        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-canvas text-ink">
          <EnvelopeSimple size={15} weight="bold" aria-hidden="true" />
        </span>
        <div>
          <h2 className="font-serif text-base font-semibold tracking-tight text-ink">
            Link email
          </h2>
          <p className="text-xs text-muted">
            So others can share to you by email
            {accountId !== null ? (
              <>
                {" "}
                — your account <span className="font-mono text-ink">{shortId(accountId)}</span>
              </>
            ) : null}
          </p>
        </div>
      </div>

      {linkedEmail !== null && state.kind !== "saved" ? (
        <p className="text-[11px] text-muted">
          Currently linked: <span className="font-medium text-ink">{linkedEmail}</span>
        </p>
      ) : null}

      <div className="flex items-stretch gap-2">
        <input
          type="email"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (state.kind === "saved" || state.kind === "error") setState({ kind: "ready" });
          }}
          placeholder="name@example.com"
          spellCheck={false}
          autoCapitalize="none"
          disabled={state.kind === "loading" || state.kind === "saving"}
          className="min-w-0 flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink placeholder:text-muted focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink/20 disabled:opacity-50"
        />
        <Button
          type="button"
          variant="primary"
          onClick={() => void handleSave()}
          disabled={state.kind === "loading" || state.kind === "saving" || email.trim().length === 0}
        >
          {state.kind === "saving" ? (
            <>
              <CircleNotch size={14} weight="bold" className="animate-spin" aria-hidden="true" />
              Saving…
            </>
          ) : (
            "Link"
          )}
        </Button>
      </div>

      {state.kind === "saved" ? (
        <p className="flex items-center gap-1.5 text-[11px] text-pastel-greenText">
          <Check size={12} weight="bold" aria-hidden="true" />
          Linked. Others can now share to {linkedEmail}.
        </p>
      ) : null}
      {state.kind === "error" ? (
        <p className="flex items-center gap-1.5 text-[11px] text-pastel-redText">
          <Warning size={12} weight="bold" aria-hidden="true" />
          {state.message}
        </p>
      ) : null}

      <p className="text-[11px] leading-relaxed text-muted">
        Self-asserted — there&apos;s no email verification, so treat this as a
        convenience directory, not proof of ownership.
      </p>
    </Card>
  );
}

export default LinkEmailCard;
