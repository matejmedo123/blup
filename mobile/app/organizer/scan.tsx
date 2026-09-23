import React, { useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { checkInTicket, parseTicketQr, type CheckInResult } from '@/api/tickets';
import { getDoorState } from '@/api/organizations';
import { messageFor } from '@/lib/errors';
import { Body, Button, Caption, Notice, Screen } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

const REASONS: Record<string, string> = {
  TICKET_NOT_FOUND: 'Takáto vstupenka neexistuje. Tento kód nie je z BLUPu.',
  INVALID_SIGNATURE: 'Tento QR kód nie je pravý.',
  ALREADY_USED: 'Už bola použitá pri vstupe.',
  NOT_AUTHORIZED: 'Tento event nerobíš ty.',
  WRONG_EVENT: 'Táto vstupenka je na iný event.',
  REFUNDED: 'Táto vstupenka bola refundovaná.',
  CANCELLED: 'Táto vstupenka bola zrušená.',
};

/**
 * Door scanner.
 *
 * The camera only reads the code — every decision (is it real, is it already
 * used, may this person scan it) is made by check_in_ticket() in the database.
 */
export default function ScanScreen() {
  const [permission, requestPermission] = useCameraPermissions();
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  const lastScan = useRef<{ code: string; at: number } | null>(null);

  /**
   * How the room is filling up.
   *
   * The scanner knew whether one ticket was good and nothing about the other
   * six hundred. Standing at the door, the number you want between scans is how
   * many are inside and how many can still turn up — so it is read after each
   * scan, from the event the scan just named.
   */
  const door = useQuery({
    queryKey: ['door', result?.event_id],
    queryFn: () => getDoorState(result!.event_id!),
    enabled: Boolean(result?.ok && result?.event_id),
  });

  const onScanned = async ({ data }: { data: string }) => {
    if (!scanning) return;

    const parsed = parseTicketQr(data);
    if (!parsed) {
      setError('Toto nie je vstupenka z BLUPu.');
      return;
    }

    // Ignore the same code re-read within two seconds (cameras fire fast).
    const now = Date.now();
    if (lastScan.current?.code === parsed.code && now - lastScan.current.at < 2000) return;
    lastScan.current = { code: parsed.code, at: now };

    setScanning(false);
    setError(null);

    try {
      const outcome = await checkInTicket(parsed.code, parsed.secret);
      setResult(outcome);
    } catch (caught) {
      setError(messageFor(caught));
    }
  };

  const scanNext = () => {
    setResult(null);
    setError(null);
    setScanning(true);
  };

  if (!permission) return <Screen><Body>Overujem prístup ku kamere…</Body></Screen>;

  if (!permission.granted) {
    return (
      <Screen scroll>
        <Notice
          tone="warning"
          title="Potrebujeme prístup ku kamere"
          body="BLUP používa kameru iba na čítanie QR kódov vstupeniek pri vstupe."
        />
        <Button title="Povoliť kameru" onPress={() => void requestPermission()} />
      </Screen>
    );
  }

  return (
    <View style={styles.container}>
      <CameraView
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
        onBarcodeScanned={scanning ? onScanned : undefined}
      />

      <View style={styles.frame} pointerEvents="none">
        <View style={styles.reticle} />
        <Text style={styles.hint}>Namier na QR kód vstupenky</Text>
      </View>

      {(result || error) ? (
        <View style={styles.sheet}>
          {error ? (
            <>
              <Text style={styles.resultEmoji}>⚠️</Text>
              <Text style={styles.resultTitle}>Nepodarilo sa odbaviť</Text>
              <Body muted style={styles.resultBody}>{error}</Body>
            </>
          ) : result?.ok ? (
            <>
              <Text style={styles.resultEmoji}>✅</Text>
              <Text style={[styles.resultTitle, { color: colors.success }]}>Vstup potvrdený</Text>
              <Body muted style={styles.resultBody}>{result.event_title}</Body>
              {door.data ? (
                <Caption style={styles.doorLine}>
                  Vnútri {door.data.inside} · ešte treba odbaviť {door.data.to_admit}
                </Caption>
              ) : null}
            </>
          ) : (
            <>
              <Text style={styles.resultEmoji}>⛔</Text>
              <Text style={[styles.resultTitle, { color: colors.danger }]}>Neplatná</Text>
              <Body muted style={styles.resultBody}>
                {REASONS[result?.reason ?? ''] ?? result?.reason ?? 'Táto vstupenka sa nedá použiť.'}
              </Body>
              {result?.checked_in_at ? (
                <Caption>Scanned at {new Date(result.checked_in_at).toLocaleTimeString()}</Caption>
              ) : null}
            </>
          )}

          <Button title="Skenovať ďalšiu" onPress={scanNext} style={styles.nextButton} />
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#000' },

  frame: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', gap: spacing.xl },
  reticle: {
    width: 240,
    height: 240,
    borderRadius: radius.xl,
    borderWidth: 3,
    borderColor: colors.accent,
  },
  hint: { ...typography.caption, color: '#FFFFFF' },

  sheet: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: colors.background,
    borderTopLeftRadius: radius.xl,
    borderTopRightRadius: radius.xl,
    padding: spacing.xl,
    paddingBottom: spacing.xxxl,
    alignItems: 'center',
    gap: spacing.sm,
  },
  resultEmoji: { fontSize: 44 },
  resultTitle: { ...typography.heading, color: colors.text },
  resultBody: { textAlign: 'center' },
  doorLine: { marginTop: spacing.xs },
  nextButton: { marginTop: spacing.lg, alignSelf: 'stretch' },
});
