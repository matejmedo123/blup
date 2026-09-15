import React, { useState } from 'react';
import { Alert, Pressable, StyleSheet, Text, View } from 'react-native';
import { Image } from 'expo-image';
import { useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { getMyOrganizations } from '@/api/organizations';
import { getEvent, getEventImages, setEventCover } from '@/api/events';
import { ImageLightbox } from '@/components/ImageLightbox';
import {
  deleteEventGalleryImage, pickImage, uploadEventGalleryImage,
} from '@/storage/uploads';
import { messageFor } from '@/lib/errors';
import { GradientCover } from '@/components/GradientCover';
import {
  Body, Button, Caption, EmptyState, ErrorState, LoadingState, Mono, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Photos of an event.
 *
 * The cover is what the card in the feed shows, so promoting a gallery photo to
 * cover changes how the event looks everywhere. Uploads go to the event-images
 * bucket under the uploader's own folder — the storage policy derives ownership
 * from that path, so nobody can write into someone else's event folder.
 */
export default function EventPhotosScreen() {
  const [viewing, setViewing] = useState<string | null>(null);
  const { id } = useLocalSearchParams<{ id: string }>();
  const { profile } = useAuth();
  const queryClient = useQueryClient();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: () => getEvent(id!),
    enabled: Boolean(id),
  });

  const images = useQuery({
    queryKey: ['event', id, 'images'],
    queryFn: () => getEventImages(id!),
    enabled: Boolean(id),
  });

  const myOrgs = useQuery({
    queryKey: ['organizations', 'mine'],
    queryFn: getMyOrganizations,
    enabled: Boolean(profile),
  });
  const myOrgIds = (myOrgs.data ?? [])
    .filter((org) => ['owner', 'admin', 'event_manager'].includes(org.my_role ?? ''))
    .map((org) => org.id);

  // The database lets an organization's owners, admins and event managers write
  // here, and the screen used to be narrower than that — somebody running the
  // organization but not the creator of the event saw a read-only gallery.
  const canEdit = Boolean(
    event.data && profile && (
      event.data.creator_id === profile.id
      || (event.data.organization_id != null && myOrgIds.includes(event.data.organization_id))
    ),
  );

  const refresh = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['event', id] }),
      queryClient.invalidateQueries({ queryKey: ['event', id, 'images'] }),
      queryClient.invalidateQueries({ queryKey: ['events'] }),
    ]);
  };

  const add = async (source: 'library' | 'camera') => {
    if (!id) return;
    setError(null);
    try {
      const picked = await pickImage({ source, aspect: [4, 3] });
      if (!picked) return;

      setBusy(true);
      const url = await uploadEventGalleryImage(picked.uri, id);

      // The first photo becomes the cover automatically — an event with photos
      // should never still be showing the placeholder card.
      if (!event.data?.cover_image_url) await setEventCover(id, url);

      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const makeCover = async (url: string) => {
    if (!id) return;
    setError(null);
    setBusy(true);
    try {
      await setEventCover(id, url);
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = (imageId: string, url: string) => {
    Alert.alert('Zmazať fotku?', 'Odstráni sa z galérie aj z úložiska.', [
      { text: 'Nechať', style: 'cancel' },
      {
        text: 'Zmazať',
        style: 'destructive',
        onPress: async () => {
          setError(null);
          setBusy(true);
          try {
            await deleteEventGalleryImage(imageId);
            // Do not leave the card pointing at a file that no longer exists.
            if (event.data?.cover_image_url === url) {
              const rest = (images.data ?? []).filter((image) => image.id !== imageId);
              await setEventCover(id!, rest[0]?.url ?? null);
            }
            await refresh();
          } catch (caught) {
            setError(messageFor(caught));
          } finally {
            setBusy(false);
          }
        },
      },
    ]);
  };

  if (event.isLoading || images.isLoading) return <Screen><LoadingState /></Screen>;

  if (event.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(event.error)} onRetry={() => void event.refetch()} />
      </Screen>
    );
  }

  const gallery = images.data ?? [];
  const hasCover = Boolean(event.data?.cover_image_url);

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}

      {/* The cover is required when an event is created, so having one is the
          normal case and does not need a section of its own — a thumbnail is
          enough to confirm it. Only an event from before that rule, or one whose
          cover was deleted, gets the full treatment and the explanation. */}
      {hasCover ? (
        <View style={styles.coverRow}>
          <GradientCover
            uri={event.data?.cover_image_url}
            category={event.data?.category}
            height={64}
            style={styles.coverThumb}
          />
          <View style={styles.flex}>
            <Caption>Titulná fotka</Caption>
            <Body muted>Vymeníš ju cez „Dať na titulku“ pri ktorejkoľvek fotke nižšie.</Body>
          </View>
        </View>
      ) : (
        <>
          <SectionHeader title="Titulná fotka" />
          <Body muted style={styles.intro}>
            Toto je obrázok, ktorý ľudia uvidia na karte eventu vo feede, na mape aj v hľadaní.
          </Body>

          <GradientCover
            uri={null}
            category={event.data?.category}
            height={200}
            style={styles.cover}
          >
            <Mono style={styles.coverHint}>[ zatiaľ bez fotky · karta má gradient ]</Mono>
          </GradientCover>
        </>
      )}

      {canEdit ? (
        <>
          <SectionHeader title={hasCover ? 'Pridaj fotky' : 'Pridaj prvú fotku'} />
          <Body muted style={styles.intro}>
            {hasCover
              ? 'Fotky z miesta alebo z minulých ročníkov. Ktorúkoľvek z nich vieš dať na titulku.'
              : 'Prvú nahratú fotku vieš hneď dať na titulku.'}
          </Body>
          <View style={styles.actions}>
            <Button
              title="Nahrať z galérie"
              variant="secondary"
              onPress={() => add('library')}
              loading={busy}
              style={styles.flex}
            />
            <Button
              title="Odfotiť"
              variant="secondary"
              onPress={() => add('camera')}
              disabled={busy}
              style={styles.flex}
            />
          </View>
        </>
      ) : null}

      <SectionHeader title={`Galéria (${gallery.length})`} />

      {gallery.length === 0 ? (
        <EmptyState
          emoji="📷"
          title="Zatiaľ žiadne fotky"
          body={
            canEdit
              ? 'Pridaj fotky z miesta alebo z minulých ročníkov — event s fotkami dostane výrazne viac kliknutí.'
              : 'Organizátor sem zatiaľ nič nenahral.'
          }
        />
      ) : (
        <View style={styles.grid}>
          {gallery.map((image) => {
            const isCover = event.data?.cover_image_url === image.url;

            return (
              <View key={image.id} style={[styles.tile, isCover && styles.tileCover]}>
                {/* The tile is a column — image, then the owner's buttons — so
                    the tap target is the image itself, not the whole tile. */}
                <Pressable
                  onPress={() => setViewing(image.url)}
                  accessibilityRole="imagebutton"
                  accessibilityLabel="Otvoriť fotku"
                >
                  <Image source={{ uri: image.url }} style={styles.tileImage} contentFit="cover" />
                </Pressable>

                {isCover ? (
                  <View style={styles.coverBadge}>
                    <Mono style={styles.coverBadgeText}>TITULNÁ</Mono>
                  </View>
                ) : null}

                {canEdit ? (
                  <View style={styles.tileActions}>
                    {!isCover ? (
                      <Pressable
                        onPress={() => makeCover(image.url)}
                        disabled={busy}
                        style={styles.tileButton}
                      >
                        <Text style={styles.tileButtonText}>Dať na titulku</Text>
                      </Pressable>
                    ) : null}
                    <Pressable
                      onPress={() => remove(image.id, image.url)}
                      disabled={busy}
                      style={[styles.tileButton, styles.tileButtonDanger]}
                    >
                      <Text style={styles.tileButtonText}>✕</Text>
                    </Pressable>
                  </View>
                ) : null}
              </View>
            );
          })}
        </View>
      )}

      {canEdit ? (
        <Body muted style={styles.footnote}>
          Fotky sa nahrávajú do tvojho storage bucketu a komprimujú sa na 1600 px, aby sa karta
          načítala rýchlo aj na mobilných dátach.
        </Body>
      ) : null}
    
      <ImageLightbox uri={viewing} onClose={() => setViewing(null)} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  coverRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  coverThumb: { width: 110, borderRadius: radius.md, overflow: 'hidden' },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  intro: { marginBottom: spacing.md },
  cover: { borderRadius: radius.lg, marginBottom: spacing.md },
  coverHint: { color: 'rgba(255,255,255,0.85)', padding: spacing.md },

  actions: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },

  grid: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  tile: {
    width: '47.5%',
    flexGrow: 1,
    borderRadius: radius.lg,
    overflow: 'hidden',
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  tileCover: { borderColor: colors.accent, borderWidth: 2 },
  tileImage: { width: '100%', height: 130, backgroundColor: colors.surfaceElevated },

  coverBadge: {
    position: 'absolute',
    top: spacing.sm,
    left: spacing.sm,
    paddingHorizontal: spacing.sm,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  coverBadgeText: { color: '#FFFFFF', fontSize: 9 },

  tileActions: { flexDirection: 'row', gap: spacing.xs, padding: spacing.sm },
  tileButton: {
    flex: 1,
    paddingVertical: 7,
    borderRadius: radius.sm,
    backgroundColor: colors.surfaceElevated,
    alignItems: 'center',
  },
  tileButtonDanger: { flex: 0, paddingHorizontal: spacing.md },
  tileButtonText: { ...typography.chip, fontSize: 11, color: colors.textSecondary },

  footnote: { marginTop: spacing.xl, ...typography.caption },
});
