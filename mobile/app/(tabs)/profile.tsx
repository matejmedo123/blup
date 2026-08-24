import React from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { router } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { LinearGradient } from 'expo-linear-gradient';
import { useQuery } from '@tanstack/react-query';

import { useAuth } from '@/auth/AuthProvider';
import { SignInInvite } from '@/components/SignInInvite';
import { getFollowCounts, getInterestsFor, updateProfile } from '@/api/profiles';
import { getMyEvents, getSavedEvents, getAttendingEvents, toFeedItem } from '@/api/events';
import { getMyTickets } from '@/api/tickets';
import { getPremiumStatus } from '@/api/premium';
import { getBadgeProgress, getGamification, levelProgress, levelTitle } from '@/api/gamification';
import { env } from '@/lib/env';
import { messageFor } from '@/lib/errors';
import { formatCount, formatEventDate } from '@/lib/format';
import { useToast } from '@/components/Toast';
import { BottomSheet } from '@/components/BottomSheet';
import { Avatar, Body, Button, LoadingState, Notice } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

/**
 * Ja.
 *
 * Avatar and three counters, the level card, the badge strip, interests, your
 * agenda, your tickets and the settings toggles — in the handoff's order. Every
 * number is read from the database; nothing here is decorative.
 */
export default function ProfileScreen() {
  const { profile, signOut, refreshProfile, loadingProfile, isAdmin, isGuest } = useAuth();
  const toast = useToast();

  const [premiumOpen, setPremiumOpen] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const counts = useQuery({
    queryKey: ['profile', 'counts', profile?.id],
    queryFn: () => getFollowCounts(profile!.id),
    enabled: Boolean(profile?.id),
  });

  const interests = useQuery({
    queryKey: ['profile', 'interests', profile?.id],
    queryFn: () => getInterestsFor(profile!.id),
    enabled: Boolean(profile?.id),
  });

  const myEvents = useQuery({ queryKey: ['events', 'mine'], queryFn: getMyEvents });
  const saved = useQuery({ queryKey: ['events', 'saved'], queryFn: getSavedEvents });
  const attending = useQuery({ queryKey: ['events', 'attending'], queryFn: getAttendingEvents });
  const tickets = useQuery({ queryKey: ['tickets', 'mine'], queryFn: getMyTickets });
  const premium = useQuery({ queryKey: ['premium', 'status'], queryFn: getPremiumStatus });
  const game = useQuery({ queryKey: ['gamification', 'me'], queryFn: () => getGamification() });
  const badges = useQuery({ queryKey: ['badges', 'progress'], queryFn: getBadgeProgress });

  if (isGuest) {
    return (
      <SignInInvite
        glyph="☺"
        title="Toto je tvoje miesto"
        body="Profil, uložené eventy, vstupenky, odznaky a nastavenia — všetko sa viaže na účet."
        perks={[
          'Uložené eventy a agenda na jednom mieste',
          'Vstupenky s QR kódom aj offline',
          'XP, levely a odznaky za to, kam naozaj chodíš',
          'Ľudia zo spoločných eventov ťa nájdu',
        ]}
      />
    );
  }

  if (loadingProfile && !profile) {
    return <SafeAreaView style={styles.screen} edges={['top']}><LoadingState /></SafeAreaView>;
  }

  const isPremium = premium.data?.is_premium ?? false;

  // The agenda: everything blupped or RSVP'd, nearest first.
  const agenda = [
    ...(saved.data ?? []).map((event) => ({ event, chip: 'Blup' as const })),
    ...(attending.data ?? []).map((event) => ({ event: toFeedItem(event), chip: 'Idem' as const })),
  ]
    .filter((item, index, all) => all.findIndex((other) => other.event.id === item.event.id) === index)
    .sort((a, b) => new Date(a.event.start_at).getTime() - new Date(b.event.start_at).getTime())
    .slice(0, 6);

  const validTickets = (tickets.data ?? []).filter((ticket) => ticket.status === 'valid');

  const setSetting = async (patch: Parameters<typeof updateProfile>[0], label: string) => {
    setError(null);
    try {
      await updateProfile(patch);
      await refreshProfile();
      toast.show(label);
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  return (
    <SafeAreaView style={styles.screen} edges={['top']}>
      <ScrollView
        contentContainerStyle={styles.content}
        showsVerticalScrollIndicator={false}
        refreshControl={
          <RefreshControl
            refreshing={false}
            onRefresh={() => {
              void refreshProfile();
              void counts.refetch();
              void game.refetch();
              void myEvents.refetch();
              void saved.refetch();
            }}
            tintColor={colors.accent}
          />
        }
      >
        <View style={styles.header}>
          <Text style={styles.screenTitle}>Ja</Text>
          <Pressable style={styles.headerButton} onPress={() => router.push('/organizer')}>
            <Text style={styles.headerButtonLabel}>Organizátor</Text>
          </Pressable>
        </View>

        {error ? <Notice tone="danger" title="Nepodarilo sa" body={error} /> : null}

        {/* --- identity ------------------------------------------------------ */}
        <View style={styles.identity}>
          <Avatar url={profile?.avatar_url} name={profile?.display_name} size={74} square />

          <View style={styles.flex}>
            <Text style={styles.name} numberOfLines={1}>
              {profile?.display_name ?? 'Tvoj profil'}
            </Text>
            <Text style={styles.handle} numberOfLines={1}>
              @{profile?.username ?? '—'}
              {profile?.city ? ` · ${profile.city}` : ''}
            </Text>

            <View style={styles.counters}>
              <Counter value={saved.data?.length ?? 0} label="blupov" />
              <Counter value={myEvents.data?.length ?? 0} label="eventov" />
              <Counter value={counts.data?.following ?? 0} label="kruhov" />
            </View>
          </View>
        </View>

        {/* --- level --------------------------------------------------------- */}
        <Pressable onPress={() => router.push('/badges')}>
          <LinearGradient
            colors={[colors.accent, colors.cyan]}
            start={{ x: 0, y: 0 }}
            end={{ x: 1, y: 0.8 }}
            style={styles.levelCard}
          >
            <View style={styles.levelTop}>
              <Text style={styles.levelTitle}>
                Level {game.data?.level ?? 1} · {levelTitle(game.data?.level ?? 1)}
              </Text>
              <Text style={styles.levelXp}>
                {game.data?.xp ?? 0} / {game.data?.level_ceiling ?? 100} XP
              </Text>
            </View>

            <View style={styles.track}>
              <View
                style={[styles.trackFill, { width: `${Math.round(levelProgress(game.data) * 100)}%` }]}
              />
            </View>
          </LinearGradient>
        </Pressable>

        {/* --- badges -------------------------------------------------------- */}
        <View style={styles.sectionHeader}>
          <Text style={styles.section}>Odznaky</Text>
          <Pressable onPress={() => router.push('/badges')}>
            <Text style={styles.sectionAction}>Všetky</Text>
          </Pressable>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.badgeRow}>
          {(badges.data ?? []).slice(0, 8).map((badge) => (
            <View key={badge.slug} style={[styles.badge, badge.earned && styles.badgeEarned]}>
              <Text style={[styles.badgeEmoji, !badge.earned && styles.badgeEmojiLocked]}>
                {badge.emoji}
              </Text>
              <Text
                style={[styles.badgeName, badge.earned && styles.badgeNameEarned]}
                numberOfLines={2}
              >
                {badge.name}
              </Text>
            </View>
          ))}
        </ScrollView>

        {/* --- interests ----------------------------------------------------- */}
        <View style={styles.sectionHeader}>
          <Text style={styles.section}>Moje záujmy</Text>
        </View>

        <View style={styles.chips}>
          {(interests.data ?? []).map((interest) => (
            <View key={interest.id} style={styles.chip}>
              <Text style={styles.chipLabel}>{interest.name}</Text>
            </View>
          ))}

          <Pressable style={styles.chipEdit} onPress={() => router.push('/settings/interests')}>
            <Text style={styles.chipEditLabel}>+ upraviť</Text>
          </Pressable>
        </View>

        {/* --- agenda -------------------------------------------------------- */}
        <View style={styles.sectionHeader}>
          <Text style={styles.section}>Moja agenda</Text>
        </View>

        {agenda.length === 0 ? (
          <View style={styles.dashed}>
            <Body muted>
              Zatiaľ prázdno. Blupni si niečo na Objave alebo označ, že ideš.
            </Body>
            <Pressable onPress={() => router.push('/(tabs)/discover')}>
              <Text style={styles.dashedAction}>Prejsť na Objav</Text>
            </Pressable>
          </View>
        ) : (
          agenda.map((item) => (
            <Pressable
              key={item.event.id}
              style={styles.agendaRow}
              onPress={() => router.push(`/event/${item.event.id}`)}
            >
              <View style={styles.flex}>
                <Text style={styles.agendaTitle} numberOfLines={1}>{item.event.title}</Text>
                <Text style={styles.agendaMeta} numberOfLines={1}>
                  {formatEventDate(item.event.start_at)}
                  {item.event.venue_name ? ` · ${item.event.venue_name}` : ''}
                </Text>
              </View>
              <View style={[styles.agendaChip, item.chip === 'Idem' && styles.agendaChipGoing]}>
                <Text style={styles.agendaChipLabel}>{item.chip}</Text>
              </View>
            </Pressable>
          ))
        )}

        {/* --- tickets ------------------------------------------------------- */}
        <View style={styles.sectionHeader}>
          <Text style={styles.section}>Moje vstupenky</Text>
          <Pressable onPress={() => router.push('/tickets')}>
            <Text style={styles.sectionAction}>Všetky</Text>
          </Pressable>
        </View>

        {validTickets.length === 0 ? (
          <View style={styles.dashed}>
            <Body muted>Žiadne vstupenky. Keď nejakú kúpiš, bude tu — aj offline.</Body>
          </View>
        ) : (
          validTickets.slice(0, 2).map((ticket) => (
            <Pressable key={ticket.id} onPress={() => router.push(`/tickets/${ticket.id}`)}>
              <LinearGradient
                colors={['rgba(0,128,255,0.2)', 'rgba(34,211,238,0.12)']}
                start={{ x: 0, y: 0 }}
                end={{ x: 1, y: 1 }}
                style={styles.ticket}
              >
                <Text style={styles.ticketStrip}>BLUP</Text>

                <View style={styles.flex}>
                  <Text style={styles.ticketTitle} numberOfLines={1}>
                    {ticket.event?.title ?? 'Event'}
                  </Text>
                  {ticket.event ? (
                    <Text style={styles.ticketMeta}>{formatEventDate(ticket.event.start_at)}</Text>
                  ) : null}
                  <Text style={styles.ticketCode}>Offline dostupná · {ticket.code}</Text>
                </View>

                <View style={styles.barcode}>
                  {Array.from({ length: 16 }).map((_, index) => (
                    <View key={index} style={styles.barcodeBar} />
                  ))}
                </View>
              </LinearGradient>
            </Pressable>
          ))
        )}

        {/* --- settings ------------------------------------------------------ */}
        <View style={styles.sectionHeader}>
          <Text style={styles.section}>Nastavenia</Text>
        </View>

        <SettingRow
          label="Blup Premium"
          value={isPremium}
          onToggle={() => setPremiumOpen(true)}
          note={isPremium ? 'aktívne' : '4,99 € / mesiac'}
        />
        <SettingRow
          label="Súkromný profil"
          value={profile?.is_private ?? false}
          onToggle={(next) =>
            setSetting({ is_private: next }, next ? 'Profil je súkromný' : 'Profil je verejný')}
        />
        <SettingRow
          label="Zobrazovať moje mesto"
          value={profile?.show_location ?? true}
          onToggle={(next) =>
            setSetting({ show_location: next }, next ? 'Mesto sa zobrazuje' : 'Mesto je skryté')}
        />
        <SettingRow
          label="Povoliť správy"
          value={profile?.allow_dm ?? true}
          onToggle={(next) =>
            setSetting({ allow_dm: next }, next ? 'Správy sú povolené' : 'Správy sú vypnuté')}
        />
        <SettingRow
          label={isPremium ? 'Anonymný mód' : 'Anonymný mód (Premium)'}
          value={profile?.anonymous_mode ?? false}
          disabled={!isPremium}
          onToggle={(next) => {
            if (!isPremium) {
              toast.show('Anonymný mód je súčasť Premium');
              return;
            }
            void setSetting(
              { anonymous_mode: next },
              next ? 'Prezeráš anonymne' : 'Anonymný mód vypnutý',
            );
          }}
        />

        <View style={styles.links}>
          <LinkRow label="Notifikácie" onPress={() => router.push('/settings/notifications')} />
          <LinkRow label="Súkromie" onPress={() => router.push('/settings/privacy')} />
          <LinkRow label="Upraviť profil" onPress={() => router.push('/settings/profile')} />
          <LinkRow label="Uložené eventy" onPress={() => router.push('/settings/saved')} />
          {isAdmin ? <LinkRow label="Admin" onPress={() => router.push('/admin')} /> : null}
          {env.debugAi ? <LinkRow label="AI debug" onPress={() => router.push('/debug/ai')} /> : null}
        </View>

        <Button title="Odhlásiť sa" variant="ghost" onPress={() => void signOut()} />
      </ScrollView>

      <BottomSheet
        visible={premiumOpen}
        onClose={() => setPremiumOpen(false)}
        title="Blup Premium"
        subtitle="4,99 € mesačne. Pokročilé odporúčania, anonymný mód a prehľad, prečo ti čo navrhujeme."
        footer={
          <Button
            title="Pozrieť Premium"
            large
            onPress={() => {
              setPremiumOpen(false);
              router.push('/premium');
            }}
          />
        }
      >
        <Body muted>
          Predplatné sa účtuje cez App Store alebo Google Play a overuje sa na našich serveroch —
          preto sa kupuje na obrazovke Premium, nie prepínačom.
        </Body>
      </BottomSheet>
    </SafeAreaView>
  );
}

function Counter({ value, label }: { value: number; label: string }) {
  return (
    <View style={styles.counter}>
      <Text style={styles.counterValue}>{formatCount(value)}</Text>
      <Text style={styles.counterLabel}>{label}</Text>
    </View>
  );
}

function SettingRow({
  label, value, onToggle, note, disabled,
}: {
  label: string;
  value: boolean;
  onToggle: (next: boolean) => void;
  note?: string;
  disabled?: boolean;
}) {
  return (
    <View style={styles.settingRow}>
      <View style={styles.flex}>
        <Text style={[styles.settingLabel, disabled && styles.settingLabelDisabled]}>{label}</Text>
        {note ? <Text style={styles.settingNote}>{note}</Text> : null}
      </View>
      <Switch
        value={value}
        onValueChange={onToggle}
        trackColor={{ false: colors.surfaceElevated2, true: colors.accent }}
        thumbColor="#FFFFFF"
      />
    </View>
  );
}

function LinkRow({ label, onPress }: { label: string; onPress: () => void }) {
  return (
    <Pressable style={styles.linkRow} onPress={onPress}>
      <Text style={styles.linkLabel}>{label}</Text>
      <Text style={styles.linkGlyph}>›</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.background },
  // minWidth 0 so a long label can shrink inside a row instead of pushing
  // its neighbour out; react-native-web defaults flex items to min-width:auto.
  flex: { flex: 1, minWidth: 0 },
  content: { paddingHorizontal: spacing.gutter, paddingBottom: spacing.xxxl },

  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingTop: spacing.md,
    paddingBottom: spacing.xl,
  },
  screenTitle: { ...typography.screenTitle, color: colors.text },
  headerButton: {
    paddingHorizontal: spacing.lg,
    paddingVertical: 10,
    borderRadius: radius.chip,
    backgroundColor: colors.surfaceElevated2,
  },
  headerButtonLabel: { ...typography.chip, color: colors.text },

  identity: { flexDirection: 'row', gap: spacing.lg, alignItems: 'center' },
  name: { ...typography.profileName, color: colors.text },
  handle: { ...typography.metaSm, color: colors.textTertiary, marginTop: 2 },
  counters: { flexDirection: 'row', gap: spacing.lg, marginTop: spacing.md },
  counter: { flexDirection: 'row', alignItems: 'baseline', gap: 4 },
  counterValue: { ...typography.rowTitleSm, color: colors.accent },
  counterLabel: { ...typography.metaSm, color: colors.textTertiary },

  levelCard: { borderRadius: radius.card, padding: spacing.xl, gap: spacing.md, marginTop: spacing.xl },
  levelTop: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  levelTitle: { ...typography.subheading, color: '#FFFFFF' },
  levelXp: { ...typography.metaSm, color: 'rgba(255,255,255,0.86)' },
  track: { height: 8, borderRadius: 4, backgroundColor: 'rgba(255,255,255,0.28)', overflow: 'hidden' },
  trackFill: { height: 8, borderRadius: 4, backgroundColor: '#FFFFFF' },

  sectionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginTop: spacing.xxl,
    marginBottom: spacing.md,
  },
  section: { ...typography.heading, color: colors.text },
  sectionAction: { ...typography.chip, color: colors.accent },

  badgeRow: { gap: spacing.md },
  badge: {
    width: 92,
    height: 92,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
    padding: spacing.sm,
    gap: 6,
  },
  badgeEarned: { backgroundColor: 'rgba(0,128,255,0.14)', borderColor: colors.accentBorder },
  badgeEmoji: { fontSize: 24 },
  badgeEmojiLocked: { opacity: 0.35 },
  badgeName: { ...typography.monoSm, color: colors.textDisabled, textAlign: 'center' },
  badgeNameEarned: { color: colors.text },

  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md },
  chip: {
    paddingHorizontal: 15,
    paddingVertical: 11,
    borderRadius: radius.chip,
    backgroundColor: colors.surfaceElevated,
  },
  chipLabel: { ...typography.chip, fontSize: 14, color: colors.textSecondary },
  chipEdit: {
    paddingHorizontal: 15,
    paddingVertical: 11,
    borderRadius: radius.chip,
    backgroundColor: colors.accentSoft,
  },
  chipEditLabel: { ...typography.chip, fontSize: 14, color: colors.accent },

  dashed: {
    padding: spacing.xl,
    borderRadius: radius.card,
    borderWidth: 1,
    borderStyle: 'dashed',
    borderColor: colors.border,
    gap: spacing.md,
  },
  dashedAction: { ...typography.chip, color: colors.accent },

  agendaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.lg,
    borderRadius: radius.card,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginBottom: spacing.md,
  },
  agendaTitle: { ...typography.rowTitle, color: colors.text },
  agendaMeta: { ...typography.metaSm, color: colors.textTertiary, marginTop: 2 },
  agendaChip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: 11,
    backgroundColor: colors.surfaceElevated,
  },
  agendaChipGoing: { backgroundColor: colors.accentSoft },
  agendaChipLabel: { ...typography.micro, color: colors.textSecondary },

  ticket: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.lg,
    borderRadius: radius.card,
    borderWidth: 1,
    borderColor: colors.accentBorder,
    padding: spacing.lg,
    marginBottom: spacing.md,
  },
  ticketStrip: { ...typography.monoSm, color: colors.cyan },
  ticketTitle: { ...typography.rowTitle, color: colors.text },
  ticketMeta: { ...typography.metaSm, color: colors.textTertiary, marginTop: 2 },
  ticketCode: { ...typography.monoSm, color: colors.textMuted, marginTop: 4 },
  barcode: { flexDirection: 'row', gap: 2, height: 44, alignItems: 'stretch' },
  barcodeBar: { width: 2, backgroundColor: colors.text, borderRadius: 1 },

  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.md,
  },
  settingLabel: { ...typography.body, color: colors.text },
  settingLabelDisabled: { color: colors.textQuaternary },
  settingNote: { ...typography.monoSm, color: colors.textMuted, marginTop: 2 },

  links: { marginTop: spacing.lg, marginBottom: spacing.xl },
  linkRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: spacing.lg,
    borderBottomWidth: 1,
    borderBottomColor: colors.border,
  },
  linkLabel: { ...typography.body, color: colors.text },
  linkGlyph: { ...typography.heading, color: colors.textTertiary },
});
