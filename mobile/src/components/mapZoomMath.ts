/**
 * Koľko úrovní zoomu si zaslúži otočenie kolieska.
 *
 * Bez importov, zámerne: mapa podľa toho zoomuje a `scripts/check-map-zoom.mjs`
 * sa na to isté pýta z Node-u. Keby si test niesol vlastnú kópiu tohto výpočtu,
 * prechádzal by aj vtedy, keď je mapa pokazená — presne ako pri `imageCropMath`.
 *
 * Dvakrát to tu bolo zle a zakaždým opačne:
 *
 *   1. Najprv jedna úroveň na každú udalosť. Trackpad ich pošle pri jednom
 *      švihu desiatky, takže mapa preletela pol Európy. („strasne senzitivna")
 *   2. Potom sa udalosti sčítavali, ale po každom kroku sa počítadlo vynulovalo
 *      a krok bol vždy nanajvýš jedna úroveň. Švih za päť zárezov tak kúpil
 *      jednu a zvyšok skončil v koši. („oddalovanie je moc slabe")
 *
 * Jadro problému je, že myš a trackpad hlásia to isté `deltaMode 0` a pritom
 * posielajú celkom iné čísla. Myš pošle jednu udalosť s deltaY 100 — to je
 * jeden zárez a má to byť presne jedna úroveň. Trackpad pošle tridsať udalostí
 * po osem až dvadsať pixelov. Jedno delenie nemôže sedieť obom: deliteľ, pri
 * ktorom sedí myš, spraví z jemného potiahnutia po trackpade nulu.
 *
 * Preto sa rozlišujú podľa veľkosti kroku a švih po trackpade má navyše strop
 * na celé gesto — inak zotrvačné rolovanie na Macu pošle tisíce pixelov a
 * mapa je späť pri probléme číslo jedna.
 */

/** Nad touto hodnotou je krok zárez myši, pod ňou pohyb prsta po trackpade. */
const NOTCH_THRESHOLD = 50;
/** Jeden zárez myši je presne jedna úroveň. */
const PIXELS_PER_NOTCH = 100;
/**
 * Koľko pixelov po trackpade je jedna úroveň.
 *
 * Menej než zárez myši, lebo prst prejde kratšiu dráhu než spraví koliesko
 * zárezov. Pri 55 dá jemné potiahnutie (okolo 90 pixelov) jednu úroveň, čo je
 * presne to, čo od neho človek čaká.
 */
const PIXELS_PER_LEVEL_TRACKPAD = 55;
/** Strop na jednu udalosť, nech myš s hladkým rolovaním neuletí. */
export const MAX_LEVELS_PER_EVENT = 4;
/** Strop na jedno súvislé gesto — proti zotrvačnému rolovaniu. */
export const MAX_LEVELS_PER_GESTURE = 5;
/** Po takomto tichu sa ďalšia udalosť ráta ako nové gesto. */
export const GESTURE_GAP_MS = 140;

export interface WheelState {
  /** Nedokončená časť úrovne, prenesená do ďalšej udalosti. */
  carry: number;
  /** Koľko úrovní už minulo prebiehajúce gesto. */
  spent: number;
  /** Kedy prišla posledná udalosť. */
  lastAt: number;
}

export const IDLE_WHEEL: WheelState = { carry: 0, spent: 0, lastAt: 0 };

export interface WheelStep {
  /** O koľko úrovní pohnúť. Kladné je priblíženie, záporné oddialenie. */
  levels: number;
  /** Stav, s ktorým sa má zavolať nasledujúca udalosť. */
  state: WheelState;
}

/**
 * @param deltaY     surová hodnota z udalosti
 * @param deltaMode  0 pixely, 1 riadky, 2 stránky
 * @param state      stav z predchádzajúcej udalosti
 * @param now        čas udalosti v milisekundách
 */
export function wheelZoomStep(
  deltaY: number,
  deltaMode: number,
  state: WheelState,
  now: number,
): WheelStep {
  // Riadky a stránky hlási len myš a hlási ich po zárezoch, takže sa prepočítajú
  // rovno na zárezy. Bez toho je trackpad (pixely) a myš (riadky) vedľa seba
  // o šestnásťnásobok.
  const perUnit = deltaMode === 1 ? 3
    : deltaMode === 2 ? 1
      : Math.abs(deltaY) >= NOTCH_THRESHOLD ? PIXELS_PER_NOTCH
        : PIXELS_PER_LEVEL_TRACKPAD;

  // Ticho znamená, že predošlé gesto skončilo — aj s tým, čo mu zostalo v
  // počítadle. Prenášať zvyšok cez pauzu by znamenalo, že prvé pohnutie po
  // chvíli nečinnosti skočí o úroveň navyše.
  const fresh = now - state.lastAt > GESTURE_GAP_MS;
  const carry = fresh ? 0 : state.carry;
  const spent = fresh ? 0 : state.spent;

  const total = carry + deltaY / perUnit;
  const whole = Math.trunc(total);

  if (whole === 0) {
    return { levels: 0, state: { carry: total, spent, lastAt: now } };
  }

  // Dva stropy: jeden na udalosť, jeden na celé gesto.
  const room = Math.max(0, MAX_LEVELS_PER_GESTURE - spent);
  const magnitude = Math.min(MAX_LEVELS_PER_EVENT, Math.abs(whole), room);
  // Rolovanie nahor (záporná deltaY) je priblíženie.
  const levels = magnitude === 0 ? 0 : (whole < 0 ? magnitude : -magnitude);

  return {
    levels,
    state: { carry: total - whole, spent: spent + magnitude, lastAt: now },
  };
}
