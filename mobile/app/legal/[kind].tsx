import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import { getLegalDocument, type LegalKind } from '@/api/legal';
import { messageFor } from '@/lib/errors';
import { Body, Caption, ErrorState, LoadingState, Screen } from '@/components/ui';
import { colors, spacing, typography } from '@/theme';

/**
 * A published legal document.
 *
 * Rendered from the database rather than bundled into the app, because the text
 * people agreed to has to be the text that was live when they agreed — and a
 * new version must be publishable without shipping a build. A tiny Markdown
 * subset is enough: these documents are headings, paragraphs, lists and tables
 * of two columns, and pulling in a parser for that would cost more than it
 * returns.
 */
const KINDS: Record<string, LegalKind> = {
  terms: 'terms',
  privacy: 'privacy',
  agreement: 'organizer_agreement',
};

export default function LegalScreen() {
  const { kind } = useLocalSearchParams<{ kind: string }>();
  const documentKind = KINDS[kind ?? ''] ?? 'terms';

  const document = useQuery({
    queryKey: ['legal', documentKind],
    queryFn: () => getLegalDocument(documentKind),
  });

  if (document.isLoading) return <Screen><LoadingState /></Screen>;
  if (document.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(document.error)} onRetry={() => void document.refetch()} />
      </Screen>
    );
  }

  if (!document.data) {
    return (
      <Screen>
        <Body muted>Tento dokument zatiaľ nebol zverejnený.</Body>
      </Screen>
    );
  }

  return (
    <Screen scroll>
      <Text style={styles.title}>{document.data.title}</Text>
      <Caption style={styles.version}>
        Verzia {document.data.version} · účinné od{' '}
        {new Date(document.data.published_at!).toLocaleDateString('sk-SK')}
      </Caption>

      {renderMarkdown(document.data.body)}
    </Screen>
  );
}

/** Headings, paragraphs, bullets and two-column tables. Nothing else is used. */
function renderMarkdown(source: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const lines = source.split('\n');
  let paragraph: string[] = [];

  const flush = () => {
    if (paragraph.length === 0) return;
    out.push(
      <Body key={`p${out.length}`} style={styles.paragraph}>
        {inline(paragraph.join(' '))}
      </Body>,
    );
    paragraph = [];
  };

  for (const raw of lines) {
    const line = raw.trimEnd();

    if (line.trim() === '') { flush(); continue; }

    if (line.startsWith('# ')) { flush(); continue; }   // the title is shown above

    if (line.startsWith('## ')) {
      flush();
      out.push(<Text key={`h${out.length}`} style={styles.h2}>{line.slice(3)}</Text>);
      continue;
    }

    // A table row. The separator row is skipped; the header keeps its weight.
    if (line.startsWith('|')) {
      flush();
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^-+$/.test(c.replace(/\s/g, '')))) continue;
      out.push(
        <View key={`t${out.length}`} style={styles.tableRow}>
          {cells.map((cell, i) => (
            <Text key={i} style={[styles.cell, i === 0 && styles.cellFirst]}>{inline(cell)}</Text>
          ))}
        </View>,
      );
      continue;
    }

    if (/^[a-z]\)\s/.test(line.trim()) || line.startsWith('- ') || line.startsWith('> ')) {
      flush();
      out.push(
        <Body key={`l${out.length}`} style={styles.bullet}>
          {inline(line.replace(/^[->]\s/, '• ').trim())}
        </Body>,
      );
      continue;
    }

    paragraph.push(line.trim());
  }

  flush();
  return out;
}

/** **bold** only — the documents use nothing else inline that matters. */
function inline(text: string): React.ReactNode {
  const parts = text.split(/(\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, i) =>
    part.startsWith('**') && part.endsWith('**')
      ? <Text key={i} style={styles.strong}>{part.slice(2, -2)}</Text>
      : <Text key={i}>{part}</Text>,
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text },
  version: { marginTop: spacing.xs, marginBottom: spacing.lg },
  h2: { ...typography.bodyStrong, color: colors.text, fontSize: 17, marginTop: spacing.lg, marginBottom: spacing.sm },
  paragraph: { color: colors.textSecondary, marginBottom: spacing.md, lineHeight: 22 },
  bullet: { color: colors.textSecondary, marginBottom: spacing.sm, paddingLeft: spacing.md, lineHeight: 22 },
  strong: { color: colors.text, fontWeight: '700' },
  tableRow: {
    flexDirection: 'row',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  cell: { flex: 1, minWidth: 0, color: colors.textSecondary, fontSize: 14, lineHeight: 20 },
  cellFirst: { color: colors.text },
});
