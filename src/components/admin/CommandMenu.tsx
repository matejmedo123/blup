"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { globalSearch, type SearchHit } from "@/app/actions/search";
import { Spinner } from "@/components/ui/Button";
import { cn } from "@/lib/cn";

/** ⌘K vyhľadávanie s debounce (§21). Montuje sa až pri otvorení. */
export function CommandMenu({ onClose }: { onClose: () => void }) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  // Výsledky si nesú dopyt, ku ktorému patria — zastarané sa tak zahodia
  // pri renderi a netreba ich mazať efektom.
  const [results, setResults] = useState<{ query: string; hits: SearchHit[] } | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [pending, startTransition] = useTransition();

  const trimmed = query.trim();
  const tooShort = trimmed.length < 2;
  const data = !tooShort && results?.query === trimmed ? results.hits : null;

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const term = query.trim();
    if (term.length < 2) return;
    const timer = setTimeout(() => {
      startTransition(async () => {
        setResults({ query: term, hits: await globalSearch(term) });
        setHighlight(0);
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [query]);

  const groups = useMemo(() => {
    const map = new Map<string, SearchHit[]>();
    for (const hit of data ?? []) {
      const list = map.get(hit.group) ?? [];
      list.push(hit);
      map.set(hit.group, list);
    }
    return [...map.entries()];
  }, [data]);

  const flat = useMemo(() => groups.flatMap(([, hits]) => hits), [groups]);

  function go(hit: SearchHit) {
    onClose();
    router.push(hit.href);
  }

  return (
    <div className="fixed inset-0 z-40 flex items-start justify-center pt-[10vh] sm:pt-[14vh]">
      <button
        type="button"
        onClick={onClose}
        aria-label="Zavrieť vyhľadávanie"
        className="absolute inset-0 cursor-pointer bg-ink/32"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Vyhľadávanie"
        className="relative mx-4 w-full max-w-[620px] overflow-hidden rounded-[18px] border border-line bg-surface animate-(--animate-crew-in)"
      >
        <input
          ref={inputRef}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setHighlight((h) => Math.min(flat.length - 1, h + 1));
            }
            if (e.key === "ArrowUp") {
              e.preventDefault();
              setHighlight((h) => Math.max(0, h - 1));
            }
            if (e.key === "Enter" && flat[highlight]) {
              e.preventDefault();
              go(flat[highlight]);
            }
          }}
          placeholder="Hľadať crew, smeny, prihlášky…"
          aria-label="Hľadať"
          className="w-full border-b border-line px-[22px] py-5 text-[17px] text-ink placeholder:text-faint focus:outline-none"
        />

        <div className="max-h-[50vh] overflow-y-auto py-3">
          {tooShort ? (
            <p className="px-[22px] py-3 text-[15px] text-faint">
              Napíš aspoň dva znaky — meno, e-mail, mesto alebo názov smeny.
            </p>
          ) : data === null || pending ? (
            <div className="flex items-center gap-2.5 px-[22px] py-3 text-[15px] text-muted">
              <Spinner /> Hľadám…
            </div>
          ) : flat.length === 0 ? (
            <p className="px-[22px] py-3 text-[15px] text-faint">
              Pre „{query}“ sme nič nenašli. Skús iné meno alebo e-mail.
            </p>
          ) : (
            groups.map(([group, hits]) => (
              <div key={group}>
                <p className="px-[22px] pt-2.5 pb-1.5 text-[11px] font-semibold tracking-[0.12em] text-faint uppercase">
                  {group}
                </p>
                {hits.map((hit) => {
                  const index = flat.indexOf(hit);
                  return (
                    <button
                      key={`${hit.group}-${hit.id}`}
                      type="button"
                      onMouseEnter={() => setHighlight(index)}
                      onClick={() => go(hit)}
                      className={cn(
                        "block w-full cursor-pointer px-[22px] py-3 text-left text-[15px]",
                        index === highlight ? "bg-bg" : "bg-transparent",
                      )}
                    >
                      <span className="font-medium">{hit.title}</span>
                      {hit.subtitle ? (
                        <span className="text-muted"> · {hit.subtitle}</span>
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
