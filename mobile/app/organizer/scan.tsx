import React, { useRef, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { CameraView, useCameraPermissions } from 'expo-camera';

import { checkInTicket, parseTicketQr, type CheckInResult } from '@/api/tickets';
import { messageFor } from '@/lib/errors';
import { Body, Button, Caption, Notice, Screen } from '@/components/ui';
import { colors, radius, spacing, typography } from '@/theme';

const REASONS: Record<string, string> = {
  TICKET_NOT_FOUND: 'No such ticket. This code is not from BLUP.',
  INVALID_SIGNATURE: 'This QR code is not genuine.',
  ALREADY_USED: 'Already checked in.',
  NOT_AUTHORIZED: 'You do not run this event.',
  WRONG_EVENT: 'This ticket is for a different event.',
  REFUNDED: 'This ticket was refunded.',
  CANCELLED: 'This ticket was cancelled.',
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

  const onScanned = async ({ data }: { data: string }) => {
    if (!scanning) return;

    const parsed = parseTicketQr(data);
    if (!parsed) {
      setError('That is not a BLUP ticket.');
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

  if (!permission) return <Screen><Body>Checking camera access…</Body></Screen>;

  if (!permission.granted) {
    return (
      <Screen scroll>
        <Notice
          tone="warning"
          title="Camera access needed"
          body="BLUP uses the camera only to read ticket QR codes at the door."
        />
        <Button title="Allow camera" onPress={() => void requestPermission()} />
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
        <Text style={styles.hint}>Point at the ticket QR code</Text>
      </View>

      {(result || error) ? (
        <View style={styles.sheet}>
          {error ? (
            <>
              <Text style={styles.resultEmoji}>⚠️</Text>
              <Text style={styles.resultTitle}>Could not check in</Text>
              <Body muted style={styles.resultBody}>{error}</Body>
            </>
          ) : result?.ok ? (
            <>
              <Text style={styles.resultEmoji}>✅</Text>
              <Text style={[styles.resultTitle, { color: colors.success }]}>Checked in</Text>
              <Body muted style={styles.resultBody}>{result.event_title}</Body>
            </>
          ) : (
            <>
              <Text style={styles.resultEmoji}>⛔</Text>
              <Text style={[styles.resultTitle, { color: colors.danger }]}>Not valid</Text>
              <Body muted style={styles.resultBody}>
                {REASONS[result?.reason ?? ''] ?? result?.reason ?? 'This ticket cannot be used.'}
              </Body>
              {result?.checked_in_at ? (
                <Caption>Scanned at {new Date(result.checked_in_at).toLocaleTimeString()}</Caption>
              ) : null}
            </>
          )}

          <Button title="Scan the next one" onPress={scanNext} style={styles.nextButton} />
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
  nextButton: { marginTop: spacing.lg, alignSelf: 'stretch' },
});
