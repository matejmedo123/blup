/**
 * A query that still works when part of the schema is not there yet.
 *
 * PostgREST resolves an embed (`reply_to:messages!messages_reply_to_id_fkey`)
 * against a cached picture of the schema. Two ordinary situations make that
 * cache disagree with the client:
 *
 *   · a migration adding the column has not been pushed to this project yet —
 *     the app is newer than the database, which is exactly what happens between
 *     deploying the web build and running `db push`
 *   · it has been pushed, and PostgREST has not reloaded yet
 *
 * In both cases the whole query fails, and a screen that asked for one optional
 * extra shows nothing at all. Chat died this way: the quoted message could not
 * be resolved, so no messages loaded — reported as "Could not find a
 * relationship between 'messages' and 'messages' in the schema cache".
 *
 * So the optional part is optional. The query runs with it; if the only problem
 * was that relationship, it runs again without. What is lost is the extra —
 * the quote above a reply, the seat printed on a ticket — and not the screen.
 */
export interface PostgrestLikeError {
  code?: string;
  message?: string;
}

/**
 * True when the query failed *because* an embed could not be resolved.
 *
 * PGRST200 is PostgREST's code for exactly that. The message check is a
 * fallback for versions that report it differently; anything else — a real
 * error, a permission problem, a dropped connection — is not swallowed.
 */
export function isMissingRelationship(error: unknown): boolean {
  const e = error as PostgrestLikeError | null;
  if (!e) return false;
  if (e.code === 'PGRST200') return true;
  return typeof e.message === 'string'
    && /could not find a relationship|schema cache/i.test(e.message);
}

/**
 * Runs `withExtra`, and falls back to `without` when the only thing wrong was
 * the embed. Any other error is thrown, because a query that failed for a real
 * reason must not quietly return a worse answer.
 */
export async function withOptionalEmbed<T>(
  withExtra: () => PromiseLike<{ data: T | null; error: unknown }>,
  without: () => PromiseLike<{ data: T | null; error: unknown }>,
): Promise<T | null> {
  const first = await withExtra();
  if (!first.error) return first.data;
  if (!isMissingRelationship(first.error)) throw first.error;

  const second = await without();
  if (second.error) throw second.error;
  return second.data;
}
