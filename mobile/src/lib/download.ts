import { File, Paths } from 'expo-file-system';
import * as Sharing from 'expo-sharing';

/**
 * Handing the file to the phone.
 *
 * Written into the cache directory and then offered to the share sheet. When
 * sharing is unavailable — some Android configurations — the file still exists,
 * so the caller can say where it is instead of pretending the export failed.
 */
export async function saveTextFile(
  name: string,
  text: string,
  mimeType = 'text/csv',
): Promise<{ shared: boolean; uri: string }> {
  const file = new File(Paths.cache, name);
  if (file.exists) file.delete();
  file.create();
  file.write(text);

  if (!(await Sharing.isAvailableAsync())) {
    return { shared: false, uri: file.uri };
  }

  await Sharing.shareAsync(file.uri, {
    mimeType,
    UTI: 'public.comma-separated-values-text',
    dialogTitle: 'Export z BLUPu',
  });

  return { shared: true, uri: file.uri };
}
