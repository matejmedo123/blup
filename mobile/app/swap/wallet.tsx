import React, { useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getSellerBalance, requestSellerPayout } from '@/api/resale';
import { SwapNav } from '@/swap/SwapNav';
import { useDialog } from '@/components/Dialog';
import {
  Button, Caption, LoadingState, Notice, Screen, SectionHeader,
} from '@/components/ui';
import { supabase } from '@/lib/supabase';
import { callFunction } from '@/lib/supabase';
import { messageFor } from '@/lib/errors';
import { formatMoney, formatRelative } from '@/lib/format';
import { CONTENT_MAX } from '@/hooks/useLayout';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Peniaze zo SWAPu.
 *
 * Tri čísla a pri každom vysvetlenie, prečo je také, aké je. „Čaká na event"
 * nie je zdržanie ani chyba — kým sa event neodohrá, nikto nevie, či sa
 * kupujúci naozaj dostal dnu. Bez tej vety to vyzerá ako zadržiavanie bez
 * dôvodu a je to prvá vec, na ktorú sa ľudia pýtajú.
 *
 * Výplatný účet je tu aj vtedy, keď ešte nie je — bez neho nemáme peniaze kam
 * poslať a je lepšie to povedať skôr, než po prvom predaji.
 */
export default function SwapWalletScreen() {
  const queryClient = useQueryClient();
  const dialog = useDialog();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const balance = useQuery({ queryKey: ['resale', 'balance'], queryFn: getSellerBalance });

  const payouts = useQuery({
    queryKey: ['swap', 'payouts', 'mine'],
    queryFn: async () => {
      const { data, error: caught } = await supabase
        .from('seller_payouts')
        .select('id, amount_cents, currency, status, held_reason, requested_at, processed_at')
        .order('requested_at', { ascending: false })
        .limit(20);
      if (caught) throw caught;
      return (data ?? []) as {
        id: string; amount_cents: number; currency: string; status: string;
        held_reason: string | null; requested_at: string; processed_at: string | null;
      }[];
    },
  });

  if (balance.isLoading) return <Screen><LoadingState label="Načítavam…" /></Screen>;

  const b = balance.data;

  const connect = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await callFunction<{ onboarding_url: string | null; payouts_enabled: boolean }>(
        'seller-connect', {},
      );
      await queryClient.invalidateQueries({ queryKey: ['resale', 'balance'] });
      if (result.onboarding_url) {
        // Overenie totožnosti a číslo účtu rieši poskytovateľ platieb. Cez nás
        // tie údaje neprechádzajú a v našej databáze nie sú.
        if (typeof globalThis !== 'undefined' && 'open' in globalThis) {
          (globalThis as { open?: (u: string) => void }).open?.(result.onboarding_url);
        }
      }
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const withdraw = async () => {
    setError(null);
    try {
      await dialog.confirm({
        title: 'Poslať peniaze na účet',
        body: `Pošleme ti ${formatMoney(b?.available_cents ?? 0, b?.currency ?? 'EUR')}.`,
        confirmLabel: 'Poslať',
      });
    } catch {
      return;
    }
    setBusy(true);
    try {
      await requestSellerPayout();
      await queryClient.invalidateQueries({ queryKey: ['resale'] });
      await queryClient.invalidateQueries({ queryKey: ['swap'] });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <SwapNav active="/swap/wallet" />

      {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}

      {b ? (
        <View style={styles.money}>
          <View style={styles.row}>
            <Cell label="K výplate" value={formatMoney(b.available_cents, b.currency)} strong />
            <Cell label="Čaká na event" value={formatMoney(b.pending_cents, b.currency)} />
            <Cell label="Vyplatené" value={formatMoney(b.paid_out_cents, b.currency)} />
          </View>

          <Caption style={styles.note}>
            Peniaze sa uvoľnia po evente. Pri vstupenke z inej platformy až keď
            kupujúci potvrdí, že fungovala — dovtedy nikto nevie, či sa naozaj
            dostal dnu.
          </Caption>

          {!b.payouts_enabled ? (
            <>
              <Notice
                tone="warning"
                title="Ešte nemáš výplatný účet"
                body="Bez neho nemáme peniaze kam poslať. Overenie totožnosti a číslo účtu rieši poskytovateľ platieb — cez nás tie údaje neprechádzajú."
              />
              <Button
                title={busy ? 'Otváram…' : 'Nastaviť výplatný účet'}
                onPress={() => void connect()}
                disabled={busy}
              />
            </>
          ) : b.available_cents > 0 ? (
            <Button
              title={busy ? 'Posielam…' : `Poslať ${formatMoney(b.available_cents, b.currency)}`}
              onPress={() => void withdraw()}
              disabled={busy}
            />
          ) : (
            <Caption>Keď sa niečo uvoľní, pošleme ti to sem.</Caption>
          )}
        </View>
      ) : null}

      <SectionHeader title="História výplat" />
      {(payouts.data ?? []).length === 0 ? (
        <Caption>Zatiaľ žiadna výplata.</Caption>
      ) : (
        (payouts.data ?? []).map((payout) => (
          <View key={payout.id} style={styles.payout}>
            <View style={styles.payoutText}>
              <Text style={styles.payoutAmount}>
                {formatMoney(payout.amount_cents, payout.currency)}
              </Text>
              <Caption>
                {formatRelative(payout.processed_at ?? payout.requested_at)}
                {payout.held_reason ? ` · ${payout.held_reason}` : ''}
              </Caption>
            </View>
            <View style={[
              styles.pill,
              payout.status === 'paid' && styles.pillGood,
              payout.held_reason ? styles.pillWarn : null,
            ]}>
              <Text style={[
                styles.pillLabel,
                payout.status === 'paid' && styles.pillLabelGood,
                payout.held_reason ? styles.pillLabelWarn : null,
              ]}>
                {payout.held_reason ? 'Zadržané'
                  : payout.status === 'paid' ? 'Odoslané'
                    : payout.status === 'processing' ? 'Posiela sa'
                      : payout.status === 'failed' ? 'Nepodarilo sa' : 'Čaká'}
              </Text>
            </View>
          </View>
        ))
      )}
    </Screen>
  );
}

function Cell({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.cell}>
      <Text style={[styles.cellValue, strong && styles.cellStrong]}>{value}</Text>
      <Caption style={styles.cellLabel}>{label}</Caption>
    </View>
  );
}

const styles = StyleSheet.create({
  money: {
    padding: spacing.md, borderRadius: radius.card,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    gap: spacing.sm, marginBottom: spacing.md,
    maxWidth: CONTENT_MAX, width: '100%', alignSelf: 'center',
  },
  row: { flexDirection: 'row' },
  cell: { flex: 1, alignItems: 'center', gap: 2 },
  cellValue: { ...typography.body, color: colors.textSecondary },
  cellStrong: { ...typography.subheading, color: colors.text },
  cellLabel: { textAlign: 'center' },
  note: { lineHeight: 18 },

  payout: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    padding: spacing.md, borderRadius: radius.card,
    borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface,
    marginBottom: spacing.xs,
    maxWidth: CONTENT_MAX, width: '100%', alignSelf: 'center',
  },
  payoutText: { flex: 1 },
  payoutAmount: { ...typography.bodyStrong, color: colors.text },
  pill: {
    paddingHorizontal: spacing.sm, paddingVertical: 3,
    borderRadius: radius.pill, borderWidth: 1, borderColor: colors.border,
  },
  pillGood: { backgroundColor: colors.successSoft, borderColor: colors.success },
  pillWarn: { backgroundColor: colors.warningSoft, borderColor: colors.warning },
  pillLabel: { ...typography.metaSm, color: colors.textSecondary },
  pillLabelGood: { color: colors.success },
  pillLabelWarn: { color: colors.warning },
});
