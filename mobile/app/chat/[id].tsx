import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import {
  deleteMessage, getConversation, getMessages, getParticipants, leaveConversation,
  markConversationRead, sendMessage, setConversationMuted,
} from '@/api/messages';
import { pickImage, signChatImage, uploadChatImage } from '@/storage/uploads';
import { ImageLightbox } from '@/components/ImageLightbox';
import { subscribeToTable } from '@/lib/realtime';
import { messageFor } from '@/lib/errors';
import { formatMessageTime, isSameDay, formatDayLabel } from '@/lib/format';
import {
  Avatar, Body, ErrorState, LoadingState, Mono, Notice, Screen,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';
import type { Message } from '@/types/models';

/**
 * A conversation.
 *
 * Messages arrive over realtime while the screen is open; the read marker is
 * pushed when it opens and whenever a new message lands, so the inbox badge
 * clears the moment you actually look.
 */
/**
 * The route: reads the id from the URL and renders the thread.
 *
 * The thread itself is a component rather than a screen so the desktop inbox
 * can show it beside the conversation list — on a wide window, navigating away
 * from the list to read one message is a step backwards.
 */
export default function ChatScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  return <ChatThread id={id} />;
}

export function ChatThread({ id, embedded = false }: { id?: string; embedded?: boolean }) {
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { profile } = useAuth();

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<FlatList<Message>>(null);

  const conversation = useQuery({
    queryKey: ['conversation', id],
    queryFn: () => getConversation(id!),
    enabled: Boolean(id),
  });

  const participants = useQuery({
    queryKey: ['conversation', id, 'participants'],
    queryFn: () => getParticipants(id!),
    enabled: Boolean(id),
  });

  const messages = useQuery({
    queryKey: ['messages', id],
    queryFn: () => getMessages(id!),
    enabled: Boolean(id),
  });

  const others = (participants.data ?? []).filter(
    (participant) => participant.user_id !== profile?.id,
  );
  const record = conversation.data as
    | { kind: 'direct' | 'event'; title: string | null; event_id: string | null }
    | null
    | undefined;

  const otherProfile = others[0]?.profile as
    | { id: string; display_name: string | null; username: string | null; avatar_url: string | null }
    | undefined;

  const heading = record?.kind === 'event'
    ? (record.title ?? 'Chat eventu')
    : (otherProfile?.display_name ?? otherProfile?.username ?? 'Konverzácia');

  useEffect(() => {
    // Embedded in the desktop inbox there is no header to name — setting the
    // title there would rewrite the *inbox* header from inside a panel.
    if (embedded) return;
    navigation.setOptions({ title: heading });
  }, [navigation, heading, embedded]);

  const markRead = useCallback(() => {
    if (!id) return;
    markConversationRead(id)
      .then(() => queryClient.invalidateQueries({ queryKey: ['conversations'] }))
      .catch(() => undefined);
  }, [id, queryClient]);

  useEffect(() => {
    markRead();
  }, [markRead]);

  // Live thread.
  useEffect(() => {
    if (!id) return;

    return subscribeToTable({
      topic: `chat-${id}`,
      table: 'messages',
      filter: `conversation_id=eq.${id}`,
      onChange: () => {
        void queryClient.invalidateQueries({ queryKey: ['messages', id] });
        markRead();
      },
    });
  }, [id, queryClient, markRead]);

  const submit = async () => {
    const body = draft.trim();
    if (!body || !id) return;

    setError(null);
    setSending(true);
    setDraft('');

    try {
      await sendMessage({ conversationId: id, body });
      await queryClient.invalidateQueries({ queryKey: ['messages', id] });
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch (caught) {
      setDraft(body); // give the text back rather than losing it
      setError(messageFor(caught));
    } finally {
      setSending(false);
    }
  };

  const attach = async () => {
    if (!id) return;
    setError(null);
    try {
      const picked = await pickImage({ source: 'library', aspect: [4, 3] });
      if (!picked) return;

      setSending(true);
      const url = await uploadChatImage(picked.uri, id);
      await sendMessage({ conversationId: id, attachmentUrl: url });
      await queryClient.invalidateQueries({ queryKey: ['messages', id] });
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSending(false);
    }
  };

  const remove = async (messageId: string) => {
    setError(null);
    try {
      await deleteMessage(messageId);
      await queryClient.invalidateQueries({ queryKey: ['messages', id] });
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const toggleMute = async () => {
    if (!id) return;
    const current = participants.data?.find((p) => p.user_id === profile?.id);
    try {
      await setConversationMuted(id, !current?.muted);
      await participants.refetch();
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const leave = async () => {
    if (!id) return;
    try {
      await leaveConversation(id);
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
      router.back();
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  if (messages.isLoading || conversation.isLoading) {
    return <Screen><LoadingState /></Screen>;
  }

  if (messages.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(messages.error)} onRetry={() => void messages.refetch()} />
      </Screen>
    );
  }

  const items = messages.data ?? [];
  const muted = participants.data?.find((p) => p.user_id === profile?.id)?.muted ?? false;

  return (
    <Screen edges={['bottom']} contentStyle={styles.container}>
      <KeyboardAvoidingView
        style={styles.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={Platform.OS === 'ios' ? 92 : 0}
      >
        {/* --- thread header ------------------------------------------------ */}
        <View style={styles.threadBar}>
          {record?.kind === 'event' ? (
            <Pressable
              style={styles.threadInfo}
              onPress={() => record.event_id && router.push(`/event/${record.event_id}`)}
            >
              <View style={styles.eventDot}><Text style={styles.eventDotGlyph}>◉</Text></View>
              <View style={styles.flex}>
                <Text style={styles.threadTitle} numberOfLines={1}>{heading}</Text>
                <Mono style={styles.threadMeta}>
                  skupina · {(participants.data ?? []).length} ľudí · otvoriť event
                </Mono>
              </View>
            </Pressable>
          ) : otherProfile ? (
            <Pressable
              style={styles.threadInfo}
              onPress={() => router.push(`/user/${otherProfile.id}`)}
            >
              <Avatar url={otherProfile.avatar_url} name={otherProfile.display_name} size={38} />
              <View style={styles.flex}>
                <Text style={styles.threadTitle} numberOfLines={1}>{heading}</Text>
                <Mono style={styles.threadMeta}>@{otherProfile.username ?? '—'}</Mono>
              </View>
            </Pressable>
          ) : (
            <View style={styles.flex} />
          )}

          <Pressable onPress={toggleMute} hitSlop={10} accessibilityRole="button">
            <Text style={styles.barGlyph}>{muted ? '🔕' : '🔔'}</Text>
          </Pressable>
          {record?.kind === 'event' ? (
            <Pressable onPress={leave} hitSlop={10} accessibilityRole="button">
              <Text style={styles.barGlyph}>⤶</Text>
            </Pressable>
          ) : null}
        </View>

        {error ? <Notice tone="danger" title="Správa neodišla" body={error} /> : null}

        <FlatList
          ref={listRef}
          data={items}
          keyExtractor={(item) => item.id}
          contentContainerStyle={styles.list}
          showsVerticalScrollIndicator={false}
          onContentSizeChange={() => listRef.current?.scrollToEnd({ animated: false })}
          ListEmptyComponent={
            <View style={styles.empty}>
              <Text style={styles.emptyEmoji}>👋</Text>
              <Body muted style={styles.emptyText}>
                Zatiaľ tu nič nie je. Napíš prvú správu.
              </Body>
            </View>
          }
          renderItem={({ item, index }) => {
            const previous = index > 0 ? items[index - 1] : null;
            const showDay = !previous || !isSameDay(previous.created_at, item.created_at);
            const isMine = item.sender_id === profile?.id;
            const showAuthor =
              record?.kind === 'event'
              && !isMine
              && (!previous || previous.sender_id !== item.sender_id || showDay);

            return (
              <View>
                {showDay ? (
                  <Mono style={styles.dayLabel}>{formatDayLabel(item.created_at)}</Mono>
                ) : null}

                <MessageBubble
                  message={item}
                  isMine={isMine}
                  showAuthor={showAuthor}
                  onLongPress={isMine && !item.deleted_at ? () => void remove(item.id) : undefined}
                />
              </View>
            );
          }}
        />

        {/* --- composer ------------------------------------------------------ */}
        <View style={styles.composer}>
          <Pressable
            onPress={attach}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel="Priložiť fotku"
            style={({ pressed }) => [styles.attachButton, pressed && styles.pressed]}
          >
            <Text style={styles.attachGlyph}>＋</Text>
          </Pressable>

          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="Napíš správu…"
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            multiline
            maxLength={4000}
            editable={!sending}
            onSubmitEditing={submit}
          />

          <Pressable
            onPress={submit}
            disabled={sending || draft.trim().length === 0}
            accessibilityRole="button"
            accessibilityLabel="Odoslať"
            style={({ pressed }) => [
              styles.sendButton,
              (sending || draft.trim().length === 0) && styles.sendDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.sendGlyph}>↑</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}

function MessageBubble({
  message, isMine, showAuthor, onLongPress,
}: {
  message: Message;
  isMine: boolean;
  showAuthor: boolean;
  onLongPress?: () => void;
}) {
  if (message.deleted_at) {
    return (
      <View style={[styles.bubbleRow, isMine && styles.bubbleRowMine]}>
        <View style={[styles.bubble, styles.bubbleDeleted]}>
          <Text style={styles.deletedText}>Správa bola zmazaná</Text>
        </View>
      </View>
    );
  }

  return (
    <View style={[styles.bubbleRow, isMine && styles.bubbleRowMine]}>
      <Pressable
        onLongPress={onLongPress}
        delayLongPress={400}
        style={[styles.bubble, isMine ? styles.bubbleMine : styles.bubbleTheirs]}
      >
        {showAuthor ? (
          <Mono style={styles.author}>
            {message.sender?.display_name ?? message.sender?.username ?? 'Niekto'}
          </Mono>
        ) : null}

        {message.attachment_url ? <ChatImage path={message.attachment_url} /> : null}

        {message.body ? (
          <Text style={[styles.bubbleText, isMine && styles.bubbleTextMine]}>{message.body}</Text>
        ) : null}

        <Mono style={[styles.bubbleTime, isMine && styles.bubbleTimeMine]}>
          {formatMessageTime(message.created_at)}
        </Mono>
      </Pressable>
    </View>
  );
}

/**
 * A chat photo. The message stores an object path in the private bucket, so the
 * URL has to be signed before it can be shown; react-query keeps the signature
 * for the hour it is valid instead of re-signing on every render.
 */
function ChatImage({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  const signed = useQuery({
    queryKey: ['chat-image', path],
    queryFn: () => signChatImage(path),
    staleTime: 50 * 60 * 1000,
  });

  if (!signed.data) {
    return (
      <View style={[styles.attachment, styles.attachmentPending]}>
        <Mono style={styles.attachmentLabel}>
          {signed.isLoading ? '[ načítavam fotku ]' : '[ fotka nedostupná ]'}
        </Mono>
      </View>
    );
  }

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="imagebutton"
        accessibilityLabel="Otvoriť fotku"
      >
        <Image
          source={{ uri: signed.data }}
          style={styles.attachment}
          contentFit="cover"
          transition={160}
        />
      </Pressable>
      <ImageLightbox uri={open ? signed.data : null} onClose={() => setOpen(false)} />
    </>
  );
}

const styles = StyleSheet.create({
  container: { padding: 0 },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  pressed: { opacity: 0.85 },

  threadBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
    backgroundColor: colors.backgroundElevated,
  },
  threadInfo: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, flex: 1 },
  eventDot: {
    width: 38,
    height: 38,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  eventDotGlyph: { fontSize: 16, color: colors.accentText },
  threadTitle: { ...typography.bodyStrong, color: colors.text },
  threadMeta: { color: colors.textTertiary },
  barGlyph: { fontSize: 17, color: colors.textSecondary },

  list: { padding: spacing.lg, paddingBottom: spacing.md, flexGrow: 1, justifyContent: 'flex-end' },
  dayLabel: {
    color: colors.textTertiary,
    textAlign: 'center',
    marginVertical: spacing.md,
  },

  bubbleRow: { flexDirection: 'row', marginBottom: spacing.sm },
  bubbleRowMine: { justifyContent: 'flex-end' },
  bubble: {
    maxWidth: '82%',
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    borderRadius: radius.lg,
    gap: 2,
  },
  bubbleTheirs: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderBottomLeftRadius: radius.sm,
  },
  bubbleMine: { backgroundColor: colors.accent, borderBottomRightRadius: radius.sm },
  bubbleDeleted: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderStyle: 'dashed',
  },
  deletedText: { ...typography.caption, color: colors.textTertiary, fontStyle: 'italic' },

  author: { color: colors.accentText, marginBottom: 2 },
  bubbleText: { ...typography.body, color: colors.text },
  bubbleTextMine: { color: '#FFFFFF' },
  bubbleTime: { color: colors.textTertiary, alignSelf: 'flex-end', fontSize: 10 },
  bubbleTimeMine: { color: 'rgba(255,255,255,0.7)' },

  attachment: {
    width: 220,
    height: 165,
    borderRadius: radius.md,
    marginBottom: spacing.xs,
    backgroundColor: colors.surfaceElevated,
  },
  attachmentPending: { alignItems: 'center', justifyContent: 'center' },
  attachmentLabel: { color: colors.textTertiary },

  empty: { alignItems: 'center', gap: spacing.sm, paddingVertical: spacing.xxxl },
  emptyEmoji: { fontSize: 40 },
  emptyText: { textAlign: 'center' },

  composer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: spacing.sm,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.sm,
    paddingBottom: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    backgroundColor: colors.backgroundElevated,
  },
  attachButton: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  attachGlyph: { fontSize: 20, color: colors.textSecondary },
  input: {
    flex: 1,
    minHeight: 42,
    maxHeight: 120,
    paddingHorizontal: spacing.md,
    paddingTop: 11,
    paddingBottom: 11,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    color: colors.text,
    ...typography.body,
  },
  sendButton: {
    width: 42,
    height: 42,
    borderRadius: radius.md,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendDisabled: { backgroundColor: colors.surfaceElevated },
  sendGlyph: { fontSize: 20, color: '#FFFFFF' },
});
