import React, { useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getConversations } from '@/api/messages';
import { ChatThread } from '../chat/[id]';
import { useLayout } from '@/hooks/useLayout';
import { SignInInvite } from '@/components/SignInInvite';
import { useAuth } from '@/auth/AuthProvider';
import { supabase } from '@/lib/supabase';
import { messageFor } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import {
  Avatar, Body, EmptyState, ErrorState, IconButton, LoadingState, Mono, Screen,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import type { ConversationSummary } from '@/types/models';

/** Správy — the inbox: direct chats and the group chat of every event you go to. */
export default function MessagesScreen() {
  const queryClient = useQueryClient();
  const { profile, isGuest } = useAuth();
  const layout = useLayout();

  // On a wide window the thread opens beside the list instead of replacing it:
  // navigating away from the inbox to read one message and back again is a step
  // backwards when there is room for both.
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => getConversations(60),
  });

  // A new message lands in the list without pulling to refresh.
  useEffect(() => {
    const channel = supabase
      .channel('inbox-messages')
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'messages' },
        () => {
          void queryClient.invalidateQueries({ queryKey: ['conversations'] });
          void queryClient.invalidateQueries({ queryKey: ['messages', 'unread'] });
        },
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [queryClient]);

  // A stranger has no messages to show — and no way to have any.
  if (isGuest) {
    return (
      <SignInInvite
        glyph="✉"
        title="Správy sú pre prihlásených"
        body="Chat eventu, skupiny a súkromné správy fungujú, až keď vieme, kto píše."
        perks={[
          'Dohodni sa s ostatnými, kto ide kedy a odkiaľ',
          'Napíš komukoľvek, koho stretneš na evente',
          'Chat každého eventu, na ktorý ideš',
        ]}
      />
    );
  }

  if (isLoading) return <Screen><LoadingState label="Načítavam správy…" /></Screen>;

  if (isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(error)} onRetry={() => void refetch()} />
      </Screen>
    );
  }

  const conversations = data ?? [];
  const splitView = layout.isDesktop;
  const selected = splitView ? (openId ?? conversations[0]?.id ?? null) : null;

  const inbox = (
    <>
      <View style={styles.header}>
        <View style={styles.flex}>
          <Mono accent>✉ správy</Mono>
          <Text style={styles.title}>Tvoje konverzácie</Text>
        </View>
        <IconButton glyph="⌕" onPress={() => router.push('/search')} />
      </View>

      <FlatList
        data={conversations}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={() => void refetch()}
            tintColor={colors.accent}
          />
        }
        renderItem={({ item }) => (
          <ConversationRow
            conversation={item}
            isMine={item.last_sender_id === profile?.id}
            selected={splitView && item.id === selected}
            onPress={() => (splitView ? setOpenId(item.id) : router.push(`/chat/${item.id}`))}
          />
        )}
        ListEmptyComponent={
          <EmptyState
            emoji="💬"
            title="Zatiaľ žiadne správy"
            body="Napíš niekomu z profilu, alebo si otvor skupinový chat eventu, na ktorý ideš."
            actionLabel="Nájdi si ľudí"
            onAction={() => router.push('/search')}
          />
        }
      />
    </>
  );

  if (splitView) {
    return (
      <View style={styles.split}>
        <View style={styles.splitList}>{inbox}</View>
        <View style={styles.splitThread}>
          {selected ? (
            <ChatThread key={selected} id={selected} embedded />
          ) : (
            <View style={styles.splitEmpty}>
              <EmptyState
                emoji="💬"
                title="Vyber si konverzáciu"
                body="Vľavo sú všetky. Otvorí sa tu vedľa, nemusíš nikam odchádzať."
              />
            </View>
          )}
        </View>
      </View>
    );
  }

  return <Screen contentStyle={styles.container}>{inbox}</Screen>;
}

function ConversationRow({
  conversation, isMine, onPress, selected = false,
}: {
  conversation: ConversationSummary;
  isMine: boolean;
  onPress: () => void;
  selected?: boolean;
}) {
  const isEvent = conversation.kind === 'event';
  const unread = conversation.unread_count > 0;

  const preview = conversation.last_message
    ? `${isMine ? 'Ty: ' : ''}${conversation.last_message}`
    : 'Zatiaľ tu nikto nič nenapísal';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [
        styles.row,
        unread && styles.rowUnread,
        selected && styles.rowSelected,
        pressed && styles.rowPressed,
      ]}
    >
      {isEvent ? (
        <View style={styles.eventAvatar}>
          <Text style={styles.eventGlyph}>◉</Text>
        </View>
      ) : (
        <Avatar
          url={conversation.other_avatar_url}
          name={conversation.other_name ?? conversation.title}
          size={52}
          ring={unread}
        />
      )}

      <View style={styles.flex}>
        <View style={styles.rowTop}>
          <Text style={[styles.name, unread && styles.nameUnread]} numberOfLines={1}>
            {conversation.title ?? conversation.other_name ?? 'Konverzácia'}
          </Text>
          {conversation.last_message_at ? (
            <Mono style={styles.time}>{formatRelative(conversation.last_message_at)}</Mono>
          ) : null}
        </View>

        <View style={styles.rowBottom}>
          <Body muted numberOfLines={1} style={styles.flex}>{preview}</Body>

          {conversation.muted ? <Text style={styles.mutedGlyph}>🔕</Text> : null}
          {unread ? (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>
                {conversation.unread_count > 99 ? '99+' : conversation.unread_count}
              </Text>
            </View>
          ) : null}
        </View>

        {isEvent ? (
          <Mono style={styles.groupHint}>
            skupina · {conversation.participant_count} ľudí
          </Mono>
        ) : null}
      </View>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  split: { flex: 1, flexDirection: 'row', backgroundColor: colors.background },
  splitList: {
    width: 348,
    borderRightWidth: 1,
    borderRightColor: colors.border,
    paddingTop: spacing.xl,
    paddingHorizontal: spacing.lg,
  },
  splitThread: { flex: 1, minWidth: 0 },
  splitEmpty: { flex: 1, justifyContent: 'center' },
  rowSelected: { backgroundColor: colors.surfaceElevated2 },
  container: { paddingTop: spacing.md },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    marginBottom: spacing.md,
  },
  title: { ...typography.title, color: colors.text, marginTop: 2 },

  list: { paddingHorizontal: spacing.lg, paddingBottom: spacing.xxxl, flexGrow: 1 },

  row: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.lg,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  rowUnread: { borderColor: colors.accent, backgroundColor: colors.backgroundElevated },
  rowPressed: { backgroundColor: colors.surfacePressed },

  eventAvatar: {
    width: 52,
    height: 52,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eventGlyph: { fontSize: 20, color: colors.accentText },

  rowTop: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  name: { ...typography.bodyStrong, color: colors.text, flex: 1 },
  nameUnread: { fontFamily: typography.subheading.fontFamily },
  time: { color: colors.textTertiary },

  rowBottom: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginTop: 2 },
  mutedGlyph: { fontSize: 13 },
  badge: {
    minWidth: 22,
    height: 22,
    paddingHorizontal: 6,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { ...typography.mono, color: '#FFFFFF' },
  groupHint: { color: colors.textTertiary, marginTop: 2 },
});
