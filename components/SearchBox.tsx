"use client";

import { useState, type FormEvent } from "react";

interface Props {
  onSearch: (q: string) => Promise<string | null>;
  disabled: boolean;
}

/** Postcode search. Looked up on the device from the bundled postcode files. */
export default function SearchBox({ onSearch, disabled }: Props) {
  const [q, setQ] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setMsg(null);
    try {
      const err = await onSearch(q);
      setMsg(err);
      if (!err) (document.activeElement as HTMLElement | null)?.blur(); // drop the phone keyboard
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="search" role="search" onSubmit={submit}>
      <input
        type="search"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Postcode, e.g. M14 5AB"
        aria-label="Search for a postcode or district"
        autoCapitalize="characters"
        autoComplete="postal-code"
        autoCorrect="off"
        spellCheck={false}
        enterKeyHint="search"
        maxLength={10}
      />
      <button type="submit" disabled={disabled || busy}>
        {busy ? "…" : "Go"}
      </button>
      {msg && (
        <p className="search-msg" role="status">
          {msg}
        </p>
      )}
    </form>
  );
}
