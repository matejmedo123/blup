import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getPlatformSettings, updatePlatformSettings } from '@/api/admin';
import { messageFor } from '@/lib/errors';
import { formatMoney } from '@/lib/format';
import {
  Body, Button, Caption, Card, Divider, Input, LoadingState, Notice, Screen, SectionHeader,
  Segmented,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * The fee schedule, editable in-product.
 *
 * Changing these values only affects orders created afterwards: every order
 * stores the commission and archive fee it was actually charged, so lowering
 * the fee tomorrow does not quietly rewrite what an organizer was owed
 * yesterday.
 */
export default function FeesScreen() {
  const queryClient = useQueryClient();
  const [percent, setPercent] = useState('');
  const [archive, setArchive] = useState('');
  const [payer, setPayer] = useState<'buyer' | 'organizer'>('buyer');
  const [settlement, setSettlement] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const settings = useQuery({ queryKey: ['platform-settings'], queryFn: getPlatformSettings });

  useEffect(() => {
    if (!settings.data) return;
    setPercent((settings.data.platform_fee_bps / 100).toString());
    setArchive((settings.data.archive_fee_cents / 100).toFixed(2));
    setPayer(settings.data.archive_fee_payer);
    setSettlement(String(settings.data.settlement_days));
  }, [settings.data]);

  const save = async () => {
    setError(null);
    setNotice(null);

    const percentValue = Number(percent.replace(',', '.'));
    const archiveValue = Number(archive.replace(',', '.'));
    const settlementValue = Number(settlement);

    if (!Number.isFinite(percentValue) || percentValue < 0 || percentValue > 20) {
      setError('Provízia musí byť medzi 0 a 20 %.');
      return;
    }
    if (!Number.isFinite(archiveValue) || archiveValue < 0) {
      setError('Archívny poplatok nemôže byť záporný.');
      return;
    }
    if (!Number.isInteger(settlementValue) || settlementValue < 0 || settlementValue > 90) {
      setError('Splatnosť musí byť celé číslo dní od 0 do 90.');
      return;
    }

    setBusy(true);
    try {
      await updatePlatformSettings({
        platform_fee_bps: Math.round(percentValue * 100),
        archive_fee_cents: Math.round(archiveValue * 100),
        archive_fee_payer: payer,
        settlement_days: settlementValue,
      });
      await queryClient.invalidateQueries({ queryKey: ['platform-settings'] });
      setNotice('Nová sadzba platí pre objednávky vytvorené od teraz.');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  if (settings.isLoading) return <Screen><LoadingState /></Screen>;

  const percentValue = Number(percent.replace(',', '.')) || 0;
  const archiveCents = Math.round((Number(archive.replace(',', '.')) || 0) * 100);
  // A worked example beats a paragraph: two 15 EUR tickets, current schedule.
  const exampleNet = 3000;
  const exampleCommission = Math.floor((exampleNet * Math.round(percentValue * 100)) / 10000);
  const exampleArchive = archiveCents * 2;
  const exampleBuyer = exampleNet + (payer === 'buyer' ? exampleArchive : 0);
  const exampleOrganizer = exampleNet - exampleCommission - (payer === 'organizer' ? exampleArchive : 0);

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Neuložené" body={error} /> : null}
      {notice ? <Notice tone="success" title="Uložené" body={notice} /> : null}

      <SectionHeader title="Sadzba" />
      <Input
        label="Provízia z predaja (%)"
        value={percent}
        onChangeText={setPercent}
        keyboardType="decimal-pad"
        hint="Počíta sa zo sumy po zľavách — z toho, čo naozaj prišlo."
      />
      <Input
        label="Archívny poplatok za vstupenku (EUR)"
        value={archive}
        onChangeText={setArchive}
        keyboardType="decimal-pad"
        hint="Vstupenky zdarma sa nespoplatňujú."
      />

      <SectionHeader title="Kto platí archívny poplatok" />
      <Segmented
        options={[
          { value: 'buyer', label: 'Kupujúci' },
          { value: 'organizer', label: 'Organizátor' },
        ]}
        value={payer}
        onChange={setPayer}
      />
      <Caption style={styles.hint}>
        {payer === 'buyer'
          ? 'Pripočíta sa k cene na checkoute ako samostatná položka.'
          : 'Strhne sa organizátorovi z tržby, kupujúci ho nevidí.'}
      </Caption>

      <Input
        label="Splatnosť výplaty (dni)"
        value={settlement}
        onChangeText={setSettlement}
        keyboardType="number-pad"
        hint="Ako dlho peniaze čakajú, kým si ich organizátor môže vybrať."
      />

      <Card style={styles.example}>
        <SectionHeader title="Príklad: 2 × 15 €" />
        <Line label="Kupujúci zaplatí" value={formatMoney(exampleBuyer, 'EUR')} strong />
        <Divider />
        <Line label="Provízia BLUP" value={formatMoney(exampleCommission, 'EUR')} />
        <Line label="Archívny poplatok" value={formatMoney(exampleArchive, 'EUR')} />
        <Line label="BLUP spolu" value={formatMoney(exampleCommission + exampleArchive, 'EUR')} strong />
        <Divider />
        <Line label="Organizátor dostane" value={formatMoney(exampleOrganizer, 'EUR')} strong />
      </Card>

      <Button title="Uložiť sadzbu" loading={busy} onPress={() => void save()} />
      <Caption style={styles.footNote}>
        Zmena platí len dopredu. Každá objednávka si pamätá poplatky, ktoré na ňu naozaj sadli, takže
        staré výplaty ostávajú nedotknuté.
      </Caption>
    </Screen>
  );
}

function Line({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <View style={styles.line}>
      <Body muted={!strong}>{label}</Body>
      <Text style={strong ? styles.valueStrong : styles.value}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  hint: { marginTop: spacing.xs, marginBottom: spacing.md },
  example: {
    marginTop: spacing.lg,
    borderRadius: radius.lg,
    borderColor: colors.borderAccent,
  },
  line: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingVertical: spacing.xs,
    gap: spacing.md,
  },
  value: { ...typography.body, color: colors.textSecondary },
  valueStrong: { ...typography.bodyStrong, color: colors.text },
  footNote: { marginTop: spacing.md },
});
