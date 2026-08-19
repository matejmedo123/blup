import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';

import { useAuth } from '@/auth/AuthProvider';
import { isUsernameAvailable, updateProfile } from '@/api/profiles';
import { pickImage, uploadAvatar } from '@/storage/uploads';
import { messageFor } from '@/lib/errors';
import { Avatar, Button, Caption, Input, Notice } from '@/components/ui';
import { OnboardingShell } from '@/components/OnboardingShell';
import { colors, spacing } from '@/theme';

/** Step 1 of 3 — name, handle and a real profile photo. */
export default function OnboardingProfileScreen() {
  const { profile, refreshProfile } = useAuth();

  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [bio, setBio] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [usernameError, setUsernameError] = useState<string | null>(null);

  useEffect(() => {
    if (!profile) return;
    setDisplayName((current) => current || profile.display_name || '');
    setUsername((current) => current || profile.username || '');
    setBio((current) => current || profile.bio || '');
    setAvatarUrl((current) => current || profile.avatar_url);
  }, [profile]);

  const changePhoto = async () => {
    setError(null);
    try {
      const picked = await pickImage({ source: 'library', aspect: [1, 1] });
      if (!picked) return;

      setUploading(true);
      const url = await uploadAvatar(picked.uri);
      setAvatarUrl(url);
      await refreshProfile();
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setUploading(false);
    }
  };

  const submit = async () => {
    setError(null);
    setUsernameError(null);

    if (displayName.trim().length < 2) {
      setError('Doplň meno, nech ťa ľudia spoznajú.');
      return;
    }

    const handle = username.trim().toLowerCase();
    if (!/^[a-z0-9_.]{3,24}$/.test(handle)) {
      setUsernameError('3–24 znakov: písmená, čísla, _ alebo .');
      return;
    }

    setSaving(true);
    try {
      const available = await isUsernameAvailable(handle);
      if (!available) {
        setUsernameError('Toto meno je už obsadené.');
        return;
      }

      await updateProfile({
        display_name: displayName.trim(),
        username: handle,
        bio: bio.trim() || null,
      });

      await refreshProfile();
      router.push('/(onboarding)/interests');
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setSaving(false);
    }
  };

  return (
    <OnboardingShell
      step={0}
      title="Kto si?"
      subtitle="Meno a fotka. Takto ťa uvidia ostatní, keď si niekam blupnete spolu."
      ctaLabel="Pokračovať"
      onCta={submit}
      ctaLoading={saving}
    >
      {error ? <Notice tone="danger" title="Niečo sa pokazilo" body={error} /> : null}

      <View style={styles.avatarSection}>
        <Pressable onPress={changePhoto} disabled={uploading} accessibilityRole="button">
          <Avatar url={avatarUrl} name={displayName} size={104} />
          {uploading ? (
            <View style={styles.avatarOverlay}>
              <ActivityIndicator color={colors.text} />
            </View>
          ) : null}
        </Pressable>
        <Button
          title={avatarUrl ? 'Zmeniť fotku' : 'Pridať fotku'}
          variant="ghost"
          compact
          onPress={changePhoto}
          disabled={uploading}
        />
        <Caption>Nahráva sa do tvojho storage bucketu, nezostáva len v telefóne.</Caption>
      </View>

      <Input
        label="Meno"
        value={displayName}
        onChangeText={setDisplayName}
        placeholder="Alex Kováč"
        autoCapitalize="words"
        editable={!saving}
      />

      <Input
        label="Používateľské meno"
        value={username}
        onChangeText={(value) => setUsername(value.toLowerCase())}
        placeholder="alex"
        autoCapitalize="none"
        autoCorrect={false}
        error={usernameError}
        hint="Ľudia ťa nájdu ako @meno"
        editable={!saving}
      />

      <Input
        label="O tebe"
        value={bio}
        onChangeText={setBio}
        placeholder="Techno, lezenie a dlhé kávy."
        multiline
        numberOfLines={3}
        maxLength={300}
        style={styles.bio}
        hint={`${bio.length}/300`}
        editable={!saving}
      />

    </OnboardingShell>
  );
}

const styles = StyleSheet.create({
  intro: { color: colors.textTertiary, marginBottom: spacing.xl },
  avatarSection: { alignItems: 'center', gap: spacing.sm, marginBottom: spacing.xl },
  avatarOverlay: {
    position: 'absolute', top: 0, left: 0, right: 0, bottom: 0,
    borderRadius: 52,
    backgroundColor: colors.overlay,
    alignItems: 'center',
    justifyContent: 'center',
  },
  bio: { height: 90, textAlignVertical: 'top', paddingTop: spacing.md },
});
