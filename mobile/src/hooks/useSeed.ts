import { useState } from 'react';

/**
 * Seeds editable local state from data that arrives later.
 *
 * The obvious way to do this is an effect:
 *
 *     useEffect(() => { if (query.data) setForm(query.data); }, [query.data]);
 *
 * which works, and renders the screen twice every time the data changes: once
 * with the old state, then again after the effect commits. React's own guidance
 * is to adjust state during render instead — the re-render happens before
 * anything is painted, so nothing flashes and no extra commit is scheduled.
 * (https://react.dev/reference/react/useState#storing-information-from-previous-renders)
 *
 * Usage:
 *
 *     useSeed(query.data, (data) => {
 *       setName(data.name);
 *       setEmail(data.email);
 *     });
 *
 * `apply` runs when `source` changes identity — once per load, and again if the
 * query refetches into a different object. It must only call setState on the
 * component that owns it; that is the one thing React allows during render.
 */
export function useSeed<T>(source: T | null | undefined, apply: (value: T) => void): void {
  const [seen, setSeen] = useState<T | null | undefined>(null);

  if (source != null && source !== seen) {
    setSeen(source);
    apply(source);
  }
}
