import React, { useRef, useState } from 'react';
import {
  Pressable, StyleSheet, Text, View, useWindowDimensions,
  type GestureResponderEvent,
} from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getEvent, updateEvent } from '@/api/events';
import { getMyOrganizations } from '@/api/organizations';
import {
  createSection, createVenueMap, deleteSection, generateSeats, getVenueSections, updateVenueMap,
} from '@/api/venue';
import { pickImage, uploadVenuePlan } from '@/storage/uploads';
import { messageFor } from '@/lib/errors';
import {
  Body, Button, Caption, Chip, Input, LoadingState, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Drawing the sectors.
 *
 * Drag a rectangle on the plan, name it, point it at a ticket type. The
 * rectangle is stored as fractions of the image, so the organizer can replace a
 * blurry photo of the plan with a better one later and nothing moves.
 *
 * The drag uses React Native's own responder system rather than DOM pointer
 * events, so the same code draws on a laptop with a mouse and on a phone with a
 * finger — this is a job people will do on whichever they have open.
 */
const PALETTE = ['#0080FF', '#FF4D8D', '#22C55E', '#FF8A3D', '#A855F7', '#22D3EE'];

export default function PlanEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { width } = useWindowDimensions();

  const [name, setName] = useState('');
  const [colour, setColour] = useState(PALETTE[0]);
  const [ticketTypeId, setTicketTypeId] = useState<string | null>(null);
  const [rows, setRows] = useState('');
  const [perRow, setPerRow] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  // The rectangle being dragged, in plan pixels. Null when not dragging.
  const [draft, setDraft] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const origin = useRef<{ x: number; y: number } | null>(null);

  const event = useQuery({
    queryKey: ['event', id],
    queryFn: () => getEvent(id!),
    enabled: Boolean(id),
  });

  const organizations = useQuery({ queryKey: ['organizations', 'mine'], queryFn: getMyOrganizations });

  const mapId = event.data?.venue_map_id ?? null;

  const sections = useQuery({
    queryKey: ['venue', mapId, 'sections'],
    queryFn: () => getVenueSections(mapId!),
    enabled: Boolean(mapId),
  });

  if (event.isLoading || organizations.isLoading) return <Screen><LoadingState /></Screen>;

  const organization = organizations.data?.[0];
  const ticketTypes = event.data?.ticket_types ?? [];

  if (!organization) {
    return (
      <Screen>
        <Notice
          tone="warning"
          title="Najprv organizácia"
          body="Plán sály patrí organizácii, aby si ho vedel použiť na viacerých eventoch."
        />
      </Screen>
    );
  }

  const planWidth = Math.min(width - spacing.gutter * 2, 720);
  const ratio = event.data && mapId ? 0.7 : 0.7;
  const planHeight = planWidth * ratio;

  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['event', id] });
    await queryClient.invalidateQueries({ queryKey: ['venue'] });
  };

  /** Creates the map on first use, so the organizer never sets one up separately. */
  const ensureMap = async (): Promise<string> => {
    if (mapId) return mapId;
    const created = await createVenueMap({
      organizationId: organization.id,
      name: event.data?.venue_name || event.data?.title || 'Plán sály',
    });
    await updateEvent(id!, { venueMapId: created.id });
    await refresh();
    return created.id;
  };

  const choosePlan = async () => {
    setError(null);
    try {
      const picked = await pickImage({ source: 'library' });
      if (!picked) return;
      setBusy(true);
      const target = await ensureMap();
      const uploaded = await uploadVenuePlan(picked.uri, organization.id);
      await updateVenueMap(target, {
        image_url: uploaded.url,
        image_width: uploaded.width,
        image_height: uploaded.height,
      });
      await refresh();
      setNote('Plán nahratý. Teraz naň ťahaním vyznač sektory.');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  // --- drawing --------------------------------------------------------------
  const onStart = (e: GestureResponderEvent) => {
    const { locationX, locationY } = e.nativeEvent;
    origin.current = { x: locationX, y: locationY };
    setDraft({ x: locationX, y: locationY, w: 0, h: 0 });
    return true;
  };

  const onMove = (e: GestureResponderEvent) => {
    if (!origin.current) return;
    const { locationX, locationY } = e.nativeEvent;
    const start = origin.current;
    // Dragging up or left is as valid as down or right, so the rectangle is
    // normalised rather than requiring one direction.
    setDraft({
      x: Math.min(start.x, locationX),
      y: Math.min(start.y, locationY),
      w: Math.abs(locationX - start.x),
      h: Math.abs(locationY - start.y),
    });
  };

  const onEnd = () => {
    origin.current = null;
    // A tap is not a rectangle. Below this it was almost certainly a misfire.
    if (draft && (draft.w < 18 || draft.h < 18)) setDraft(null);
  };

  const saveSector = async () => {
    setError(null);
    setNote(null);

    if (!draft) { setError('Najprv na pláne ťahaním vyznač obdĺžnik.'); return; }
    if (name.trim().length < 1) { setError('Pomenuj sektor.'); return; }

    setBusy(true);
    try {
      const target = await ensureMap();
      const created = await createSection({
        venueMapId: target,
        ticketTypeId,
        name,
        colour,
        x: draft.x / planWidth,
        y: draft.y / planHeight,
        width: draft.w / planWidth,
        height: draft.h / planHeight,
        sortOrder: (sections.data ?? []).length,
      });

      const r = Number(rows);
      const p = Number(perRow);
      if (Number.isInteger(r) && Number.isInteger(p) && r > 0 && p > 0) {
        const made = await generateSeats({ sectionId: created.id, rows: r, perRow: p });
        setNote(`${name} pridaný — ${made} miest.`);
      } else {
        setNote(`${name} pridaný — predáva sa na počet.`);
      }

      setDraft(null);
      setName('');
      setRows('');
      setPerRow('');
      await refresh();
      await sections.refetch();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const remove = async (sectionId: string) => {
    setBusy(true);
    try {
      await deleteSection(sectionId);
      await sections.refetch();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const existing = sections.data ?? [];

  return (
    <Screen scroll>
      <Text style={styles.title}>Plán sály</Text>
      <Body muted style={styles.intro}>
        Nahraj obrázok plánu — stačí odfotený papier — a ťahaním naň vyznač sektory.
        Sektor bez miest sa predáva na počet, sektor s radmi po jednotlivých sedadlách.
      </Body>

      {error ? <Notice tone="danger" title="Nedá sa" body={error} /> : null}
      {note ? <Notice tone="success" title="Hotovo" body={note} /> : null}

      <Button
        title={event.data?.venue_map_id ? 'Vymeniť obrázok plánu' : 'Nahrať obrázok plánu'}
        variant="secondary"
        onPress={choosePlan}
        loading={busy}
      />

      <View
        style={[styles.plan, { width: planWidth, height: planHeight }]}
        onStartShouldSetResponder={onStart}
        onMoveShouldSetResponder={() => true}
        onResponderMove={onMove}
        onResponderRelease={onEnd}
      >
        <PlanImage eventId={id!} />

        {existing.map((section) => (
          <View
            key={section.id}
            pointerEvents="none"
            style={[styles.sector, {
              left: section.x * planWidth,
              top: section.y * planHeight,
              width: section.width * planWidth,
              height: section.height * planHeight,
              borderColor: section.colour,
              backgroundColor: `${section.colour}2E`,
            }]}
          >
            <Text style={styles.sectorName} numberOfLines={1}>{section.name}</Text>
          </View>
        ))}

        {draft ? (
          <View
            pointerEvents="none"
            style={[styles.draft, {
              left: draft.x, top: draft.y, width: draft.w, height: draft.h, borderColor: colour,
            }]}
          />
        ) : null}
      </View>

      <Caption style={styles.hint}>
        {draft
          ? 'Obdĺžnik je vyznačený. Pomenuj ho nižšie a ulož.'
          : 'Ťahaj po pláne a vyznač obdĺžnik sektora.'}
      </Caption>

      <SectionHeader title="Nový sektor" />
      <Input label="Názov" value={name} onChangeText={setName} placeholder="Napr. Tribúna A" editable={!busy} />

      <Caption style={styles.label}>Farba</Caption>
      <View style={styles.palette}>
        {PALETTE.map((c) => (
          <Pressable
            key={c}
            onPress={() => setColour(c)}
            style={[styles.swatch, { backgroundColor: c }, colour === c && styles.swatchOn]}
          />
        ))}
      </View>

      <Caption style={styles.label}>Ktorý typ vstupenky sa v ňom predáva</Caption>
      {ticketTypes.length === 0 ? (
        <Notice
          tone="warning"
          title="Event nemá typy vstupeniek"
          body="Sektor predáva niektorý z nich, takže ich najprv doplň v úprave eventu."
          actionLabel="Upraviť event"
          onAction={() => router.push(`/event/edit/${id}`)}
        />
      ) : (
        <View style={styles.chips}>
          {ticketTypes.map((type) => (
            <Chip
              key={type.id}
              label={type.name}
              selected={ticketTypeId === type.id}
              onPress={() => setTicketTypeId(ticketTypeId === type.id ? null : type.id)}
            />
          ))}
        </View>
      )}

      <Caption style={styles.label}>Číslované sedenie (nepovinné)</Caption>
      <View style={styles.seatRow}>
        <View style={styles.flex}>
          <Input label="Radov" value={rows} onChangeText={setRows} placeholder="10" keyboardType="number-pad" editable={!busy} />
        </View>
        <View style={styles.flex}>
          <Input label="Miest v rade" value={perRow} onChangeText={setPerRow} placeholder="20" keyboardType="number-pad" editable={!busy} />
        </View>
      </View>
      <Caption style={styles.hint}>
        Nechaj prázdne a sektor sa bude predávať na počet, bez konkrétnych miest.
      </Caption>

      <Button title="Uložiť sektor" onPress={saveSector} loading={busy} disabled={!draft} />

      {existing.length > 0 ? (
        <>
          <SectionHeader title={`Sektory · ${existing.length}`} />
          {existing.map((section) => (
            <View key={section.id} style={styles.row}>
              <View style={[styles.dot, { backgroundColor: section.colour }]} />
              <View style={styles.flex}>
                <Text style={styles.rowName}>{section.name}</Text>
                <Caption>{section.numbered ? 'číslované sedenie' : 'predaj na počet'}</Caption>
              </View>
              <Button title="Zmazať" variant="ghost" compact onPress={() => remove(section.id)} disabled={busy} />
            </View>
          ))}
        </>
      ) : null}
    </Screen>
  );
}

/** The uploaded plan, or an honest placeholder before there is one. */
function PlanImage({ eventId }: { eventId: string }) {
  const event = useQuery({ queryKey: ['event', eventId], queryFn: () => getEvent(eventId) });
  const maps = useQuery({
    queryKey: ['venue', event.data?.venue_map_id, 'image'],
    queryFn: async () => {
      const { supabase } = await import('@/lib/supabase');
      const { data } = await supabase
        .from('venue_maps').select('image_url').eq('id', event.data!.venue_map_id!).maybeSingle();
      return (data?.image_url as string) ?? null;
    },
    enabled: Boolean(event.data?.venue_map_id),
  });

  if (maps.data) {
    return <Image source={{ uri: maps.data }} style={StyleSheet.absoluteFill} contentFit="contain" />;
  }
  return (
    <View style={styles.planEmpty} pointerEvents="none">
      <Caption>Zatiaľ bez obrázka — sektory sa dajú vyznačiť aj na prázdno.</Caption>
    </View>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text },
  intro: { marginTop: spacing.xs, marginBottom: spacing.lg },
  flex: { flex: 1, minWidth: 0 },
  label: { marginTop: spacing.md, marginBottom: spacing.xs },
  hint: { marginTop: spacing.xs, marginBottom: spacing.md },

  plan: {
    alignSelf: 'center',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    marginTop: spacing.md,
  },
  planEmpty: { ...StyleSheet.absoluteFill as object, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },

  sector: { position: 'absolute', borderWidth: 2, borderRadius: radius.sm, alignItems: 'center', justifyContent: 'center' },
  sectorName: { color: colors.text, fontWeight: '700', fontSize: 12 },
  draft: { position: 'absolute', borderWidth: 2, borderStyle: 'dashed', borderRadius: radius.sm },

  palette: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.sm },
  swatch: { width: 30, height: 30, borderRadius: 15, borderWidth: 2, borderColor: 'transparent' },
  swatchOn: { borderColor: colors.text },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.sm },
  seatRow: { flexDirection: 'row', gap: spacing.sm },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.md,
    padding: spacing.md, borderRadius: radius.md,
    backgroundColor: colors.surface, marginBottom: spacing.sm,
  },
  dot: { width: 14, height: 14, borderRadius: 7 },
  rowName: { ...typography.bodyStrong, color: colors.text },
});
