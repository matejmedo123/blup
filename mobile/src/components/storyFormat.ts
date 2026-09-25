import * as ImageManipulator from 'expo-image-manipulator';

import { cropRect } from './imageCropMath';
import { STORY_WIDTH, STORY_HEIGHT } from './storyShape';

/**
 * Orezanie fotky na tvar príbehu.
 *
 * Samotný tvar — 1080 × 1920 a rámček, ktorý sa doň zmestí — býva v
 * `storyShape.ts`, bez jediného importu, aby sa naň dalo pýtať aj z Node-u.
 * Tu je to, čo bez `expo-image-manipulator` nejde: skutočný rez do súboru.
 */
export { STORY_WIDTH, STORY_HEIGHT, STORY_ASPECT, storyFrame } from './storyShape';

export interface StoryCrop {
  /** Násobok „akurát vyplní rámček“. 1 je najmenšie povolené priblíženie. */
  scale: number;
  /** Posun obrázka v rámčeku, v bodoch rámčeka. */
  offset: { x: number; y: number };
  /** Rozmery rámčeka, v ktorých bol posun meraný. */
  frame: { width: number; height: number };
  /** Rozmery zdrojovej fotky. */
  source: { width: number; height: number };
}

/**
 * Vyreže z fotky presne to, čo bolo vidno v rámčeku, a uloží to 1080 × 1920.
 *
 * Výrez počíta `cropRect` — tá istá funkcia, ktorá rámček aj kreslí. Keby
 * mal editor vlastnú matematiku, výsledok by sa od náhľadu líšil o pár
 * pixelov pri každom priblížení a nikto by nevedel prečo.
 */
export async function cropToStory(uri: string, crop: StoryCrop): Promise<string> {
  const rect = cropRect({
    imageW: crop.source.width,
    imageH: crop.source.height,
    frameW: crop.frame.width,
    frameH: crop.frame.height,
    scale: crop.scale,
    offset: crop.offset,
  });

  // ImageManipulator odmietne výrez, ktorý čo i len o pixel presahuje okraj,
  // takže sa zaokrúhľuje dnu, nie von.
  const originX = Math.max(0, Math.round(rect.sx));
  const originY = Math.max(0, Math.round(rect.sy));
  const width = Math.max(1, Math.min(Math.round(rect.sw), crop.source.width - originX));
  const height = Math.max(1, Math.min(Math.round(rect.sh), crop.source.height - originY));

  const context = ImageManipulator.ImageManipulator.manipulate(uri);
  context.crop({ originX, originY, width, height });
  // Zmenšuje sa až po orezaní: zmenšovať celú fotku a potom z nej rezať
  // znamená rezať z menej pixelov, než bolo treba.
  context.resize({ width: STORY_WIDTH, height: STORY_HEIGHT });

  const image = await context.renderAsync();
  const saved = await image.saveAsync({
    compress: 0.85,
    format: ImageManipulator.SaveFormat.JPEG,
  });
  return saved.uri;
}

/**
 * Orez na stred, bez toho aby sa niekoho pýtal.
 *
 * Toto je cesta pre fotku odfotenú priamo v príbehu. Snímač telefónu dáva
 * 4:3 aj vtedy, keď náhľad ukazoval 9:16, takže by sa bez tohto uložilo viac,
 * než bolo vidno v hľadáčiku. Stredový výrez sedí s tým, čo kamera ukazuje.
 */
export async function centreCropToStory(
  uri: string,
  sourceWidth: number,
  sourceHeight: number,
): Promise<string> {
  if (!sourceWidth || !sourceHeight) {
    // Bez rozmerov sa orezať nedá. Vrátiť pôvodné je lepšie než spadnúť —
    // prehrávač má rámček tak či tak a fotku doň vloží.
    return uri;
  }
  return cropToStory(uri, {
    scale: 1,
    offset: { x: 0, y: 0 },
    frame: { width: STORY_WIDTH, height: STORY_HEIGHT },
    source: { width: sourceWidth, height: sourceHeight },
  });
}
