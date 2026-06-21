"use client";

/**
 * Reader Agent chat surface.
 *
 * Multi-turn conversation interface with preset selector.
 * Left-aligned messages, input pinned to bottom of the chat area.
 *
 * Generalized: the chat talks to an injectable `ask` function so the same
 * surface serves both the authenticated assistant (default `askReader`) and
 * the share-link recipient (a closure over `askReaderShared` with explicit
 * delegate credentials). Styling consumes the minimalist theme tokens +
 * Phosphor icons only.
 */

import { useState, useRef, useEffect } from "react";
import { ChatCircle, PaperPlaneTilt, Warning } from "@phosphor-icons/react";
import { askReader } from "../app/actions/reader";
import type { ReaderPreset, RunReaderResult } from "../server/reader-agent";
import { Button, IconBadge } from "./ui";
import { Markdown } from "./Markdown";

interface ChatTurn {
  role: "user" | "assistant";
  content: string;
  usedCount?: number;
}

const PRESET_OPTIONS: ReadonlyArray<{ value: ReaderPreset; label: string; description: string }> = [
  { value: "recruiting", label: "Recruiting", description: "Skills and fit assessment" },
  { value: "productivity", label: "Productivity", description: "Output and focus patterns" },
  { value: "neutral", label: "Neutral", description: "No persona, just the facts" },
];

/**
 * One Reader turn. Mirrors {@link askReader}'s input but stated structurally so
 * callers can pass a closure (e.g. one that forwards share credentials).
 */
export type AskReader = (input: {
  preset: ReaderPreset;
  messages: { role: "user" | "assistant"; content: string }[];
  sessionIds?: string[];
  repo?: string;
}) => Promise<RunReaderResult>;

export interface ReaderChatProps {
  initialPreset?: ReaderPreset;
  /**
   * Runs a single reasoning turn. Defaults to the authenticated `askReader`
   * server action so existing callers are unchanged; the recipient view passes
   * a closure that calls `askReaderShared` with its delegate credentials.
   */
  ask?: AskReader;
  /**
   * When provided, scopes the assistant to these sessions — it reads only the
   * selected session(s)' context. Omitted by the share-link recipient, whose
   * scope is already fixed by the share manifest.
   */
  sessionIds?: string[];
  /**
   * Optional project/repository filter forwarded to the reasoning turn. Scopes
   * the assistant to one project (combined with `sessionIds` when both given).
   */
  repo?: string;
  /**
   * Whether to show the persona selector. Defaults to `true`. The owner's
   * session-scoped assistant hides it (the scoped reader is neutral and does
   * not role-play a persona); the recipient/share view keeps it.
   */
  showPersona?: boolean;
}

export function ReaderChat({
  initialPreset = "recruiting",
  ask = askReader,
  sessionIds,
  repo,
  showPersona = true,
}: ReaderChatProps) {
  const [preset, setPreset] = useState<ReaderPreset>(initialPreset);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [input, setInput] = useState<string>("");
  const [loading, setLoading] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView?.({ behavior: "smooth" });
  }, [turns, loading]);

  const handleSubmit = async (): Promise<void> => {
    const query = input.trim();
    if (query.length === 0 || loading) return;

    const userTurn: ChatTurn = { role: "user", content: query };
    const nextTurns = [...turns, userTurn];
    setTurns(nextTurns);
    setInput("");
    setError(null);
    setLoading(true);

    const result = await ask({
      preset,
      messages: nextTurns.map((turn) => ({
        role: turn.role,
        content: turn.content,
      })),
      ...(sessionIds !== undefined && sessionIds.length > 0 ? { sessionIds } : {}),
      ...(repo !== undefined && repo.length > 0 ? { repo } : {}),
    });

    setLoading(false);

    if (result.ok) {
      setTurns((current) => [
        ...current,
        {
          role: "assistant",
          content: result.reply,
          usedCount: result.usedMemories.length,
        },
      ]);
    } else {
      setError(result.message);
    }
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void handleSubmit();
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Preset selector */}
      {showPersona ? (
        <div className="flex items-center gap-3">
          <span className="text-xs font-medium text-muted">Persona</span>
          <div className="flex items-center gap-2">
            {PRESET_OPTIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                disabled={loading}
                onClick={() => setPreset(option.value)}
                aria-pressed={preset === option.value}
                className={[
                  "flex items-center gap-2 rounded-md border px-3 py-1.5 text-xs font-medium transition-colors duration-150",
                  "disabled:cursor-not-allowed disabled:opacity-50",
                  preset === option.value
                    ? "border-ink bg-canvas text-ink"
                    : "border-border text-muted hover:border-ink/40 hover:text-ink",
                ].join(" ")}
              >
                <span>{option.label}</span>
                <span className="hidden text-[10px] text-muted sm:inline">{option.description}</span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      {/* Chat window */}
      <div
        className="flex min-h-[320px] flex-col rounded-lg border border-border bg-surface"
        aria-label="Conversation"
      >
        <div className="flex-1 overflow-y-auto p-4">
          {turns.length === 0 ? (
            <div className="flex h-full min-h-[200px] flex-col items-start justify-center gap-2 px-2">
              <IconBadge tone="neutral" className="h-8 w-8">
                <ChatCircle size={16} weight="regular" aria-hidden="true" />
              </IconBadge>
              <p className="text-sm text-muted">
                Ask the reader agent about recalled memories. It searches across namespaces and reasons over the results.
              </p>
              <p className="text-xs text-muted">Press Enter to send, Shift+Enter for a new line.</p>
            </div>
          ) : (
            <ul className="flex flex-col gap-4" aria-label="Conversation">
              {turns.map((turn, index) => (
                <li
                  key={`${turn.role}-${index}`}
                  data-role={turn.role}
                  className="flex flex-col gap-1"
                >
                  {/* Role label */}
                  <span className={[
                    "text-[10px] font-semibold uppercase tracking-widest",
                    turn.role === "user" ? "text-muted" : "text-pastel-greenText",
                  ].join(" ")}>
                    {turn.role === "user" ? "You" : "Reader"}
                  </span>

                  {/* Message bubble */}
                  <div
                    className={[
                      "rounded-md px-3.5 py-2.5 text-sm leading-relaxed",
                      turn.role === "user"
                        ? "max-w-[85%] self-end bg-canvas text-ink"
                        : "self-start bg-surface text-ink ring-1 ring-border",
                    ].join(" ")}
                  >
                    {turn.role === "assistant" ? (
                      <Markdown>{turn.content}</Markdown>
                    ) : (
                      <p className="whitespace-pre-wrap">{turn.content}</p>
                    )}
                    {turn.role === "assistant" && turn.usedCount !== undefined ? (
                      <p className="mt-2 text-[10px] text-muted">
                        based on {turn.usedCount} {turn.usedCount === 1 ? "memory" : "memories"}
                      </p>
                    ) : null}
                  </div>
                </li>
              ))}

              {/* Loading indicator */}
              {loading ? (
                <li className="flex flex-col gap-1">
                  <span className="text-[10px] font-semibold uppercase tracking-widest text-pastel-greenText">Reader</span>
                  <div className="flex items-center gap-1.5 self-start rounded-md bg-surface px-3.5 py-3 ring-1 ring-border">
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: "0ms" }} />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: "150ms" }} />
                    <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-muted" style={{ animationDelay: "300ms" }} />
                  </div>
                </li>
              ) : null}
            </ul>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* Error banner */}
      {error !== null ? (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-md border border-pastel-red bg-pastel-red px-4 py-3"
        >
          <Warning size={16} weight="bold" className="mt-0.5 flex-shrink-0 text-pastel-redText" aria-hidden="true" />
          <div className="text-sm">
            <span className="font-medium text-pastel-redText">The reader agent failed.</span>{" "}
            <span className="text-pastel-redText">{error}</span>
          </div>
        </div>
      ) : null}

      {/* Input area */}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void handleSubmit();
        }}
        className="flex items-end gap-2"
      >
        <div className="relative min-w-0 flex-1">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(event) => setInput(event.currentTarget.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about skills, output, or fit..."
            aria-label="Message"
            rows={2}
            disabled={loading}
            className={[
              "w-full resize-none rounded-md border border-border bg-surface px-3.5 py-2.5",
              "text-sm text-ink placeholder:text-muted",
              "transition-colors duration-150",
              "focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink/20",
              "disabled:cursor-not-allowed disabled:opacity-40",
            ].join(" ")}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          disabled={loading || input.trim().length === 0}
          className="h-[52px] w-12 flex-shrink-0"
          aria-label="Send message"
        >
          <PaperPlaneTilt size={16} weight="bold" aria-hidden="true" />
        </Button>
      </form>
    </div>
  );
}

export default ReaderChat;
