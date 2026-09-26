import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { router, useLocalSearchParams } from 'expo-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { deliverResaleTicket, type ResaleOrder } from '@/api/resale';
import { pickImage, uploadResaleTicket } from '@/storage/uploads';
import { supabase } from '@/lib/supabase';
import {
  Button, Caption, Input, LoadingState, Notice, Screen, SectionHeader, Title,
} from '@/components/ui';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import { colors, radius, spacing, typography } from '@/theme';
import { CARD_MAX } from '@/hooks/useLayout';

/**
 * Doručenie vstupenky, ktorá nie je z BLUPu.
 *
 * Naša vstupenka sa prevedie sama v sekunde, keď platba dorazí — táto
 * obrazovka je len pre tie odinakiaľ, kde prevod spraviť nevieme a musí ho
 * spraviť človek.
 *
 * Dve cesty a obe sú skutočné, nie dekorácia:
 *
 *   súbor      PDF alebo fotka ide do súkromného úložiska. Kupujúci ju uvidí
 *              cez podpísanú adresu, ktorá platí pár minút; verejnú adresu
 *              tento bucket nemá.
 *
 *   prevod     keď sa vstupenka prevádza v appke pôvodnej platformy. Ukladá sa
 *              len poznámka o tom, čo predajca spravil — žiadne prihlasovacie
 *              údaje a žiadne odkazy na cudzie účty.
 *
 * Doručením sa peniaze NEUVOĽNIA. Uvoľní ich až potvrdenie kupujúceho a
 * uplynutie eventu; toto je jediný poctivý postup pri vstupenke, ktorej
 * pravosť overiť nevieme.
 */
export default function DeliverTicketScreen() {
  const { order: orderId } = useLocalSearchParams<{ order: string }>();
  const queryClient = useQueryClient();

  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const order = useQuery({
    queryKey: ['resale', 'order', orderId],
    queryFn: async () => {
      const { data, error: caught } = await supabase
        .from('resale_orders')
        .select('*')
        .eq('id', orderId!)
        .single();
      if (caught) throw caught;
      return data as ResaleOrder;
    },
    enabled: Boolean(orderId),
  });

  if (order.isLoading) return <Screen><LoadingState label="Načítavam…" /></Screen>;

  const o = order.data;

  if (!o) {
    return (
      <Screen scroll>
        <Notice tone="danger" title="Objednávka sa nenašla" body="Skús to prosím znova." />
      </Screen>
    );
  }

  if (o.source === 'blup') {
    return (
      <Screen scroll>
        <Title>Nič doručovať netreba</Title>
        <Notice
          tone="success"
          title="Vstupenka je už u kupujúceho"
          body="Vydali sme ju my, takže sme ju previedli hneď po zaplatení a tvoj pôvodný kód prestal platiť."
        />
        <Button title="Späť" variant="secondary" onPress={() => router.back()} />
      </Screen>
    );
  }

  const sendFile = async () => {
    setError(null);
    setBusy(true);
    try {
      const picked = await pickImage({ source: 'library' });
      if (!picked) { setBusy(false); return; }
      const path = await uploadResaleTicket(o.id, {
        uri: picked.uri,
        mimeType: picked.mimeType,
      });
      await deliverResaleTicket(o.id, { filePath: path });
      await queryClient.invalidateQueries({ queryKey: ['resale'] });
      setDone(true);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const sendNote = async () => {
    setError(null);
    if (!note.trim()) { setError('Napíš kupujúcemu, čo si spravil.'); return; }
    setBusy(true);
    try {
      await deliverResaleTicket(o.id, { note: note.trim() });
      await queryClient.invalidateQueries({ queryKey: ['resale'] });
      setDone(true);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  if (done) {
    return (
      <Screen scroll>
        <Title>Odoslané</Title>
        <Notice
          tone="success"
          title="Kupujúci má vstupenku"
          body="Dali sme mu vedieť. Peniaze sa uvoľnia po evente a keď potvrdí, že fungovala."
        />
        <Button title="Späť na prehľad" onPress={() => router.replace('/swap/selling')} />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      {/* Hlavička to už hovorí; druhý raz pod ňou je to ten istý text dvakrát. */}
      <View style={styles.summary}>
        <Text style={styles.summaryLine}>
          Kupujúci zaplatil {formatMoney(o.total_cents, o.currency)}
        </Text>
        <Caption>
          Tebe z toho ide {formatMoney(o.seller_net_cents, o.currency)}, po evente
          a po jeho potvrdení.
        </Caption>
      </View>

      {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}

      <SectionHeader title="Mám ju ako súbor" />
      <Caption style={styles.hint}>
        PDF alebo fotka. Uloží sa súkromne — dostane sa k nej len tento kupujúci.
      </Caption>
      <Button
        title={busy ? 'Nahrávam…' : 'Vybrať súbor'}
        onPress={() => void sendFile()}
        disabled={busy}
      />

      <SectionHeader title="Alebo ju prevádzam inde" />
      <Caption style={styles.hint}>
        Napíš kupujúcemu, čo si spravil a kde ju má hľadať. Prihlasovacie údaje
        sem nepíš — nepotrebuje ich a my ich ukladať nechceme.
      </Caption>
      <Input
        label="Správa kupujúcemu"
        value={note}
        onChangeText={setNote}
        multiline
        placeholder="Poslal som ti prevod na e-mail, ktorý máš v profile."
      />
      <Button
        title={busy ? 'Odosielam…' : 'Označiť ako doručené'}
        variant="secondary"
        onPress={() => void sendNote()}
        disabled={busy}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  summary: {
    maxWidth: CARD_MAX,
    width: '100%',
    alignSelf: 'center',
    padding: spacing.md,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    gap: 4,
    marginBottom: spacing.sm,
  },
  summaryLine: { ...typography.bodyStrong, color: colors.text },
  hint: { marginBottom: spacing.xs, lineHeight: 18 },
});
