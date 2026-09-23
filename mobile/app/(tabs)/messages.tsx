import React, { useEffect, useState } from 'react';
import {
  FlatList, Pressable, RefreshControl, StyleSheet, Text, View,
} from 'react-native';
import { router } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import {
  deleteConversation, getConversations, searchMyChats, startDirectConversation,
  type ChatSearchHit,
} from '@/api/messages';
import { BottomSheet } from '@/components/BottomSheet';
import { useDialog } from '@/components/Dialog';
import { useToast } from '@/components/Toast';
import { ChatThread } from '../chat/[id]';
import { useLayout } from '@/hooks/useLayout';
import { SignInInvite } from '@/components/SignInInvite';
import { useAuth } from '@/auth/AuthProvider';
import { subscribeToTable } from '@/lib/realtime';
import { messageFor } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import {
  Avatar, Body, Caption, EmptyState, ErrorState, IconButton, Input, LoadingState, Mono,
  Notice, Screen,
} from '@/components/ui';
import { SiteFooter } from '@/components/SiteFooter';
import { usePullToRefresh } from '@/hooks/usePullToRefresh';
import { colors, radius, spacing, typography } from '@/theme';
import type { ConversationSummary } from '@/types/models';

/** Správy — the inbox: direct chats and the group chat of every event you go to. */
export default function MessagesScreen() {
  const queryClient = useQueryClient();
  const { profile, isGuest } = useAuth();
  const layout = useLayout();
  const dialog = useDialog();
  const toast = useToast();

  /**
   * Searching happens here, not on /search.
   *
   * The magnifier used to open the event search — which answers a question
   * nobody standing in their own inbox is asking. What people look for in
   * Správy is a person.
   */
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  /** The row a long press opened the menu for. */
  const [menuFor, setMenuFor] = useState<ConversationSummary | null>(null);
  /** Not `error`: the conversations query already owns that name here. */
  const [actionError, setActionError] = useState<string | null>(null);

  // Needed above the early returns too, so the search handler can decide
  // whether opening a thread means navigating or filling the right-hand panel.
  const splitViewNow = layout.isDesktop;

  // On a wide window the thread opens beside the list instead of replacing it:
  // navigating away from the inbox to read one message and back again is a step
  // backwards when there is room for both.
  const [openId, setOpenId] = useState<string | null>(null);

  const { data, isLoading, isError, error, refetch, isRefetching } = useQuery({
    queryKey: ['conversations'],
    queryFn: () => getConversations(60),
  });

  // RefreshControl is inert on react-native-web; this is the browser's version.
  const pull = usePullToRefresh(() => refetch(), isRefetching);

  const hits = useQuery({
    queryKey: ['chat-search', query],
    queryFn: () => searchMyChats(query, 30),
    enabled: searching && query.trim().length > 0,
  });

  /**
   * Clearing a chat.
   *
   * Worded carefully, because it cannot do what "zmazať" sounds like it does:
   * the other person keeps their copy, and no app can take that away. What the
   * confirmation promises is exactly what happens.
   */
  const removeConversation = async (conversation: ConversationSummary) => {
    setActionError(null);
    const sure = await dialog.confirm({
      title: 'Zmazať tento chat?',
      body: conversation.kind === 'event'
        ? 'Zmizne ti z prehľadu aj s celou históriou. Ostatným v skupine nezmizne nič — a ak tam niekto napíše, chat sa ti vráti s novými správami.'
        : 'Zmizne ti z prehľadu aj s celou históriou. Druhej strane nezmizne nič — a ak ti napíše, chat sa ti vráti, ale už len s novými správami.',
      confirmLabel: 'Zmazať',
      destructive: true,
    });
    if (!sure) return;

    try {
      await deleteConversation(conversation.id);
      if (openId === conversation.id) setOpenId(null);
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
      await queryClient.invalidateQueries({ queryKey: ['messages', 'unread'] });
      await queryClient.invalidateQueries({ queryKey: ['chat-search'] });
      toast.show('Chat zmazaný');
    } catch (caught) {
      setActionError(messageFor(caught));
    }
  };

  /** A hit with no thread yet needs one opening before it can be shown. */
  const openHit = async (hit: ChatSearchHit) => {
    setActionError(null);
    try {
      const id = hit.conversation_id ?? await startDirectConversation(hit.user_id!);
      setSearching(false);
      setQuery('');
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
      if (splitViewNow) setOpenId(id);
      else router.push(`/chat/${id}`);
    } catch (caught) {
      setActionError(messageFor(caught));
    }
  };

  // A new message lands in the list without pulling to refresh.
  useEffect(() => subscribeToTable({
    topic: 'inbox-messages',
    table: 'messages',
    event: 'INSERT',
    onChange: () => {
      void queryClient.invalidateQueries({ queryKey: ['conversations'] });
      void queryClient.invalidateQueries({ queryKey: ['messages', 'unread'] });
    },
  }), [queryClient]);

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
  const splitView = splitViewNow;
  const selected = splitView ? (openId ?? conversations[0]?.id ?? null) : null;
  const results = hits.data ?? [];

  const inbox = (
    <>
      <View style={styles.header}>
        {searching ? (
          <>
            <Input
              value={query}
              onChangeText={setQuery}
              placeholder="Nájdi človeka alebo chat…"
              autoCapitalize="none"
              autoCorrect={false}
              autoFocus
              returnKeyType="search"
              style={styles.flex}
            />
            <IconButton
              glyph="✕"
              onPress={() => { setSearching(false); setQuery(''); }}
            />
          </>
        ) : (
          <>
            <View style={styles.flex}>
              <Mono accent>✉ správy</Mono>
              <Text style={styles.title}>Tvoje konverzácie</Text>
            </View>
            {/* Searches your chats. It used to open /search, which searches
                events — the wrong question, answered confidently. */}
            <IconButton glyph="⌕" onPress={() => setSearching(true)} />
          </>
        )}
      </View>

      {actionError ? (
        <Notice tone="danger" title="Toto sa nepodarilo" body={actionError} />
      ) : null}

      {pull.indicator}

      {searching ? (
        <FlatList
          data={results}
          keyExtractor={(item) => item.conversation_id ?? `person-${item.user_id}`}
          contentContainerStyle={styles.list}
          keyboardShouldPersistTaps="handled"
          showsVerticalScrollIndicator={false}
          renderItem={({ item }) => (
            <SearchRow hit={item} onPress={() => void openHit(item)} />
          )}
          ListEmptyComponent={
            query.trim().length === 0 ? (
              <View style={styles.searchHint}>
                <Caption>
                  Píš meno alebo @prezývku. Hľadá v tvojich chatoch a medzi ľuďmi,
                  ktorých sleduješ.
                </Caption>
              </View>
            ) : hits.isLoading ? (
              <LoadingState label="Hľadám…" />
            ) : (
              <EmptyState
                emoji="🔍"
                title="Nikoho takého tu nemáš"
                body="V tvojich chatoch ani medzi ľuďmi, ktorých sleduješ, nikto taký nie je."
              />
            )
          }
        />
      ) : (
        <FlatList
          {...pull.handlers}
          ListFooterComponent={<SiteFooter />}
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
              onLongPress={() => setMenuFor(item)}
            />
          )}
          ListEmptyComponent={
            <EmptyState
              emoji="💬"
              title="Zatiaľ žiadne správy"
              body="Napíš niekomu z profilu, alebo si otvor skupinový chat eventu, na ktorý ideš."
              actionLabel="Nájdi si ľudí"
              onAction={() => router.push('/people')}
            />
          }
        />
      )}

      {/* Long press, not a swipe: a swipe-to-delete on a list you also scroll
          horizontally nothing else in this app does, and a hidden gesture is a
          bad way to reach something irreversible. */}
      <BottomSheet
        visible={Boolean(menuFor)}
        onClose={() => setMenuFor(null)}
        title={menuFor?.title ?? menuFor?.other_name ?? 'Konverzácia'}
        subtitle={menuFor?.kind === 'event' ? 'Skupinový chat eventu' : undefined}
      >
        <Pressable
          style={({ pressed }) => [styles.menuRow, pressed && styles.menuRowPressed]}
          onPress={() => {
            const target = menuFor;
            setMenuFor(null);
            if (target) void removeConversation(target);
          }}
        >
          <Text style={styles.menuGlyph}>🗑</Text>
          <View style={styles.flex}>
            <Text style={styles.menuLabelDanger}>Zmazať chat</Text>
            <Caption>Zmizne len tebe. Druhej strane zostane jej kópia.</Caption>
          </View>
        </Pressable>
      </BottomSheet>
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

/** One search hit: a thread you have, or a person you could write to. */
function SearchRow({ hit, onPress }: { hit: ChatSearchHit; onPress: () => void }) {
  const isEvent = hit.kind === 'event';
  const name = hit.title ?? hit.display_name ?? hit.username ?? 'Konverzácia';

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      style={({ pressed }) => [styles.row, pressed && styles.rowPressed]}
    >
      {isEvent ? (
        <View style={styles.eventAvatar}>
          <Text style={styles.eventGlyph}>◉</Text>
        </View>
      ) : (
        <Avatar url={hit.avatar_url} name={hit.display_name ?? hit.username} size={52} />
      )}

      <View style={styles.flex}>
        <View style={styles.rowTop}>
          <Text style={styles.name} numberOfLines={1}>{name}</Text>
          {hit.last_message_at ? (
            <Mono style={styles.time}>{formatRelative(hit.last_message_at)}</Mono>
          ) : null}
        </View>

        <Body muted numberOfLines={1}>
          {hit.last_message
            ?? (hit.conversation_id
              // A thread with nothing in it and a person with no thread are two
              // different states, and both used to read as the same blank line.
              ? 'Zatiaľ tu nikto nič nenapísal'
              : `@${hit.username ?? '—'} · napísať prvú správu`)}
        </Body>
      </View>

      {hit.unread_count > 0 ? (
        <View style={styles.badge}>
          <Text style={styles.badgeText}>
            {hit.unread_count > 99 ? '99+' : hit.unread_count}
          </Text>
        </View>
      ) : null}
    </Pressable>
  );
}

function ConversationRow({
  conversation, isMine, onPress, onLongPress, selected = false,
}: {
  conversation: ConversationSummary;
  isMine: boolean;
  onPress: () => void;
  onLongPress?: () => void;
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
      onLongPress={onLongPress}
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

  searchHint: { paddingHorizontal: spacing.xs, paddingTop: spacing.sm },

  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  menuRowPressed: { opacity: 0.6 },
  menuGlyph: { fontSize: 18 },
  menuLabelDanger: { ...typography.bodyStrong, color: colors.danger },
});
