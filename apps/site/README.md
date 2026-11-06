# Prowl — the website

The marketing site and handbook for the Prowl wallet. It is a separate app from
the wallet on purpose: the wallet's passkeys (WebAuthn) are bound to its exact
origin, so the site only ever links to the wallet and never tries to host it.

```
apps/site
├── public/
│   ├── apk/               (empty in git) where a locally built APK goes; the download button uses GitHub, see below
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

## The screenshots

`public/shots/` are real screenshots taken on a phone running the Android app (the Wallet tab and the native Offline cash tab),
not drawn and not generated from a fake state. They were captured over `adb` with the WebView driven through Chrome DevTools
(open the sheet, tap the tab, `adb exec-out screencap`), then cropped to remove the status bar and **the wallet and address
text was blurred** (the account chip and the Private and Public address rows) before they were committed. The balances shown are
test-network ETH. To refresh them, repeat that on a device and redact the same places; never commit an unredacted capture of
a wallet you care about.

(`scripts/capture-shots.mjs` is the older script that photographed a desktop dev server in a made-up state. It is not used for
the current images.)

## The APK

"Download APK" links to the latest GitHub release, `releases/latest/download/prowl.apk`. That release is built and
published by `.github/workflows/android-apk.yml` whenever `offline/app` changes on `dev` (or by hand from the Actions tab).
Nothing large is committed to git.

The app must be signed with the key the wallet site vouches for (`assetlinks.json`), otherwise passkeys do not work in the
app. The workflow refuses to run without that key (repository secret `ANDROID_DEBUG_KEYSTORE_B64`, set once with
`base64 -w0 offline/app/keystore/prawl-debug.keystore | gh secret set ANDROID_DEBUG_KEYSTORE_B64`) and checks the finished
APK's certificate before it publishes. Override the link at build time with `VITE_APK_URL`.

To build one locally (it lands, untracked, in `public/apk/`):

```sh
pnpm --filter @prawl/site apk
```

A debug build is signed with the debug key: fine for testing, not for release.

## Point the buttons at your wallet

The wallet origin defaults to `https://prawl-wallet.centralindia.cloudapp.azure.com`. Override it at
build time:

```sh
VITE_WALLET_URL=https://your-wallet-domain pnpm --filter @prawl/site build
```

The passkey is bound to that domain, so choose it once and keep it.

## GitHub Pages

The site can be served from GitHub Pages at `https://satyaorz.github.io/prawl/`. A project page lives under a sub-path, so
the Pages build sets `VITE_BASE=/prawl/` (every path the site builds goes through `url()` in `src/lib/router.ts`) and writes a
`404.html` copy of the app, which is how Pages serves a direct link such as `/prawl/docs/private-swap`.

```sh
pnpm --filter @prawl/site build:pages     # apps/site/dist, for the /prawl/ sub-path
pnpm --filter @prawl/site publish:pages   # builds, then force-pushes the result as the gh-pages branch
```

It publishes without GitHub Actions, so it works while Actions is unavailable. In the repository's Pages settings the source
is the `gh-pages` branch, root. (On Vercel or a custom domain, use `pnpm --filter @prawl/site build`: the base is `/`.)

## Deploy

`apps/site` is a static site. `vercel.json` sets the SPA rewrite (so
`/docs/anything` resolves), security headers, and immutable caching for hashed
assets.
