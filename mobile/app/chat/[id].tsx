import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from 'react-native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import {
  deleteConversation, deleteMessage, getConversation, getMessages, getParticipants,
  leaveConversation, markConversationRead, sendMessage, setConversationMuted,
} from '@/api/messages';
import { pickImage, signChatImage, uploadChatGif, uploadChatImage } from '@/storage/uploads';
import { BottomSheet } from '@/components/BottomSheet';
import { GifPicker } from '@/components/GifPicker';
import { useDialog } from '@/components/Dialog';
import { ImageLightbox } from '@/components/ImageLightbox';
import { subscribeToTable } from '@/lib/realtime';
import { enterSubmits } from '@/lib/keyboard';
import { useAccent } from '@/theme/accent';
import { messageFor } from '@/lib/errors';
import { formatMessageTime, isSameDay, formatDayLabel } from '@/lib/format';
import {
  Avatar, Body, Caption, ErrorState, LoadingState, Mono, Notice, Screen,
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
  const dialog = useDialog();
  const { profile } = useAuth();

  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  /** A picked photo waiting to go with the next message. */
  const [pending, setPending] = useState<string | null>(null);
  /**
   * A picked GIF, waiting the same way.
   *
   * Kept apart from `pending` rather than sharing it with a flag: the two take
   * different upload paths, and one of them must not be re-encoded. Merging
   * them is exactly how a GIF ends up sent as a single still frame.
   */
  const [pendingGif, setPendingGif] = useState<string | null>(null);
  const [gifOpen, setGifOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The message being answered. Held here rather than on the bubble, because
  // what it changes is the composer, not the message that was tapped.
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  /** The message a long press opened the menu for. */
  const [menuFor, setMenuFor] = useState<Message | null>(null);

  // A Premium wallpaper, which only its owner sees: it is behind *your* chats,
  // not behind the conversation, so nobody else's room changes because you
  // picked a photo.
  const accent = useAccent();
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

  /**
   * Picking a photo used to send it. There was no moment between choosing the
   * file and it being in the conversation — no caption, no second look, no way
   * back. It waits here instead, and goes with the next send.
   */
  const submit = async () => {
    const body = draft.trim();
    if ((!body && !pending && !pendingGif) || !id) return;

    const photo = pending;
    const gif = pendingGif;
    const answering = replyTo;
    setError(null);
    setSending(true);
    setDraft('');
    setPending(null);
    setPendingGif(null);
    setReplyTo(null);

    try {
      // A GIF takes the path that does not re-encode; a photo takes the one
      // that does. Sending both at once is not a thing, so this is an either/or.
      const attachmentUrl = gif
        ? await uploadChatGif(gif, id)
        : photo
          ? await uploadChatImage(photo, id)
          : undefined;

      await sendMessage({
        conversationId: id,
        body: body || undefined,
        ...(attachmentUrl ? { attachmentUrl } : {}),
        replyToId: answering?.id ?? null,
      });
      await queryClient.invalidateQueries({ queryKey: ['messages', id] });
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
    } catch (caught) {
      // Give all of it back rather than losing it.
      setDraft(body);
      setPending(photo);
      setPendingGif(gif);
      setReplyTo(answering);
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
      // Attached, not sent. Nothing leaves until the send button is pressed.
      setPending(picked.uri);
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  /**
   * Deleting used to happen on the long press itself, with nothing in between.
   * One accidental hold on your own message and it was gone — no question, no
   * undo, and the other person had already read it.
   */
  const remove = async (messageId: string) => {
    setError(null);
    const sure = await dialog.confirm({
      title: 'Zmazať správu?',
      body: 'Ostatným v konverzácii zostane na jej mieste „Správa bola zmazaná". Vrátiť sa to nedá.',
      confirmLabel: 'Zmazať',
      destructive: true,
    });
    if (!sure) return;

    try {
      await deleteMessage(messageId);
      await queryClient.invalidateQueries({ queryKey: ['messages', id] });
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  /**
   * Clearing the whole thread.
   *
   * The wording has to match what actually happens: the other person's copy is
   * beyond anybody's reach, so this empties your side and nothing more.
   */
  const removeChat = async () => {
    if (!id) return;
    setError(null);
    const sure = await dialog.confirm({
      title: 'Zmazať tento chat?',
      body: record?.kind === 'event'
        ? 'Zmizne ti z prehľadu aj s celou históriou. Ostatným v skupine nezmizne nič — a ak tam niekto napíše, chat sa ti vráti s novými správami.'
        : 'Zmizne ti z prehľadu aj s celou históriou. Druhej strane nezmizne nič — a ak ti napíše, chat sa ti vráti, ale už len s novými správami.',
      confirmLabel: 'Zmazať',
      destructive: true,
    });
    if (!sure) return;

    try {
      await deleteConversation(id);
      await queryClient.invalidateQueries({ queryKey: ['conversations'] });
      await queryClient.invalidateQueries({ queryKey: ['messages', 'unread'] });
      router.back();
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
        {/* The wallpaper, behind everything and under a scrim. Text on a photo
            is unreadable often enough that the scrim is not optional — and the
            bubbles keep their own background, so nothing depends on which photo
            somebody picked. */}
        {accent.chatWallpaper ? (
          <View style={styles.wallpaperLayer} pointerEvents="none">
            <Image
              source={{ uri: accent.chatWallpaper }}
              style={StyleSheet.absoluteFill}
              contentFit="cover"
              transition={150}
            />
            <View style={styles.wallpaperScrim} />
          </View>
        ) : null}

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
          <Pressable
            onPress={removeChat}
            hitSlop={10}
            accessibilityRole="button"
            accessibilityLabel="Zmazať chat"
          >
            <Text style={styles.barGlyph}>🗑</Text>
          </Pressable>
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
                  myId={profile?.id ?? null}
                  onLongPress={item.deleted_at ? undefined : () => setMenuFor(item)}
                />
              </View>
            );
          }}
        />

        {/* --- composer ------------------------------------------------------ */}
        {/* What is being answered, above the box you answer in. Without it a
            reply is a guess about which of thirty messages it belongs to. */}
        {replyTo ? (
          <View style={styles.replyStrip}>
            <View style={styles.replyBar} />
            <View style={styles.flex}>
              <Mono style={styles.replyWho}>
                {replyTo.sender_id === profile?.id
                  ? 'Odpovedáš sebe'
                  : `Odpovedáš ${replyTo.sender?.display_name ?? replyTo.sender?.username ?? 'na správu'}`}
              </Mono>
              <Text numberOfLines={1} style={styles.replyText}>
                {replyTo.body ?? attachmentLabel(replyTo.attachment_url) ?? '📷 Fotka'}
              </Text>
            </View>
            <Pressable
              onPress={() => setReplyTo(null)}
              accessibilityRole="button"
              accessibilityLabel="Zrušiť odpoveď"
              disabled={sending}
              style={({ pressed }) => [styles.pendingRemove, pressed && styles.pressed]}
            >
              <Text style={styles.pendingRemoveGlyph}>✕</Text>
            </Pressable>
          </View>
        ) : null}

        {pendingGif ? (
          <View style={styles.pendingRow}>
            <Image source={{ uri: pendingGif }} style={styles.pendingThumb} contentFit="cover" />
            <View style={styles.flex}>
              <Caption>GIF je priložený. Pošle sa so správou.</Caption>
            </View>
            <Pressable
              onPress={() => setPendingGif(null)}
              accessibilityRole="button"
              accessibilityLabel="Odobrať GIF"
              disabled={sending}
              style={({ pressed }) => [styles.pendingRemove, pressed && styles.pressed]}
            >
              <Text style={styles.pendingRemoveGlyph}>✕</Text>
            </Pressable>
          </View>
        ) : null}

        {pending ? (
          <View style={styles.pendingRow}>
            <Image source={{ uri: pending }} style={styles.pendingThumb} contentFit="cover" />
            <View style={styles.flex}>
              <Caption>Fotka je priložená. Pošle sa so správou.</Caption>
            </View>
            <Pressable
              onPress={() => setPending(null)}
              accessibilityRole="button"
              accessibilityLabel="Odobrať fotku"
              disabled={sending}
              style={({ pressed }) => [styles.pendingRemove, pressed && styles.pressed]}
            >
              <Text style={styles.pendingRemoveGlyph}>✕</Text>
            </Pressable>
          </View>
        ) : null}

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

          <Pressable
            onPress={() => setGifOpen(true)}
            disabled={sending}
            accessibilityRole="button"
            accessibilityLabel="Poslať GIF"
            style={({ pressed }) => [styles.attachButton, pressed && styles.pressed]}
          >
            <Text style={styles.gifGlyph}>GIF</Text>
          </Pressable>

          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={pending || pendingGif ? "Pridaj popis (nepovinné)…" : "Napíš správu…"}
            placeholderTextColor={colors.textTertiary}
            style={styles.input}
            multiline
            maxLength={4000}
            editable={!sending}
            onSubmitEditing={submit}
            {...enterSubmits(submit)}
          />

          <Pressable
            onPress={submit}
            disabled={sending || (draft.trim().length === 0 && !pending && !pendingGif)}
            accessibilityRole="button"
            accessibilityLabel="Odoslať"
            style={({ pressed }) => [
              styles.sendButton,
              (sending || (draft.trim().length === 0 && !pending && !pendingGif))
                && styles.sendDisabled,
              pressed && styles.pressed,
            ]}
          >
            <Text style={styles.sendGlyph}>↑</Text>
          </Pressable>
        </View>
      </KeyboardAvoidingView>

      <GifPicker
        visible={gifOpen}
        onClose={() => setGifOpen(false)}
        onPick={(source) => {
          // Attached, not sent — same rule as a photo. Nothing leaves the app
          // until the send button is pressed.
          setPendingGif(source);
          // A GIF and a photo in one message is not a thing the sender can see
          // before they send it, so picking one drops the other.
          setPending(null);
          setGifOpen(false);
        }}
      />

      {/* What a long press opens. Reply is here rather than printed into every
          bubble, and deleting is a separate, confirmed step rather than the
          thing a long press did by itself. */}
      <BottomSheet
        visible={Boolean(menuFor)}
        onClose={() => setMenuFor(null)}
        title="Správa"
        subtitle={menuFor?.body ?? attachmentLabel(menuFor?.attachment_url)}
      >
        <Pressable
          style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
          onPress={() => {
            const target = menuFor;
            setMenuFor(null);
            if (target) setReplyTo(target);
          }}
        >
          <Text style={styles.menuGlyph}>↩</Text>
          <Text style={styles.menuLabel}>Odpovedať</Text>
        </Pressable>

        {menuFor?.sender_id === profile?.id ? (
          <Pressable
            style={({ pressed }) => [styles.menuRow, pressed && styles.pressed]}
            onPress={() => {
              const target = menuFor;
              setMenuFor(null);
              if (target) void remove(target.id);
            }}
          >
            <Text style={[styles.menuGlyph, styles.menuDanger]}>🗑</Text>
            <Text style={[styles.menuLabel, styles.menuDanger]}>Zmazať</Text>
          </Pressable>
        ) : null}
      </BottomSheet>
    </Screen>
  );
}

function MessageBubble({
  message, isMine, showAuthor, myId, onLongPress,
}: {
  message: Message;
  isMine: boolean;
  showAuthor: boolean;
  myId: string | null;
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

        {/* The quote. `reply_to` is null both for an ordinary message and for
            a reply whose target was deleted — hence the second branch, which
            says what happened instead of quietly dropping the quote. */}
        {message.reply_to ? (
          <View style={[styles.quote, isMine && styles.quoteMine]}>
            <Mono style={[styles.quoteWho, isMine && styles.quoteWhoMine]}>
              {message.reply_to.sender_id === myId ? 'TY' : 'ODPOVEĎ NA'}
            </Mono>
            <Text numberOfLines={2} style={[styles.quoteText, isMine && styles.quoteTextMine]}>
              {message.reply_to.deleted_at
                ? 'Správa bola zmazaná'
                : message.reply_to.body ?? '📷 Fotka'}
            </Text>
          </View>
        ) : message.reply_to_id ? (
          /* We know this is a reply — reply_to_id says so — and we do not have
             the message it answers. That is NOT the same as somebody deleting
             it, and saying "Správa bola zmazaná" here was the app stating
             something untrue: a missing relationship in the database made every
             single reply render as a deletion. A deleted message keeps its row,
             so if the quote were really deleted it would be in the branch
             above, with deleted_at set. */
          <View style={[styles.quote, isMine && styles.quoteMine]}>
            <Text style={[styles.quoteText, isMine && styles.quoteTextMine]}>
              Citovanú správu sa nepodarilo načítať
            </Text>
          </View>
        ) : null}

        {message.attachment_url ? <ChatImage path={message.attachment_url} /> : null}

        {message.body ? (
          <Text style={[styles.bubbleText, isMine && styles.bubbleTextMine]}>{message.body}</Text>
        ) : null}

        {/* Just the time. "ODPOVEDAŤ" used to sit here in every single bubble,
            in capitals, beside the clock — so every message carried a word that
            was not part of it. Replying is a long press now, which is where a
            phone looks for it anyway. */}
        <View style={styles.bubbleFooter}>
          <Mono style={[styles.bubbleTime, isMine && styles.bubbleTimeMine]}>
            {formatMessageTime(message.created_at)}
          </Mono>
        </View>
      </Pressable>
    </View>
  );
}

/** What to call an attachment when there is no text to quote instead. */
function attachmentLabel(path?: string | null): string | undefined {
  if (!path) return undefined;
  return /\.gif($|\?)/i.test(path) ? 'GIF' : '📷 Fotka';
}

/**
 * A chat photo. The message stores an object path in the private bucket, so the
 * URL has to be signed before it can be shown; react-query keeps the signature
 * for the hour it is valid instead of re-signing on every render.
 */
function ChatImage({ path }: { path: string }) {
  const [open, setOpen] = useState(false);
  // A GIF is not a photo and should not be treated as one on screen: `cover`
  // crops, and most GIFs are wider than they are tall, so cropping one to a
  // square throws away the half with the joke in it.
  const isGif = /\.gif($|\?)/i.test(path);
  const signed = useQuery({
    queryKey: ['chat-image', path],
    queryFn: () => signChatImage(path),
    staleTime: 50 * 60 * 1000,
  });

  if (!signed.data) {
    return (
      <View style={[styles.attachment, styles.attachmentPending]}>
        <Mono style={styles.attachmentLabel}>
          {signed.isLoading
            ? (isGif ? '[ načítavam GIF ]' : '[ načítavam fotku ]')
            : (isGif ? '[ GIF nedostupný ]' : '[ fotka nedostupná ]')}
        </Mono>
      </View>
    );
  }

  return (
    <>
      <Pressable
        onPress={() => setOpen(true)}
        accessibilityRole="imagebutton"
        accessibilityLabel={isGif ? 'Otvoriť GIF' : 'Otvoriť fotku'}
      >
        <Image
          source={{ uri: signed.data }}
          style={styles.attachment}
          contentFit={isGif ? 'contain' : 'cover'}
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

  pendingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
  },

  wallpaperLayer: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0 },
  // Dark enough that white text stays white text over any photograph.
  wallpaperScrim: {
    position: 'absolute',
    top: 0, left: 0, right: 0, bottom: 0,
    backgroundColor: 'rgba(10,13,18,0.72)',
  },

  replyStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: colors.border,
    backgroundColor: colors.surface,
  },
  replyBar: { width: 3, alignSelf: 'stretch', borderRadius: 2, backgroundColor: colors.accent },
  replyWho: { color: colors.accentText, fontSize: 9 },
  replyText: { ...typography.caption, color: colors.textSecondary },

  quote: {
    borderLeftWidth: 3,
    borderLeftColor: colors.accent,
    paddingLeft: spacing.sm,
    paddingVertical: 2,
    marginBottom: spacing.xs,
    opacity: 0.9,
  },
  quoteMine: { borderLeftColor: 'rgba(255,255,255,0.6)' },
  quoteWho: { color: colors.accentText, fontSize: 9 },
  quoteWhoMine: { color: 'rgba(255,255,255,0.75)' },
  quoteText: { ...typography.caption, color: colors.textSecondary },
  quoteTextMine: { color: 'rgba(255,255,255,0.8)' },

  bubbleFooter: { flexDirection: 'row', alignItems: 'center', justifyContent: 'flex-end', gap: spacing.md },
  menuRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  menuGlyph: { fontSize: 18, color: colors.textSecondary, width: 24, textAlign: 'center' },
  menuLabel: { ...typography.body, color: colors.text },
  menuDanger: { color: colors.danger },

  replyAction: { color: colors.textTertiary, fontSize: 9 },
  replyActionMine: { color: 'rgba(255,255,255,0.7)' },
  pendingThumb: { width: 48, height: 48, borderRadius: radius.sm, backgroundColor: colors.surface },
  pendingRemove: {
    width: 32, height: 32, borderRadius: 16,
    alignItems: 'center', justifyContent: 'center',
    backgroundColor: colors.surface,
  },
  pendingRemoveGlyph: { ...typography.meta, color: colors.textSecondary },
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
  gifGlyph: { ...typography.monoSm, fontSize: 11, color: colors.textSecondary },
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
