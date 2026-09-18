import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';

import { getDeploymentStatus } from '@/api/deployment';
import { messageFor } from '@/lib/errors';
import {
  Badge, Body, Caption, ErrorState, LoadingState, Mono, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Je databáza rovnako stará ako appka?
 *
 * Four bug reports in a row were the same thing wearing different clothes: the
 * web build had been uploaded and the migrations had not. Chat died on a
 * missing column, Blup Connect showed nobody, the waitlist and the invites were
 * simply absent. Each looked like its own broken feature and each was one
 * un-run migration — and nothing anywhere said so, because a missing function
 * comes back as an English sentence about a schema cache that a screen either
 * swallows or prints raw.
 *
 * This page answers the question directly, feature by feature, and names the
 * migration to run. It is the first thing to open when something "does not
 * work" after a deploy.
 */
export default function DeploymentScreen() {
  const status = useQuery({ queryKey: ['admin', 'deployment'], queryFn: getDeploymentStatus });

  if (status.isLoading) return <Screen><LoadingState label="Kontrolujem databázu…" /></Screen>;
  if (status.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(status.error)} onRetry={() => void status.refetch()} />
      </Screen>
    );
  }

  const data = status.data!;
  const behind = data.features.filter((f) => !f.ok);

  return (
    <Screen scroll>
      <Text style={styles.title}>Stav nasadenia</Text>
      <Body muted style={styles.intro}>
        Web a databáza sa nasadzujú zvlášť, takže sa môžu rozísť. Keď niečo „nefunguje“
        hneď po nahratí, začni tu.
      </Body>

      {data.checkMissing ? (
        <Notice
          tone="danger"
          title="Databáza je výrazne staršia než táto verzia"
          body={'Chýba aj samotná kontrola. Spusti `npx supabase db push` — aplikuje sa '
            + 'všetko, čo tam ešte nie je, a existujúce dáta sa nemažú.'}
        />
      ) : data.ready ? (
        <Notice
          tone="success"
          title="Databáza sedí s appkou"
          body="Všetko, čo táto verzia potrebuje, v projekte je."
        />
      ) : (
        <Notice
          tone="danger"
          title={`${behind.length} ${behind.length === 1 ? 'funkcia nebude fungovať' : behind.length < 5 ? 'funkcie nebudú fungovať' : 'funkcií nebude fungovať'}`}
          body={'Web je novší ako databáza. Spusti `npx supabase db push` a potom '
            + '`./scripts/deploy-functions.sh` — nič sa nemaže, len sa dopĺňa.'}
        />
      )}

      <SectionHeader title="Po funkciách" />

      {data.features.map((feature) => (
        <View key={feature.key} style={styles.row}>
          <View style={styles.head}>
            <View style={styles.flex}>
              <Text style={styles.name}>{feature.label}</Text>
              <Mono style={styles.migration}>{feature.migration}</Mono>
            </View>
            <Badge
              label={feature.ok ? 'JE TAM' : 'CHÝBA'}
              tone={feature.ok ? 'success' : 'danger'}
            />
          </View>

          {!feature.ok && !data.checkMissing ? (
            <Caption style={styles.missing}>
              Chýba: {feature.missing.join(', ')}
            </Caption>
          ) : null}
        </View>
      ))}

      <SectionHeader title="Čo spustiť" />
      <View style={styles.code}>
        <Mono>npx supabase db push</Mono>
        <Mono>./scripts/deploy-functions.sh</Mono>
      </View>
      <Caption>
        Prvý príkaz dopĺňa schému — existujúce tabuľky ani dáta sa nemažú, `db push` sám
        vypíše, ktoré migrácie aplikuje, a čo už v databáze je, preskočí. Druhý nasadí
        serverové funkcie; bez neho neodíde žiadny e-mail.
      </Caption>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text },
  intro: { marginTop: spacing.xs, marginBottom: spacing.lg },
  flex: { flex: 1, minWidth: 0 },

  row: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
    gap: spacing.xs,
  },
  head: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  name: { ...typography.bodyStrong, color: colors.text },
  migration: { ...typography.caption, color: colors.textSecondary },
  missing: { color: colors.warning },

  code: {
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceElevated,
    marginBottom: spacing.sm,
    gap: 4,
  },
});
