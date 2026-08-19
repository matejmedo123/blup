import React, { useState } from 'react';
import { FlatList, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { router, useLocalSearchParams, useNavigation } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import {
  createPost, deletePost, getCommunity, getCommunityMembers, getPosts, isCommunityMember,
  joinCommunity, leaveCommunity, togglePostLike, type CommunityPost,
} from '@/api/communities';
import { pickImage, uploadCommunityImage } from '@/storage/uploads';
import { messageFor } from '@/lib/errors';
import { formatCount, formatRelative } from '@/lib/format';
import { GradientCover } from '@/components/GradientCover';
import {
  Avatar, Body, Button, Caption, ErrorState, Input, LoadingState, Mono, Notice, Screen,
  SectionHeader,
} from '@/components/ui';
import { colors, labelFor, radius, spacing, typography } from '@/theme';

/**
 * A community and its feed — "Community Feed: fotky, tipy, momenty od ľudí
 * s rovnakými záujmami". Posting is for members; reading follows the RLS
 * policy on the community.
 */
export default function CommunityScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const navigation = useNavigation();
  const queryClient = useQueryClient();
  const { profile } = useAuth();

  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const community = useQuery({
    queryKey: ['community', id],
    queryFn: () => getCommunity(id!),
    enabled: Boolean(id),
  });

  const member = useQuery({
    queryKey: ['community', id, 'member'],
    queryFn: () => isCommunityMember(id!),
    enabled: Boolean(id),
  });

  const members = useQuery({
    queryKey: ['community', id, 'members'],
    queryFn: () => getCommunityMembers(id!),
    enabled: Boolean(id),
  });

  const posts = useQuery({
    queryKey: ['community', id, 'posts'],
    queryFn: () => getPosts({ communityId: id! }),
    enabled: Boolean(id),
  });

  React.useEffect(() => {
    if (community.data?.name) navigation.setOptions({ title: community.data.name });
  }, [navigation, community.data?.name]);

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['community', id] }),
      queryClient.invalidateQueries({ queryKey: ['communities'] }),
    ]);
  };

  const toggleMembership = async () => {
    setError(null);
    setBusy(true);
    try {
      if (member.data) await leaveCommunity(id!);
      else await joinCommunity(id!);
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const post = async (imageUrl?: string | null) => {
    const body = draft.trim();
    if (!body && !imageUrl) return;

    setError(null);
    setBusy(true);
    try {
      await createPost({ body: body || '📷', communityId: id!, imageUrl });
      setDraft('');
      await queryClient.invalidateQueries({ queryKey: ['community', id, 'posts'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const attach = async () => {
    setError(null);
    try {
      const picked = await pickImage({ source: 'library', aspect: [4, 3] });
      if (!picked) return;
      setBusy(true);
      const url = await uploadCommunityImage(picked.uri, id!);
      await post(url);
    } catch (caught) {
      setError(messageFor(caught));
      setBusy(false);
    }
  };

  const like = async (item: CommunityPost) => {
    try {
      await togglePostLike(item.id, Boolean(item.liked_by_me));
      await queryClient.invalidateQueries({ queryKey: ['community', id, 'posts'] });
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const remove = async (postId: string) => {
    try {
      await deletePost(postId);
      await queryClient.invalidateQueries({ queryKey: ['community', id, 'posts'] });
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  if (community.isLoading) return <Screen><LoadingState /></Screen>;

  if (community.isError || !community.data) {
    return (
      <Screen>
        <ErrorState
          message={community.error ? messageFor(community.error) : 'Komunita sa nenašla.'}
          onRetry={() => void community.refetch()}
        />
      </Screen>
    );
  }

  const data = community.data;

  return (
    <Screen contentStyle={styles.container}>
      <FlatList
        data={posts.data ?? []}
        keyExtractor={(item) => item.id}
        contentContainerStyle={styles.list}
        showsVerticalScrollIndicator={false}
        refreshing={posts.isRefetching}
        onRefresh={() => void posts.refetch()}
        ListHeaderComponent={
          <View>
            <GradientCover
              uri={data.cover_url}
              category={data.category}
              height={150}
              style={styles.cover}
              showPlaceholderLabel={false}
            >
              <View style={styles.coverBody}>
                <Text style={styles.name}>{data.name}</Text>
                <Mono style={styles.meta}>
                  {labelFor(data.category)} · {formatCount(data.member_count)} členov
                  {data.city ? ` · ${data.city}` : ''}
                </Mono>
              </View>
            </GradientCover>

            {error ? <Notice tone="danger" title="Niečo sa pokazilo" body={error} /> : null}

            {data.description ? <Body style={styles.description}>{data.description}</Body> : null}

            <Button
              title={member.data ? 'Opustiť komunitu' : 'Pridať sa'}
              variant={member.data ? 'ghost' : 'primary'}
              onPress={toggleMembership}
              loading={busy}
            />

            {(members.data ?? []).length > 0 ? (
              <>
                <SectionHeader title="Členovia" />
                <FlatList
                  horizontal
                  data={members.data ?? []}
                  keyExtractor={(item, index) => item.profile?.id ?? String(index)}
                  showsHorizontalScrollIndicator={false}
                  contentContainerStyle={styles.memberRow}
                  renderItem={({ item }) => {
                    const person = item.profile;
                    if (!person) return null;
                    return (
                      <Pressable
                        style={styles.member}
                        onPress={() => router.push(`/user/${person.id}`)}
                      >
                        <Avatar url={person.avatar_url} name={person.display_name} size={48} />
                        <Caption numberOfLines={1} style={styles.memberName}>
                          {person.display_name?.split(' ')[0] ?? '—'}
                        </Caption>
                      </Pressable>
                    );
                  }}
                />
              </>
            ) : null}

            <SectionHeader title="Feed" />

            {member.data ? (
              <View style={styles.composer}>
                <Input
                  value={draft}
                  onChangeText={setDraft}
                  placeholder="Podeľ sa o tip, fotku alebo moment…"
                  multiline
                  maxLength={2000}
                  style={styles.composerInput}
                />
                <View style={styles.composerActions}>
                  <Button title="＋ Fotka" variant="ghost" compact onPress={attach} disabled={busy} />
                  <Button
                    title="Zdieľať"
                    compact
                    onPress={() => post()}
                    loading={busy}
                    disabled={!draft.trim()}
                  />
                </View>
              </View>
            ) : (
              <Body muted style={styles.joinHint}>
                Pridaj sa do komunity, aby si mohol písať.
              </Body>
            )}
          </View>
        }
        renderItem={({ item }) => (
          <View style={styles.post}>
            <Pressable
              style={styles.postHeader}
              onPress={() => item.author && router.push(`/user/${item.author.id}`)}
            >
              <Avatar url={item.author?.avatar_url} name={item.author?.display_name} size={38} />
              <View style={styles.flex}>
                <Text style={styles.postAuthor}>
                  {item.author?.display_name ?? item.author?.username ?? 'Niekto'}
                </Text>
                <Mono style={styles.postTime}>{formatRelative(item.created_at)}</Mono>
              </View>
              {item.author_id === profile?.id ? (
                <Pressable onPress={() => remove(item.id)} hitSlop={10}>
                  <Text style={styles.postDelete}>✕</Text>
                </Pressable>
              ) : null}
            </Pressable>

            {item.image_url ? (
              <Image source={{ uri: item.image_url }} style={styles.postImage} contentFit="cover" />
            ) : null}

            <Body style={styles.postBody}>{item.body}</Body>

            <Pressable style={styles.postFooter} onPress={() => like(item)}>
              <Text style={[styles.likeGlyph, item.liked_by_me && styles.likeGlyphActive]}>
                {item.liked_by_me ? '♥' : '♡'}
              </Text>
              <Mono style={styles.postTime}>{formatCount(item.like_count)}</Mono>
            </Pressable>
          </View>
        )}
        ListEmptyComponent={
          <Body muted style={styles.empty}>
            Zatiaľ tu nikto nič nezdieľal. Buď prvý.
          </Body>
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  container: { padding: 0 },
  flex: { flex: 1 },

  list: { padding: spacing.lg, paddingBottom: spacing.xxxl },
  cover: { borderRadius: radius.lg, marginBottom: spacing.md, justifyContent: 'flex-end' },
  coverBody: { padding: spacing.md },
  name: { ...typography.title, color: '#FFFFFF' },
  meta: { color: 'rgba(255,255,255,0.85)', marginTop: 2 },
  description: { marginBottom: spacing.md },

  memberRow: { gap: spacing.md, paddingVertical: spacing.xs },
  member: { alignItems: 'center', width: 60, gap: 4 },
  memberName: { textAlign: 'center' },

  composer: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  composerInput: { marginBottom: spacing.sm, minHeight: 70, textAlignVertical: 'top' },
  composerActions: { flexDirection: 'row', justifyContent: 'space-between', gap: spacing.sm },
  joinHint: { marginBottom: spacing.md },

  post: {
    padding: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
    gap: spacing.sm,
  },
  postHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  postAuthor: { ...typography.bodyStrong, color: colors.text },
  postTime: { color: colors.textTertiary },
  postDelete: { fontSize: 15, color: colors.textTertiary },
  postImage: {
    width: '100%',
    height: 190,
    borderRadius: radius.md,
    backgroundColor: colors.surfaceElevated,
  },
  postBody: { color: colors.text },
  postFooter: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  likeGlyph: { fontSize: 17, color: colors.textTertiary },
  likeGlyphActive: { color: colors.danger },

  empty: { textAlign: 'center', paddingVertical: spacing.xl },
});
