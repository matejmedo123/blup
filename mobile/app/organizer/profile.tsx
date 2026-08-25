import React, { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { router } from 'expo-router';
import { Image } from 'expo-image';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { getMyOrganizations, updateOrganization } from '@/api/organizations';
import { pickImage, uploadOrganizationLogo } from '@/storage/uploads';
import { messageFor } from '@/lib/errors';
import { formatVatLine } from '@/lib/format';
import {
  Body, Button, Caption, Input, LoadingState, Notice, Screen, SectionHeader, Switch,
} from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * The organization's public face.
 *
 * An event belongs to an organization, not to a person, and the event page has
 * always shown the organization's name — but nothing could change it. A
 * personal organizer profile is created named after its owner, so somebody
 * running events as "Event Bros" had "Matej Medo" printed on every event with
 * no way to fix it.
 *
 * What is edited here is the public face only. The legal entity — the s.r.o.,
 * its IČO and DIČ — lives in the verification request, appears on the ticket
 * because a receipt must carry it, and is not touched from this screen.
 */
export default function OrganizationProfileScreen() {
  const queryClient = useQueryClient();
  const organizations = useQuery({ queryKey: ['organizations', 'mine'], queryFn: getMyOrganizations });
  const organization = organizations.data?.[0];

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [logoUrl, setLogoUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [isVatPayer, setIsVatPayer] = useState(false);
  const [vatRate, setVatRate] = useState('23');

  useEffect(() => {
    if (!organization) return;
    setName(organization.name);
    setDescription(organization.description ?? '');
    setWebsite(organization.website ?? '');
    setLogoUrl(organization.logo_url ?? null);
    setIsVatPayer(Boolean(organization.is_vat_payer));
    setVatRate(String((organization.vat_rate_bps ?? 2300) / 100));
  }, [organization]);

  if (organizations.isLoading) return <Screen><LoadingState /></Screen>;

  if (!organization) {
    return (
      <Screen>
        <Notice
          tone="warning"
          title="Zatiaľ nemáš organizáciu"
          body="Založ si ju a potom sem môžeš doplniť názov a logo, pod ktorým ťa ľudia uvidia."
          actionLabel="Založiť organizáciu"
          onAction={() => router.push('/organizer/new')}
        />
      </Screen>
    );
  }

  const changeLogo = async () => {
    setError(null);
    try {
      const picked = await pickImage({ source: 'library', aspect: [1, 1] });
      if (!picked) return;
      setBusy(true);
      setLogoUrl(await uploadOrganizationLogo(picked.uri, organization.id));
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    setError(null);
    setSaved(false);

    if (name.trim().length < 2) {
      setError('Názov musí mať aspoň 2 znaky.');
      return;
    }

    const rate = Number(vatRate.replace(',', '.'));
    if (isVatPayer && (!Number.isFinite(rate) || rate < 0 || rate > 100)) {
      setError('Sadzba DPH musí byť medzi 0 a 100 %.');
      return;
    }

    setBusy(true);
    try {
      await updateOrganization(organization.id, {
        name: name.trim(),
        description: description.trim() || null,
        website: website.trim() || null,
        logo_url: logoUrl,
        is_vat_payer: isVatPayer,
        vat_rate_bps: isVatPayer ? Math.round(rate * 100) : (organization.vat_rate_bps ?? 2300),
      });
      await queryClient.invalidateQueries({ queryKey: ['organizations'] });
      // The event pages carry this name and logo, so they are stale now too.
      await queryClient.invalidateQueries({ queryKey: ['events'] });
      await queryClient.invalidateQueries({ queryKey: ['event'] });
      setSaved(true);
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Screen scroll>
      <Text style={styles.title}>Verejný profil</Text>
      <Body muted style={styles.intro}>
        Toto uvidia ľudia na evente, v chate a na vstupenke ako organizátora.
      </Body>

      {error ? <Notice tone="danger" title="Nepodarilo sa uložiť" body={error} /> : null}
      {saved ? <Notice tone="success" title="Uložené" body="Zmeny sú hneď na všetkých tvojich eventoch." /> : null}

      <SectionHeader title="Logo" />
      <Pressable onPress={changeLogo} disabled={busy} style={styles.logoRow}>
        {logoUrl ? (
          <Image source={{ uri: logoUrl }} style={styles.logo} contentFit="cover" />
        ) : (
          <View style={[styles.logo, styles.logoEmpty]}>
            <Text style={styles.logoGlyph}>＋</Text>
          </View>
        )}
        <View style={styles.flex}>
          <Body>{logoUrl ? 'Vymeniť logo' : 'Nahrať logo'}</Body>
          <Caption>Štvorec, aspoň 400 × 400 px.</Caption>
        </View>
      </Pressable>

      <SectionHeader title="Meno" />
      <Input
        label="Názov organizátora"
        value={name}
        onChangeText={setName}
        placeholder="Event Bros"
        editable={!busy}
        returnKeyType="done"
        onSubmitEditing={() => void save()}
        hint="Pod týmto menom ťa uvidia návštevníci. Nemusí to byť tvoje meno."
      />

      <Input
        label="O nás (nepovinné)"
        value={description}
        onChangeText={setDescription}
        placeholder="Robíme technoparty v Bratislave od roku 2019."
        multiline
        editable={!busy}
      />

      <Input
        label="Web (nepovinné)"
        value={website}
        onChangeText={setWebsite}
        placeholder="https://eventbros.sk"
        autoCapitalize="none"
        editable={!busy}
      />

      <SectionHeader title="DPH" />
      <Switch
        label="Sme platiteľ DPH"
        value={isVatPayer}
        onValueChange={setIsVatPayer}
        description="Ceny vstupeniek zadávaš vždy s DPH a kupujúci vidí plnú sumu. Toto len pridá rozpad do tvojich štatistík a účtovníctva."
      />
      {isVatPayer ? (
        <>
          <Input
            label="Sadzba DPH (%)"
            value={vatRate}
            onChangeText={setVatRate}
            placeholder="23"
            keyboardType="decimal-pad"
            editable={!busy}
          />
          <Caption style={styles.legal}>
            {formatVatLine(1200, Math.round((Number(vatRate.replace(',', '.')) || 0) * 100))}
            {' — takto sa tržba rozpadne v Účtovníctve a v štatistike eventu. '}
            {'Na cenníku, v košíku ani na vstupenke sa nič nemení.'}
          </Caption>
        </>
      ) : null}

      <Button title="Uložiť" onPress={save} loading={busy} />

      <Caption style={styles.legal}>
        Právne údaje — obchodné meno, IČO a DIČ — sa zadávajú pri overení a menia sa tam.
        Na vstupenke musí byť subjekt, ktorý ju predal, takže tam sa uvádzajú tie, nie meno vyššie.
      </Caption>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.title, color: colors.text },
  intro: { marginTop: spacing.xs, marginBottom: spacing.lg },
  flex: { flex: 1, minWidth: 0 },

  logoRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    marginBottom: spacing.md,
  },
  logo: { width: 72, height: 72, borderRadius: radius.lg, backgroundColor: colors.surfaceElevated },
  logoEmpty: { alignItems: 'center', justifyContent: 'center' },
  logoGlyph: { color: colors.textSecondary, fontSize: 26 },

  legal: { marginTop: spacing.lg },
});
