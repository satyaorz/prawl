# Prowl — the website

The marketing site and handbook for the Prowl wallet. It is a separate app from
the wallet on purpose: the wallet's passkeys (WebAuthn) are bound to its exact
origin, so the site only ever links to the wallet and never tries to host it.

```
apps/site
├── public/
│   ├── apk/prowl.apk      the Android app, built from offline/app (see below)
│   ├── shots/             real screenshots of the wallet (captured, not drawn)
│   └── prowl-logo.png     the same mark the wallet ships
├── src/
│   ├── content/chapters.ts   every handbook chapter, as data
│   ├── pages/Home.tsx        the one-screen landing page
│   ├── pages/Docs.tsx        the handbook, with the chapter sidebar
│   └── lib/router.ts         a three-view router (no dependency)
└── scripts/capture-shots.mjs real screenshots from a running wallet dev server
```

## Design

The palette is the wallet's own: near-black surfaces (`#08090b`, zinc-900
panels), emerald for every primary action, and the logo's yellow used only for
the mark. Layout is fixed-height on purpose — **the page never scrolls**: a
permanent top bar (mark, name, App, Docs, Open), the claim and summary on the
left, the overlapping product screenshots on the right, and the two ways in
directly under them. On phones it stacks and still fits; only a ≤359px-wide
device falls back to scrolling.

## Run

```sh
pnpm install
pnpm --filter @prawl/site dev        # http://localhost:5181
pnpm --filter @prawl/site build      # apps/site/dist
pnpm --filter @prawl/site typecheck
```

## Refresh the screenshots

The screenshots are the real UI, driven into a funded-looking state by the
wallet's dev-only `devSetState` hook. With the wallet dev server running:

```sh
pnpm --filter @prawl/wallet dev &     # http://localhost:5173
node apps/site/scripts/capture-shots.mjs
```

## Refresh the APK

`public/apk/prowl.apk` is the `prawl` debug flavor of the Android app
(package `xyz.prawl.offline`, Android 12+). Rebuild and copy it with:

```sh
pnpm --filter @prawl/site apk
```

Or by hand:

```sh
cd offline/app
ANDROID_HOME=$HOME/Android/Sdk ./gradlew assembleDebug -Pprawl.site=https://<your-wallet-site>
cp app/build/outputs/apk/prawl/debug/app-prawl-debug.apk ../../apps/site/public/apk/prowl.apk
```

A debug build is signed with the debug key: fine for testing offline cash, not
for release.

## Point the buttons at your wallet

The wallet origin defaults to `https://prawl-wallet.centralindia.cloudapp.azure.com`. Override it at
build time:

```sh
VITE_WALLET_URL=https://your-wallet-domain pnpm --filter @prawl/site build
```

The passkey is bound to that domain, so choose it once and keep it.

## Deploy

`apps/site` is a static site. `vercel.json` sets the SPA rewrite (so
`/docs/anything` resolves), security headers, immutable caching for hashed
assets, and `Content-Disposition: attachment` on the APK.
