import React, { useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { listUsers, setUserPremium, suspendUser } from '@/api/admin';
import { messageFor } from '@/lib/errors';
import { BottomSheet } from '@/components/BottomSheet';
import { useDialog } from '@/components/Dialog';
import { useToast } from '@/components/Toast';
import { formatEventDate } from '@/lib/format';
import type { Profile } from '@/types/models';
import {
  Avatar, Badge, Body, Button, Caption, EmptyState, Input, LoadingState, Notice, Screen,
} from '@/components/ui';
import { colors, spacing, typography } from '@/theme';

export default function AdminUsersScreen() {
  const queryClient = useQueryClient();
  const dialog = useDialog();
  const toast = useToast();
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  /** Whose Premium is being changed. */
  const [premiumFor, setPremiumFor] = useState<Profile | null>(null);

  const users = useQuery({
    queryKey: ['admin', 'users', search],
    queryFn: () => listUsers(search),
  });

  const toggleSuspend = async (id: string, suspended: boolean) => {
    setError(null);
    setBusy(id);
    try {
      await suspendUser(id, !suspended, suspended ? undefined : 'Pozastavené adminom');
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  /**
   * Granting Premium by hand. The days are fixed choices rather than a free
   * number: a compensation, a trial, a season — and nothing here writes a
   * subscription row, so the accounting never sees money that did not arrive.
   */
  const grant = async (user: Profile, days: number) => {
    setError(null);
    setPremiumFor(null);
    setBusy(user.id);
    try {
      await setUserPremium(user.id, days);
      toast.show(days === 0 ? 'Premium odobraté' : `Premium na ${days} dní`);
      await queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (user: Profile) => {
    const sure = await dialog.confirm({
      title: 'Odobrať Premium?',
      body: 'Ak si toto predplatné niekto platí, o nič nepríde — odoberie sa len to, čo mu dal admin.',
      confirmLabel: 'Odobrať',
      destructive: true,
    });
    if (sure) await grant(user, 0);
  };

  return (
    <Screen contentStyle={styles.container}>
      <View style={styles.header}>
        <Input
          value={search}
          onChangeText={setSearch}
          placeholder="Hľadaj podľa mena, používateľského mena alebo e-mailu"
          autoCapitalize="none"
          style={styles.search}
        />
        {error ? <Notice tone="danger" title="Nepodarilo sa upraviť" body={error} /> : null}
      </View>

      {users.isLoading ? (
        <LoadingState />
      ) : (
        <FlatList
          data={users.data ?? []}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          renderItem={({ item }) => (
            <View style={styles.row}>
              <Avatar url={item.avatar_url} name={item.display_name} size={40} />
              <View style={styles.flex}>
                <Text style={styles.name}>{item.display_name ?? item.username}</Text>
                <Caption>@{item.username} · {item.email ?? 'no email'}</Caption>
                <View style={styles.badges}>
                  {item.app_role !== 'user' ? <Badge tone="accent" label={item.app_role} /> : null}
                  {/* Who has Premium, and why — an admin has it from the role
                      and cannot lose it by having a grant taken away, so the
                      two say different things. */}
                  {item.app_role === 'admin' ? (
                    <Badge tone="neutral" label="PREMIUM (ADMIN)" />
                  ) : premiumState(item) ? (
                    <Badge tone="accent" label={premiumState(item) as string} />
                  ) : null}
                </View>
              </View>
              <View style={styles.actions}>
                {item.app_role !== 'admin' ? (
                  <Button
                    title="Premium"
                    variant="secondary"
                    compact
                    loading={busy === item.id}
                    onPress={() => setPremiumFor(item)}
                  />
                ) : null}
                <Button
                  title={item.is_suspended ? 'Obnoviť' : 'Pozastaviť'}
                  variant={item.is_suspended ? 'secondary' : 'danger'}
                  compact
                  loading={busy === item.id}
                  onPress={() => toggleSuspend(item.id, item.is_suspended)}
                />
              </View>
            </View>
          )}
          ListEmptyComponent={<EmptyState emoji="👤" title="Nikto sa nezhoduje" />}
        />
      )}

      <BottomSheet
        visible={Boolean(premiumFor)}
        onClose={() => setPremiumFor(null)}
        title="Premium"
        subtitle={premiumFor?.display_name ?? premiumFor?.username ?? undefined}
      >
        <Body muted style={styles.sheetIntro}>
          {premiumState(premiumFor)
            ? `Teraz má Premium do ${formatEventDate(premiumFor!.premium_until!)}. Dni sa pripočítajú k tomu, čo mu zostáva.`
            : 'Premium sa pridelí odteraz. Nie je to predplatné — v účtovníctve sa neobjaví ako tržba a nič sa mu nestrhne.'}
        </Body>

        {[7, 30, 90, 365].map((days) => (
          <Button
            key={days}
            title={`+ ${days} dní`}
            variant="secondary"
            onPress={() => void grant(premiumFor!, days)}
            style={styles.sheetButton}
          />
        ))}

        {premiumState(premiumFor) ? (
          <Button
            title="Odobrať Premium"
            variant="danger"
            onPress={() => void revoke(premiumFor!)}
            style={styles.sheetButton}
          />
        ) : null}
      </BottomSheet>
    </Screen>
  );
}

/** The label for somebody's granted Premium, or null when they have none. */
function premiumState(user: Profile | null): string | null {
  if (!user?.premium_until) return null;
  return new Date(user.premium_until) > new Date()
    ? `PREMIUM DO ${formatEventDate(user.premium_until)}`
    : null;
}

const styles = StyleSheet.create({
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  container: { paddingTop: spacing.md },
  header: { paddingHorizontal: spacing.lg },
  search: { marginBottom: spacing.md },
  list: { padding: spacing.lg, gap: spacing.md, flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  name: { ...typography.bodyStrong, color: colors.text },
  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, marginTop: 4 },
  actions: { gap: 6, alignItems: 'flex-end' },
  sheetIntro: { marginBottom: spacing.md },
  sheetButton: { marginBottom: spacing.xs },
});
