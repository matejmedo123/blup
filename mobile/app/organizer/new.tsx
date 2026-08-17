import React, { useState } from 'react';
import { router } from 'expo-router';

import { createOrganization } from '@/api/organizations';
import { messageFor } from '@/lib/errors';
import { Body, Button, Input, Notice, Screen } from '@/components/ui';

/** Creating an organization — the first step to selling tickets. */
export default function NewOrganizationScreen() {
  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [description, setDescription] = useState('');
  const [website, setWebsite] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [country, setCountry] = useState('SK');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    setError(null);

    if (name.trim().length < 2) {
      setError('Give the organization a name.');
      return;
    }

    setSaving(true);
    try {
      const organization = await createOrganization({
        name,
        slug: slug || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, ''),
        description,
        website,
        contactEmail,
        country,
      });

      router.replace({ pathname: '/organizer/verification', params: { id: organization.id } });
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen scroll>
      <Body muted style={{ marginBottom: 24 }}>
        Organizations are how ticketed events work on BLUP. You can still create free events without
        one.
      </Body>

      {error ? <Notice tone="danger" title="Could not create" body={error} /> : null}

      <Input label="Name" value={name} onChangeText={setName} placeholder="Nova Collective" editable={!saving} />
      <Input
        label="Handle"
        value={slug}
        onChangeText={(value) => setSlug(value.toLowerCase())}
        placeholder="nova-collective"
        autoCapitalize="none"
        hint="Used in links. Lowercase letters, numbers and dashes."
        editable={!saving}
      />
      <Input
        label="Description"
        value={description}
        onChangeText={setDescription}
        placeholder="Warehouse parties and techno nights since 2019."
        multiline
        numberOfLines={3}
        style={{ height: 90, textAlignVertical: 'top', paddingTop: 12 }}
        editable={!saving}
      />
      <Input label="Website" value={website} onChangeText={setWebsite} placeholder="https://" autoCapitalize="none" editable={!saving} />
      <Input
        label="Contact email"
        value={contactEmail}
        onChangeText={setContactEmail}
        placeholder="hello@example.com"
        autoCapitalize="none"
        keyboardType="email-address"
        editable={!saving}
      />
      <Input
        label="Country"
        value={country}
        onChangeText={(value) => setCountry(value.toUpperCase().slice(0, 2))}
        placeholder="SK"
        autoCapitalize="characters"
        hint="Two-letter code — determines the payout provider setup."
        editable={!saving}
      />

      <Button title="Create organization" onPress={submit} loading={saving} />
    </Screen>
  );
}
