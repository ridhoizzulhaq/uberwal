"use client";

import { useState, type FormEvent } from "react";
import { MagnifyingGlass } from "@phosphor-icons/react";

import { Button } from "./ui";

export interface SearchBoxProps {
  onSubmit: (query: string) => void;
  defaultValue?: string;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}

export function SearchBox({
  onSubmit,
  defaultValue = "",
  placeholder = "Search…",
  disabled = false,
  ariaLabel = "Search",
}: SearchBoxProps) {
  const [query, setQuery] = useState<string>(defaultValue);

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    onSubmit(query);
  };

  return (
    <form
      role="search"
      onSubmit={handleSubmit}
      className="flex w-full items-center gap-2"
    >
      <div className="relative min-w-0 flex-1">
        <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted">
          <MagnifyingGlass size={16} weight="regular" aria-hidden="true" />
        </span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder={placeholder}
          disabled={disabled}
          aria-label={ariaLabel}
          className={[
            "w-full rounded-lg border border-border bg-surface py-2.5 pl-9 pr-3 text-sm text-ink",
            "placeholder:text-muted transition-colors duration-150",
            "focus:border-ink focus:outline-none focus:ring-1 focus:ring-ink/20",
            "disabled:cursor-not-allowed disabled:opacity-40",
          ].join(" ")}
        />
      </div>
      <Button type="submit" variant="primary" disabled={disabled} className="flex-shrink-0">
        Search
      </Button>
    </form>
  );
}

export default SearchBox;
