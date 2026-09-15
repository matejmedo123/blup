import React, { useEffect, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getPlatformSettings, updatePlatformSettings } from '@/api/admin';
import { messageFor } from '@/lib/errors';
import { useSeed } from '@/hooks/useSeed';
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

  // The operator's own identity, shown in the footer of every page on the web.
  const [operator, setOperator] = useState({
    name: '', address: '', city: '', country: '', regNo: '', vatNo: '', email: '', phone: '',
    website: '',
  });
  const [savingOperator, setSavingOperator] = useState(false);

  const settings = useQuery({ queryKey: ['platform-settings'], queryFn: getPlatformSettings });

  useSeed(settings.data, (loaded) => {
    setPercent((loaded.platform_fee_bps / 100).toString());
    setArchive((loaded.archive_fee_cents / 100).toFixed(2));
    setPayer(loaded.archive_fee_payer);
    setSettlement(String(loaded.settlement_days));
    setOperator({
      name: loaded.operator_name ?? '',
      address: loaded.operator_address ?? '',
      city: loaded.operator_city ?? '',
      country: loaded.operator_country ?? '',
      regNo: loaded.operator_reg_no ?? '',
      vatNo: loaded.operator_vat_no ?? '',
      email: loaded.operator_email ?? '',
      phone: loaded.operator_phone ?? '',
      website: loaded.operator_website ?? '',
    });
  });

  const saveOperator = async () => {
    setError(null);
    setNotice(null);

    const email = operator.email.trim();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setError('E-mail prevádzkovateľa nevyzerá ako e-mail.');
      return;
    }

    setSavingOperator(true);
    try {
      const clean = (value: string) => value.trim() || null;
      await updatePlatformSettings({
        operator_name: clean(operator.name),
        operator_address: clean(operator.address),
        operator_city: clean(operator.city),
        operator_country: clean(operator.country),
        operator_reg_no: clean(operator.regNo),
        operator_vat_no: clean(operator.vatNo),
        operator_email: clean(email),
        operator_phone: clean(operator.phone),
        operator_website: clean(operator.website),
      });
      await queryClient.invalidateQueries({ queryKey: ['platform-settings'] });
      await queryClient.invalidateQueries({ queryKey: ['platform', 'operator'] });
      setNotice('Údaje prevádzkovateľa sú v pätičke na každej stránke.');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSavingOperator(false);
    }
  };

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

      <SectionHeader title="Prevádzkovateľ" />
      <Caption style={styles.hint}>
        Toto je v pätičke každej stránky na webe. Čo tu nevyplníš, sa nezobrazí — nič sa
        nedopĺňa za teba. Bez obchodného mena, sídla a IČO nie je stránka v EÚ v poriadku.
      </Caption>

      <Input
        label="Obchodné meno"
        value={operator.name}
        onChangeText={(v) => setOperator((o) => ({ ...o, name: v }))}
        placeholder="Napr. Blup s. r. o."
      />
      <Input
        label="Ulica a číslo"
        value={operator.address}
        onChangeText={(v) => setOperator((o) => ({ ...o, address: v }))}
        placeholder="Mostná 13"
      />
      <Input
        label="PSČ a mesto"
        value={operator.city}
        onChangeText={(v) => setOperator((o) => ({ ...o, city: v }))}
        placeholder="949 01 Nitra"
      />
      <Input
        label="Krajina"
        value={operator.country}
        onChangeText={(v) => setOperator((o) => ({ ...o, country: v }))}
        placeholder="Slovensko"
      />
      <Input
        label="IČO"
        value={operator.regNo}
        onChangeText={(v) => setOperator((o) => ({ ...o, regNo: v }))}
        placeholder="12345678"
      />
      <Input
        label="IČ DPH (ak si platiteľ)"
        value={operator.vatNo}
        onChangeText={(v) => setOperator((o) => ({ ...o, vatNo: v }))}
        placeholder="SK1234567890"
      />
      <Input
        label="Kontaktný e-mail"
        value={operator.email}
        onChangeText={(v) => setOperator((o) => ({ ...o, email: v }))}
        placeholder="info@blup.sk"
        autoCapitalize="none"
        keyboardType="email-address"
      />
      <Input
        label="Telefón (nepovinné)"
        value={operator.phone}
        onChangeText={(v) => setOperator((o) => ({ ...o, phone: v }))}
        placeholder="+421 900 000 000"
      />

      <Button
        title="Uložiť údaje prevádzkovateľa"
        variant="secondary"
        loading={savingOperator}
        onPress={() => void saveOperator()}
      />
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
