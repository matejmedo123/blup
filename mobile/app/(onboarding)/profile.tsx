import React, { useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, View } from 'react-native';
import { router } from 'expo-router';

import { useAuth } from '@/auth/AuthProvider';
import { isUsernameAvailable, updateProfile } from '@/api/profiles';
import { pickImage, uploadAvatar } from '@/storage/uploads';
import { messageFor } from '@/lib/errors';
import { Avatar, Body, Button, Caption, Input, Notice, Screen } from '@/components/ui';
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
      setError('Add a name so people know who you are.');
      return;
    }

    const handle = username.trim().toLowerCase();
    if (!/^[a-z0-9_.]{3,24}$/.test(handle)) {
      setUsernameError('3–24 characters: letters, numbers, _ or .');
      return;
    }

    setSaving(true);
    try {
      const available = await isUsernameAvailable(handle);
      if (!available) {
        setUsernameError('That username is taken.');
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
    <Screen scroll>
      <Body muted style={styles.intro}>Step 1 of 3 · This is what other Bluppers see.</Body>

      {error ? <Notice tone="danger" title="Something went wrong" body={error} /> : null}

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
          title={avatarUrl ? 'Change photo' : 'Add a photo'}
          variant="ghost"
          compact
          onPress={changePhoto}
          disabled={uploading}
        />
        <Caption>Uploaded to your storage bucket, not just kept on this phone.</Caption>
      </View>

      <Input
        label="Name"
        value={displayName}
        onChangeText={setDisplayName}
        placeholder="Alex Kováč"
        autoCapitalize="words"
        editable={!saving}
      />

      <Input
        label="Username"
        value={username}
        onChangeText={(value) => setUsername(value.toLowerCase())}
        placeholder="alex"
        autoCapitalize="none"
        autoCorrect={false}
        error={usernameError}
        hint="People find you at @username"
        editable={!saving}
      />

      <Input
        label="Bio"
        value={bio}
        onChangeText={setBio}
        placeholder="Techno, climbing and long coffees."
        multiline
        numberOfLines={3}
        maxLength={300}
        style={styles.bio}
        hint={`${bio.length}/300`}
        editable={!saving}
      />

      <Button title="Continue" onPress={submit} loading={saving} />
    </Screen>
  );
}

const styles = StyleSheet.create({
  intro: { marginBottom: spacing.xl },
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
