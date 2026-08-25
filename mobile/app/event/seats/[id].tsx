import React, { useState } from 'react';
import { Pressable, StyleSheet, Text, View, useWindowDimensions } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { Image } from 'expo-image';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getSeatMap, holdSeat, releaseSeat, type Section } from '@/api/seating';
import { addToCart } from '@/api/cart';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import {
  Body, Button, Caption, EmptyState, ErrorState, LoadingState, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Picking a place.
 *
 * The plan is a picture the organizer uploaded — a photo of a paper layout is
 * fine, and for a while that is all anyone will have. What matters is the
 * rectangles drawn on it: those are rows in the database, stored as fractions
 * of the image, so re-photographing the plan does not move a single sector.
 *
 * A sector with named seats opens into them; one without is an ordinary ticket
 * type and adds to the basket by count. Both hold stock the same way and for
 * the same fifteen minutes, because a sector *is* a ticket type — which is why
 * the money, the ceiling and the promo split need no special case here.
 */
export default function SeatPickerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { width } = useWindowDimensions();

  const [open, setOpen] = useState<Section | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const seatMap = useQuery({
    queryKey: ['event', id, 'seatmap'],
    queryFn: () => getSeatMap(id!),
    enabled: Boolean(id),
  });

  if (seatMap.isLoading) return <Screen><LoadingState label="Načítavam plán…" /></Screen>;
  if (seatMap.isError) {
    return (
      <Screen>
        <ErrorState message={messageFor(seatMap.error)} onRetry={() => void seatMap.refetch()} />
      </Screen>
    );
  }

  if (!seatMap.data) {
    return (
      <Screen>
        <EmptyState
          emoji="🎫"
          title="Tento event nemá plán"
          body="Vstupenky sa naň predávajú bez výberu miesta."
          actionLabel="Späť na event"
          onAction={() => router.back()}
        />
      </Screen>
    );
  }

  const { map, sections } = seatMap.data;

  // The plan is drawn at whatever width there is; the sectors are fractions of
  // it, so one scale factor positions all of them.
  const planWidth = Math.min(width - spacing.gutter * 2, 720);
  const planHeight = planWidth * (map.image_height / map.image_width);

  const refresh = () => queryClient.invalidateQueries({ queryKey: ['event', id, 'seatmap'] });

  const pick = async (section: Section) => {
    setError(null);
    setNote(null);
    if (section.available === 0) {
      setError(`${section.name} je vypredaný.`);
      return;
    }
    if (section.numbered) { setOpen(section); return; }

    if (!section.ticket_type_id) { setError('Tento sektor zatiaľ nie je v predaji.'); return; }
    setBusy(true);
    try {
      await addToCart(section.ticket_type_id, 1);
      setNote(`${section.name} pridaný do košíka.`);
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const takeSeat = async (seatId: string, free: boolean) => {
    setError(null);
    setNote(null);
    setBusy(true);
    try {
      if (free) {
        const held = await holdSeat(seatId);
        setNote(`Držíme ti ${held.section}, rad ${held.row}, miesto ${held.number} — 15 minút.`);
      } else {
        await releaseSeat(seatId);
      }
      await refresh();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <Text style={styles.title}>{map.name}</Text>
      <Body muted style={styles.intro}>
        Vyber sektor. Pri číslovaných uvidíš aj konkrétne miesta.
      </Body>

      {error ? <Notice tone="danger" title="Nedá sa" body={error} /> : null}
      {note ? <Notice tone="success" title="Hotovo" body={note} /> : null}

      <View style={[styles.plan, { width: planWidth, height: planHeight }]}>
        {map.image_url ? (
          <Image source={{ uri: map.image_url }} style={StyleSheet.absoluteFill} contentFit="contain" />
        ) : (
          <View style={styles.planEmpty}>
            <Caption>Organizátor nenahral obrázok plánu — sektory sú nižšie.</Caption>
          </View>
        )}

        {sections.map((section) => {
          const soldOut = section.available === 0;
          return (
            <Pressable
              key={section.id}
              onPress={() => pick(section)}
              accessibilityRole="button"
              accessibilityLabel={`${section.name}, voľných ${section.available}`}
              style={[
                styles.sector,
                {
                  left: section.x * planWidth,
                  top: section.y * planHeight,
                  width: section.width * planWidth,
                  height: section.height * planHeight,
                  borderColor: soldOut ? colors.border : section.colour,
                  backgroundColor: soldOut ? 'rgba(255,255,255,0.04)' : `${section.colour}33`,
                },
              ]}
            >
              <Text style={styles.sectorName} numberOfLines={1}>{section.name}</Text>
              <Text style={[styles.sectorFree, soldOut && styles.sectorGone]}>
                {soldOut ? 'vypredané' : `${section.available} voľných`}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <SectionHeader title="Sektory" />
      {sections.map((section) => (
        <Pressable key={section.id} style={styles.row} onPress={() => pick(section)} disabled={busy}>
          <View style={[styles.swatch, { backgroundColor: section.colour }]} />
          <View style={styles.flex}>
            <Text style={styles.rowName}>{section.name}</Text>
            <Caption>
              {section.available === 0
                ? 'vypredané'
                : `${section.available} voľných${section.numbered ? ' · číslované' : ''}`}
            </Caption>
          </View>
          {section.price_cents !== null ? (
            <Text style={styles.price}>{formatMoney(section.price_cents, 'EUR')}</Text>
          ) : null}
        </Pressable>
      ))}

      {open ? (
        <>
          <SectionHeader title={`${open.name} · miesta`} />
          <Caption style={styles.legend}>
            Klepni na voľné miesto a držíme ti ho 15 minút. Klepnutím na svoje ho pustíš.
          </Caption>
          <View style={styles.seats}>
            {open.seats.map((seat) => (
              <Pressable
                key={seat.id}
                disabled={busy || !seat.free}
                onPress={() => takeSeat(seat.id, seat.free)}
                style={[styles.seat, !seat.free && styles.seatTaken]}
              >
                <Text style={[styles.seatLabel, !seat.free && styles.seatLabelTaken]}>
                  {seat.row}{seat.number}
                </Text>
              </Pressable>
            ))}
          </View>
          <Button title="Zavrieť sektor" variant="ghost" onPress={() => setOpen(null)} />
        </>
      ) : null}

      <Button title="Do košíka" onPress={() => router.push('/cart')} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text },
  intro: { marginTop: spacing.xs, marginBottom: spacing.lg },
  flex: { flex: 1, minWidth: 0 },

  plan: {
    alignSelf: 'center',
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
    overflow: 'hidden',
    marginBottom: spacing.lg,
  },
  planEmpty: { ...StyleSheet.absoluteFill as object, alignItems: 'center', justifyContent: 'center', padding: spacing.lg },

  sector: {
    position: 'absolute',
    borderWidth: 2,
    borderRadius: radius.sm,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 2,
  },
  sectorName: { color: colors.text, fontWeight: '700', fontSize: 12 },
  sectorFree: { color: colors.text, fontSize: 10, opacity: 0.85 },
  sectorGone: { textDecorationLine: 'line-through' },

  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    marginBottom: spacing.sm,
  },
  swatch: { width: 14, height: 14, borderRadius: 4 },
  rowName: { ...typography.bodyStrong, color: colors.text },
  price: { ...typography.bodyStrong, color: colors.accent },

  legend: { marginBottom: spacing.sm },
  seats: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginBottom: spacing.md },
  seat: {
    minWidth: 44,
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderRadius: radius.sm,
    backgroundColor: colors.accentSoft,
    borderWidth: 1,
    borderColor: colors.accent,
    alignItems: 'center',
  },
  seatTaken: { backgroundColor: colors.surfaceElevated, borderColor: colors.border, opacity: 0.55 },
  seatLabel: { color: colors.accent, fontWeight: '700', fontSize: 13 },
  seatLabelTaken: { color: colors.textSecondary, textDecorationLine: 'line-through' },
});
