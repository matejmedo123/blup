import React, { useEffect, useRef, useState } from 'react';
import { StyleSheet, Text, View } from 'react-native';

import { checkInTicket, parseTicketQr, type CheckInResult } from '@/api/tickets';
import { messageFor } from '@/lib/errors';
import { Body, Button, Caption, Input, Notice, Screen } from '@/components/ui';
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
 * Door scanner, in a browser.
 *
 * expo-camera's barcode scanning is a native module, so the web build uses the
 * browser's own `BarcodeDetector` against a `getUserMedia` stream. That API is
 * not everywhere yet (Safari in particular), so there is always a text field
 * as well — a doorman with a laptop can read the code off the PDF and type it.
 *
 * Either way the camera only *reads*; every decision — is it real, is it
 * already used, may this person scan it — is made by check_in_ticket() in the
 * database, exactly as on a phone.
 */
export default function ScanWebScreen() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lastScan = useRef<{ code: string; at: number } | null>(null);

  const detectorSupported =
    typeof window !== 'undefined' && 'BarcodeDetector' in window;

  // Starting at 'unsupported' where the API is missing, rather than at 'idle',
  // because 'idle' rendered "Zapni kameru" next to a button that was hidden for
  // exactly the same reason — an instruction with nothing to carry it out.
  // Safari has no BarcodeDetector, so this is what a doorman on an iPhone sees.
  const [cameraState, setCameraState] = useState<'idle' | 'starting' | 'live' | 'unsupported' | 'denied'>(
    detectorSupported ? 'starting' : 'unsupported',
  );
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (payload: string) => {
    const parsed = parseTicketQr(payload.trim());
    if (!parsed) {
      setError('Toto nie je vstupenka z BLUPu.');
      return;
    }

    const now = Date.now();
    if (lastScan.current?.code === parsed.code && now - lastScan.current.at < 2500) return;
    lastScan.current = { code: parsed.code, at: now };

    setError(null);
    setBusy(true);
    try {
      setResult(await checkInTicket(parsed.code, parsed.secret));
    } catch (caught) {
      setError(messageFor(caught));
    } finally {
      setBusy(false);
    }
  };

  const stopCamera = () => {
    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;
  };

  const startCamera = async () => {
    if (!detectorSupported) { setCameraState('unsupported'); return; }
    setCameraState('starting');
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment' },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play();
      }
      setCameraState('live');
    } catch {
      setCameraState('denied');
    }
  };

  // Poll the video for a QR while the camera is live. `requestAnimationFrame`
  // would run far faster than any scanner needs and heat up the laptop for
  // nothing; four looks a second is plenty for someone holding up a phone.
  useEffect(() => {
    if (cameraState !== 'live' || !detectorSupported) return;

    const Detector = (window as unknown as {
      BarcodeDetector: new (opts: { formats: string[] }) => {
        detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
      };
    }).BarcodeDetector;
    const detector = new Detector({ formats: ['qr_code'] });

    let stopped = false;
    const tick = async () => {
      if (stopped || !videoRef.current || videoRef.current.readyState < 2) return;
      try {
        const codes = await detector.detect(videoRef.current);
        if (codes[0]?.rawValue) await submit(codes[0].rawValue);
      } catch {
        // A frame that cannot be decoded is the normal case, not an error.
      }
    };

    const timer = setInterval(() => void tick(), 250);
    return () => { stopped = true; clearInterval(timer); };
  }, [cameraState, detectorSupported]);

  // The door is not the place to press a button first: the camera comes up with
  // the screen, so pointing the phone at a QR code is the whole interaction.
  // The permission prompt is the browser's, and getUserMedia does not need a
  // gesture to ask for it.
  useEffect(() => {
    if (detectorSupported) void startCamera();
    return stopCamera;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <Screen scroll>
      <Text style={styles.title}>Skener pri vstupe</Text>

      {cameraState === 'live' ? (
        <View style={styles.videoWrap}>
          {/* A real DOM element: this file only ever runs in a browser. */}
          <video
            ref={videoRef}
            muted
            playsInline
            style={{ width: '100%', borderRadius: 16, display: 'block', background: '#000' }}
          />
          <Caption style={styles.hint}>Namier kameru na QR kód vstupenky.</Caption>
        </View>
      ) : (
        <View style={styles.placeholder}>
          <Text style={styles.placeholderGlyph}>⌗</Text>
          <Body muted style={styles.center}>
            {cameraState === 'unsupported'
              ? 'Safari na iPhone zatiaľ nevie čítať QR kódy priamo v stránke. Otvor blup.sk v Chrome, alebo zadaj kód z vstupenky ručne nižšie — funguje to rovnako.'
              : cameraState === 'denied'
                ? 'Prístup ku kamere si zamietol. Povoľ ho v nastaveniach stránky, alebo zadaj kód ručne.'
                : 'Zapínam kameru…'}
          </Body>
          {detectorSupported ? (
            <Button
              title={cameraState === 'starting' ? 'Zapínam…' : 'Skúsiť kameru znova'}
              onPress={() => void startCamera()}
              loading={cameraState === 'starting'}
            />
          ) : null}
        </View>
      )}

      {error ? <Notice tone="danger" title="Nepodarilo sa odbaviť" body={error} /> : null}

      {result ? (
        <Notice
          tone={result.ok ? 'success' : 'danger'}
          title={result.ok ? 'Vstup potvrdený' : 'Neplatná'}
          body={
            result.ok
              ? [result.event_title, result.ticket_id ? `#${result.ticket_id.slice(0, 8)}` : null]
                  .filter(Boolean).join(' · ')
              : REASONS[result.reason ?? ''] ?? 'Túto vstupenku nemôžeme prijať.'
          }
        />
      ) : null}

      <View style={styles.manual}>
        <Caption>Ručné zadanie</Caption>
        <Input
          value={manual}
          onChangeText={setManual}
          placeholder="blup://t/BLP-…"
          autoCapitalize="none"
          autoCorrect={false}
        />
        <Button
          title="Odbaviť"
          variant="secondary"
          loading={busy}
          disabled={!manual.trim()}
          onPress={() => void submit(manual)}
        />
        <Caption>
          Skopíruj obsah QR kódu, alebo ho načítaj čítačkou — tá zvyčajne vloží kód ako text.
        </Caption>
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  title: { ...typography.heading, color: colors.text, marginBottom: spacing.md },
  videoWrap: { gap: spacing.sm },
  hint: { textAlign: 'center' },
  placeholder: {
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.xl,
    borderRadius: radius.lg,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  placeholderGlyph: { fontSize: 44, color: colors.textTertiary },
  center: { textAlign: 'center' },
  manual: { gap: spacing.sm, marginTop: spacing.xl },
});
