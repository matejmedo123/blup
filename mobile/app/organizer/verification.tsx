import React, { useState } from 'react';
import { Pressable, StyleSheet, Text } from 'react-native';
import { router } from 'expo-router';
import { useQuery } from '@tanstack/react-query';

import {
  getMyOrganizations, getVerificationRequests, requestVerification,
} from '@/api/organizations';
import { acceptLegalDocument, getLegalDocument } from '@/api/legal';
import { messageFor } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import {
  Badge, Body, Button, Caption, EmptyState, Input, LoadingState, Notice, Screen, SectionHeader,
  Switch,
} from '@/components/ui';
import { colors, spacing } from '@/theme';

/** Organizer verification request — reviewed by a BLUP admin. */
export default function VerificationScreen() {
  const organizations = useQuery({ queryKey: ['organizations', 'mine'], queryFn: getMyOrganizations });
  const organization = organizations.data?.[0];

  const requests = useQuery({
    queryKey: ['organization', organization?.id, 'verification'],
    queryFn: () => getVerificationRequests(organization!.id),
    enabled: Boolean(organization?.id),
  });

  const [legalName, setLegalName] = useState('');
  const [registrationNumber, setRegistrationNumber] = useState('');
  const [vatNumber, setVatNumber] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [address, setAddress] = useState('');
  const [saving, setSaving] = useState(false);
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Above the early returns, with the other hooks. Below them the hook count
  // changed between renders and React took the screen down with #310 as soon
  // as the organization loaded — which is what a verification screen that
  // "just doesn't open" actually was.
  const agreement = useQuery({
    queryKey: ['legal', 'organizer_agreement'],
    queryFn: () => getLegalDocument('organizer_agreement'),
  });

  if (organizations.isLoading) return <Screen><LoadingState /></Screen>;

  if (!organization) {
    return (
      <Screen>
        <EmptyState emoji="🏢" title="Žiadna organizácia" body="Najprv si nejakú vytvor." />
      </Screen>
    );
  }

  const pending = (requests.data ?? []).find((request) => request.status === 'pending');

  const submit = async () => {
    setError(null);

    if (legalName.trim().length < 2 || !contactEmail.includes('@')) {
      setError('Potrebujeme registrovaný právny názov a kontaktný e-mail.');
      return;
    }

    if (!agreed) {
      setError('Bez súhlasu so zmluvou žiadosť odoslať nevieme.');
      return;
    }

    setSaving(true);
    try {
      // Accepted before the request exists, so a submitted request always has
      // an agreement attached — never a verification sitting in the queue with
      // nobody having agreed to anything.
      if (agreement.data) {
        await acceptLegalDocument(agreement.data.id, organization.id);
      }

      await requestVerification({
        organizationId: organization.id,
        legalName,
        registrationNumber,
        vatNumber,
        contactEmail,
        address,
      });
      setSent(true);
      await requests.refetch();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  if (organization.verification_status === 'verified') {
    return (
      <Screen scroll>
        <Notice
          tone="success"
          title="Overená"
          body="Môžeš robiť platené eventy a dostávať výplaty."
        />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Nepodarilo sa odoslať" body={error} /> : null}

      {pending || sent ? (
        <Notice
          tone="warning"
          title="Overenie sa posudzuje"
          body={
            pending
              ? `Submitted ${formatRelative(pending.created_at as string)}. A BLUP admin reviews these by hand — you will get a notification when it is decided.`
              : 'Odoslané. Admin BLUPu sa na to čoskoro pozrie.'
          }
        />
      ) : (
        <>
          <Body muted style={{ marginBottom: 24 }}>
            Overenie je to, čo ti umožní prijímať peniaze od kupujúcich. Kontrolujeme, či je
            organizácia skutočný a kontaktovateľný právny subjekt.
          </Body>

          <Input label="Registrovaný právny názov" value={legalName} onChangeText={setLegalName} placeholder="Nova Collective s.r.o." editable={!saving} />
          <Input label="IČO" value={registrationNumber} onChangeText={setRegistrationNumber} placeholder="12345678" editable={!saving} />
          <Input label="IČ DPH (nepovinné)" value={vatNumber} onChangeText={setVatNumber} placeholder="SK1234567890" autoCapitalize="characters" editable={!saving} />
          <Input label="Kontaktný e-mail" value={contactEmail} onChangeText={setContactEmail} placeholder="legal@example.com" autoCapitalize="none" keyboardType="email-address" editable={!saving} />
          <Input label="Sídlo" value={address} onChangeText={setAddress} placeholder="Ulica, mesto, krajina" editable={!saving} />

          <SectionHeader title="Zmluva" />
          <Body muted style={styles.legalIntro}>
            Odoslaním žiadosti prijímaš zmluvu o sprostredkovaní predaja vstupeniek.
            Podpíšeme ju schválením overenia — obe strany budú mať uložené presné
            znenie aj čas.
          </Body>

          <Pressable style={styles.legalLink} onPress={() => router.push('/legal/agreement')}>
            <Text style={styles.legalLinkLabel}>
              Prečítať zmluvu{agreement.data ? ` (verzia ${agreement.data.version})` : ''} →
            </Text>
          </Pressable>

          <Switch
            value={agreed}
            onValueChange={setAgreed}
            label="Súhlasím so zmluvou"
            description="Potvrdzujem aj to, že údaje vyššie sú pravdivé a že mám právo event usporiadať."
          />

          <Button
            title="Odoslať na overenie"
            onPress={submit}
            loading={saving}
            disabled={!agreed}
          />
        </>
      )}

      <SectionHeader title="História" />
      {(requests.data ?? []).length === 0 ? (
        <Body muted>Zatiaľ žiadne žiadosti.</Body>
      ) : (
        (requests.data ?? []).map((request) => (
          <Caption key={request.id as string} style={{ marginBottom: 8 }}>
            {formatRelative(request.created_at as string)} · {String(request.status)}
            {request.review_notes ? ` · ${String(request.review_notes)}` : ''}
          </Caption>
        ))
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  legalIntro: { marginBottom: spacing.sm },
  legalLink: { paddingVertical: spacing.sm, marginBottom: spacing.sm },
  legalLinkLabel: { color: colors.accent, fontWeight: '700' },
});
