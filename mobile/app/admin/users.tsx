import React, { useState } from 'react';
import { FlatList, StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { listUsers, suspendUser } from '@/api/admin';
import { messageFor } from '@/lib/errors';
import {
  Avatar, Badge, Button, Caption, EmptyState, Input, LoadingState, Notice, Screen,
} from '@/components/ui';
import { colors, spacing, typography } from '@/theme';

export default function AdminUsersScreen() {
  const queryClient = useQueryClient();
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

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
                {item.app_role !== 'user' ? <Badge tone="accent" label={item.app_role} /> : null}
              </View>
              <Button
                title={item.is_suspended ? 'Obnoviť' : 'Pozastaviť'}
                variant={item.is_suspended ? 'secondary' : 'danger'}
                compact
                loading={busy === item.id}
                onPress={() => toggleSuspend(item.id, item.is_suspended)}
              />
            </View>
          )}
          ListEmptyComponent={<EmptyState emoji="👤" title="Nikto sa nezhoduje" />}
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  flex: { flex: 1 },
  container: { paddingTop: spacing.md },
  header: { paddingHorizontal: spacing.lg },
  search: { marginBottom: spacing.md },
  list: { padding: spacing.lg, gap: spacing.md, flexGrow: 1 },
  row: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  name: { ...typography.bodyStrong, color: colors.text },
});
