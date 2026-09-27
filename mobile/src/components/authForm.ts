/**
 * Ako široký smie byť prihlasovací formulár.
 *
 * Na monitore sa `Screen` drží v čitateľnom stĺpci — lenže „čitateľný" pre
 * odsek textu je 1180 px a pre políčko na heslo nie. Pole na e-mail široké
 * 1144 px vyzerá ako chyba a oko nemá kam skočiť z popisky na vstup.
 *
 * Vlastný súbor, aby sa naň mohla odvolať aj hlavička `(auth)` layoutu bez
 * toho, aby ju to zviazalo s ktoroukoľvek jednou obrazovkou.
 */
export const AUTH_FORM_MAX = 460;
