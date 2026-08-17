import React, { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

import {
  getMyOrganizations, getVerificationRequests, requestVerification,
} from '@/api/organizations';
import { messageFor } from '@/lib/errors';
import { formatRelative } from '@/lib/format';
import {
  Badge, Body, Button, Caption, EmptyState, Input, LoadingState, Notice, Screen, SectionHeader,
} from '@/components/ui';

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
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  if (organizations.isLoading) return <Screen><LoadingState /></Screen>;

  if (!organization) {
    return (
      <Screen>
        <EmptyState emoji="🏢" title="No organization" body="Create one first." />
      </Screen>
    );
  }

  const pending = (requests.data ?? []).find((request) => request.status === 'pending');

  const submit = async () => {
    setError(null);

    if (legalName.trim().length < 2 || !contactEmail.includes('@')) {
      setError('We need the registered legal name and a contact email.');
      return;
    }

    setSaving(true);
    try {
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
          title="Verified"
          body="You can create ticketed events and receive payouts."
        />
      </Screen>
    );
  }

  return (
    <Screen scroll>
      {error ? <Notice tone="danger" title="Could not submit" body={error} /> : null}

      {pending || sent ? (
        <Notice
          tone="warning"
          title="Verification in review"
          body={
            pending
              ? `Submitted ${formatRelative(pending.created_at as string)}. A BLUP admin reviews these by hand — you will get a notification when it is decided.`
              : 'Submitted. A BLUP admin will review it shortly.'
          }
        />
      ) : (
        <>
          <Body muted style={{ marginBottom: 24 }}>
            Verification is what lets you take money from ticket buyers. We check that the
            organization is a real, contactable legal entity.
          </Body>

          <Input label="Registered legal name" value={legalName} onChangeText={setLegalName} placeholder="Nova Collective s.r.o." editable={!saving} />
          <Input label="Company registration number" value={registrationNumber} onChangeText={setRegistrationNumber} placeholder="12345678" editable={!saving} />
          <Input label="VAT number (optional)" value={vatNumber} onChangeText={setVatNumber} placeholder="SK1234567890" autoCapitalize="characters" editable={!saving} />
          <Input label="Contact email" value={contactEmail} onChangeText={setContactEmail} placeholder="legal@example.com" autoCapitalize="none" keyboardType="email-address" editable={!saving} />
          <Input label="Registered address" value={address} onChangeText={setAddress} placeholder="Street, city, country" editable={!saving} />

          <Button title="Submit for verification" onPress={submit} loading={saving} />
        </>
      )}

      <SectionHeader title="History" />
      {(requests.data ?? []).length === 0 ? (
        <Body muted>No requests yet.</Body>
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
