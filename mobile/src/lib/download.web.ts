/**
 * Handing the visitor a file.
 *
 * A Blob and a synthetic click: no server round trip, and the bytes never leave
 * the browser. The text is already assembled by the caller, from rows the
 * database decided it was allowed to see.
 */
export async function saveTextFile(
  name: string,
  text: string,
  mimeType = 'text/csv;charset=utf-8',
): Promise<{ shared: boolean; uri: string }> {
  const blob = new Blob([text], { type: mimeType });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  document.body.appendChild(link);
  link.click();
  link.remove();

  // Revoking immediately can cancel the download in Safari; a tick is enough.
  setTimeout(() => URL.revokeObjectURL(url), 1000);

  return { shared: true, uri: name };
}
