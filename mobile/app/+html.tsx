import React from 'react';
import { ScrollViewStyleReset } from 'expo-router/html';
import type { PropsWithChildren } from 'react';

/**
 * The HTML shell for the web build.
 *
 * Only rendered at build time in Node, never in the browser — so nothing here
 * has access to the DOM or to app state. Its job is the things a single-page
 * app cannot set from inside React: the document language, the theme colour the
 * browser paints its chrome with, and the card that appears when somebody
 * pastes a Blup link into a chat.
 */
const TITLE = 'Blup — eventy okolo teba';
const DESCRIPTION =
  'Nájdi, čo sa dnes deje v tvojom meste, kúp si lístok na jednom mieste a choď tam s ľuďmi, ' +
  'ktorých poznáš.';
const URL = process.env.EXPO_PUBLIC_WEB_URL ?? 'https://blup.app';

export default function Root({ children }: PropsWithChildren) {
  return (
    <html lang="sk">
      <head>
        <meta charSet="utf-8" />
        <meta httpEquiv="X-UA-Compatible" content="IE=edge" />
        {/* viewport-fit=cover so the layout reaches under a phone's notch */}
        <meta
          name="viewport"
          content="width=device-width, initial-scale=1, shrink-to-fit=no, viewport-fit=cover"
        />

        <title>{TITLE}</title>
        <meta name="description" content={DESCRIPTION} />
        <meta name="theme-color" content="#0A0D12" />
        <meta name="color-scheme" content="dark" />
        <meta name="apple-mobile-web-app-capable" content="yes" />
        <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent" />
        <meta name="apple-mobile-web-app-title" content="Blup" />

        <meta property="og:type" content="website" />
        <meta property="og:site_name" content="Blup" />
        <meta property="og:title" content={TITLE} />
        <meta property="og:description" content={DESCRIPTION} />
        <meta property="og:url" content={URL} />
        <meta property="og:image" content={`${URL}/og.png`} />
        <meta property="og:locale" content="sk_SK" />
        <meta name="twitter:card" content="summary_large_image" />

        <link rel="icon" href="/favicon.ico" />
        <link rel="apple-touch-icon" href="/apple-touch-icon.png" />
        <link rel="manifest" href="/manifest.webmanifest" />

        {/*
          Disables the body scroll that react-native-web's ScrollView would
          otherwise fight with — without it the page scrolls twice, once inside
          the app and once outside it.
        */}
        <ScrollViewStyleReset />

        <style dangerouslySetInnerHTML={{ __html: SHELL_CSS }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

/**
 * The ground the app is painted on. Set here as well as in the app so the page
 * is never white for the moment between first paint and hydration — on a dark
 * product that flash reads as a broken page.
 */
const SHELL_CSS = `
  html, body { background-color: #0A0D12; color-scheme: dark; }
  body { overscroll-behavior-y: none; -webkit-font-smoothing: antialiased; }
  /* Keyboard focus must stay visible in a browser, where it is the only way
     some people navigate at all. */
  :focus-visible { outline: 2px solid #0080FF; outline-offset: 2px; }
  ::selection { background: #0080FF; color: #fff; }
`;
