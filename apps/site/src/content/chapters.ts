/**
 * The handbook. Chapters are data so the sidebar, the prev/next links and the
 * search all read from one source.
 *
 * Blocks are deliberately small and typed: a paragraph, a list, a callout, a
 * table, steps, code. The renderer in pages/Docs.tsx turns them into markup.
 */
export type Block =
  | { t: "p"; text: string }
  | { t: "lead"; text: string }
  | { t: "h"; text: string }
  | { t: "ul"; items: string[] }
  | { t: "ol"; items: string[] }
  | { t: "steps"; items: { title: string; text: string }[] }
  | { t: "note"; kind: "info" | "warn" | "ok"; title?: string; text: string }
  | { t: "table"; head: string[]; rows: string[][] }
  | { t: "code"; text: string; lang?: string };

export interface Chapter {
  slug: string;
  title: string;
  group: string;
  /** One line, for the sidebar tooltip and the docs index. */
  summary: string;
  blocks: Block[];
}

export const CHAPTERS: Chapter[] = [
  {
    slug: "introduction",
    title: "What Prowl is",
    group: "Getting started",
    summary: "A private Ethereum wallet with Tor, passkeys and offline cash.",
    blocks: [
      {
        t: "lead",
        text: "Prowl is a privacy-first Ethereum wallet. Your real balance is shielded, every network request takes its own Tor circuit, and your keys come from a passkey instead of a seed phrase. It also ships an Android app that lets two phones pay each other with no network at all.",
      },
      { t: "h", text: "Two privacy stories in one app" },
      {
        t: "table",
        head: ["Story", "What it hides", "How"],
        rows: [
          ["Online wallet", "What you own and who you pay", "RAILGUN shielded pool + Tor per identity"],
          ["Offline cash", "That a payment happened at all", "Hardware one-time keys + escrow-backed coins over Bluetooth"],
        ],
      },
      {
        t: "p",
        text: "The public account you see next to your private one is only the way in and out. It is what you fund, and what you withdraw to. Everything in between happens inside the shielded pool, where amounts and counterparties are not public.",
      },
      {
        t: "note",
        kind: "warn",
        title: "Testnet only",
        text: "Prowl runs on Ethereum Sepolia (chain 11155111). Do not put real money into it yet. The passkey is bound to the site's domain, so a real wallet should only be created after the final domain is chosen.",
      },
      { t: "h", text: "What you need" },
      {
        t: "ul",
        items: [
          "A recent Chrome, Edge or Safari with a screen lock or security key set up (this is what makes passkeys work).",
          "Some Sepolia ETH to shield. A faucet is enough.",
          "For offline cash: an Android 12 or newer phone, and Bluetooth.",
        ],
      },
    ],
  },

  {
    slug: "create-wallet",
    title: "Create a wallet",
    group: "Getting started",
    summary: "One passkey, about twenty seconds, no seed phrase.",
    blocks: [
      {
        t: "lead",
        text: "Creating a wallet is a single passkey prompt. There is no seed phrase to write down and nothing is stored on a server: the passkey derives every key the wallet needs.",
      },
      {
        t: "steps",
        items: [
          {
            title: "Open the wallet",
            text: "Open in browser. It must be the wallet's own origin, on localhost or a real domain — passkeys do not work over a bare IP address.",
          },
          {
            title: "Wait for Tor",
            text: "The status line under the buttons turns green when the in-browser Tor client is connected. This is the only thing that talks to the chain.",
          },
          {
            title: "Choose Create wallet",
            text: "Your browser asks to create a passkey. Approve it with your fingerprint, face, PIN or security key. This passkey is the wallet.",
          },
          {
            title: "Let it open",
            text: "Prowl derives the RAILGUN spending and viewing keys, the public account key and a storage key, then loads a public pool snapshot. A new wallet is usually ready in about twenty seconds over Tor.",
          },
        ],
      },
      {
        t: "note",
        kind: "info",
        title: "Which key is which",
        text: "The passkey (WebAuthn PRF) is the root. From it, HKDF derives four things: the RAILGUN spending key, the RAILGUN viewing key, the public EVM account, and a storage key that seals the local database with AES-GCM.",
      },
      { t: "h", text: "If you already have a wallet" },
      {
        t: "p",
        text: "On a new device, choose Restore with passkey and use the same synced passkey. Prowl asks the passkey for the wallet's creation time and replays only from there, so you do not rescan the whole chain. If the replay still misses history, Full rescan in settings is the escape hatch.",
      },
    ],
  },

  {
    slug: "fund-and-shield",
    title: "Fund and shield",
    group: "Using the wallet",
    summary: "Send ETH to your public account, then shield it into the private balance.",
    blocks: [
      {
        t: "lead",
        text: "Money arrives at your public account and then moves into the shielded pool. Shielding is the moment your balance stops being public.",
      },
      {
        t: "steps",
        items: [
          { title: "Copy your public address", text: "On the main screen, under the balance, the Public row is your EVM account. Send Sepolia ETH there from any faucet or wallet." },
          { title: "Tap Shield", text: "Choose how much to move into the pool. The transaction calls the RAILGUN smart wallet for your account." },
          { title: "Wait for the PPOI check", text: "New shields wait for a proof-of-innocence check before they become spendable — two to four minutes on Sepolia, longer on a busy network. The wallet refreshes every minute and shows each note's state." },
          { title: "Spend from the private balance", text: "Once the note reads Valid, the amount appears as spendable and you can send or withdraw it." },
        ],
      },
      {
        t: "table",
        head: ["State", "What it means"],
        rows: [
          ["Missing", "The note has not been checked yet. Wait."],
          ["Valid", "The note is spendable."],
          ["ProofSubmitted", "Your proof is queued and will be sent on the next sync."],
          ["ShieldBlocked", "The note cannot enter the pool. It stays out of your spendable balance."],
        ],
      },
      {
        t: "note",
        kind: "warn",
        title: "Shield, then wait",
        text: "Withdrawing immediately after shielding can link the two on-chain. Prowl warns you when a withdrawal would do that.",
      },
    ],
  },

  {
    slug: "private-send",
    title: "Send privately",
    group: "Using the wallet",
    summary: "An ERC-4337 user operation from a fresh one-time sender.",
    blocks: [
      {
        t: "lead",
        text: "A private send is an ERC-4337 user operation sent from a brand-new one-time EIP-7702 sender, with gas paid from your private balance. The sender has no ETH and no history, so there is nothing to link back to you.",
      },
      {
        t: "ul",
        items: [
          "Enter a 0zk recipient address and an amount.",
          "Prowl checks the amount fits, including the fee, before it proves anything.",
          "The RAILGUN paymaster takes the gas from your private balance, not from the sender.",
          "Proofs that are still queued are submitted on the following syncs, automatically.",
        ],
      },
      {
        t: "note",
        kind: "warn",
        title: "Sending publicly",
        text: "The Send screen also has a Public tab: it sends ETH from your public account to any 0x address. That is an ordinary transaction, so it links the two addresses on chain.",
      },
      {
        t: "note",
        kind: "info",
        title: "Why a new sender each time",
        text: "Reusing one sender would build a history: everything it ever paid would sit under one address. A fresh sender per operation means a payment leaves no trail, only a fee paid inside the pool.",
      },
    ],
  },

  {
    slug: "withdraw",
    title: "Withdraw to a public address",
    group: "Using the wallet",
    summary: "Exit as native ETH or WETH, with linking warnings.",
    blocks: [
      {
        t: "lead",
        text: "A withdrawal unshields to a public address. It is the moment you become visible on chain again, so Prowl tells you when a specific exit is a bad idea.",
      },
      {
        t: "ul",
        items: [
          "Withdraw as native ETH or as WETH.",
          "Withdrawing to your own public account, or right after a shield, links the two — the wallet warns you first.",
          "Gas comes from the private balance and is checked to fit before the expensive proving step.",
          "The unshield fee is shown from the chain's own configuration.",
        ],
      },
      {
        t: "note",
        kind: "ok",
        title: "A quieter path",
        text: "If the goal is simply to have the money somewhere public and quiet, cash out into a fresh address that has never touched your wallet, and let some time pass after shielding.",
      },
    ],
  },

  {
    slug: "private-swap",
    title: "Private swap",
    group: "Using the wallet",
    summary: "Swap WETH for the PRAWL test token on Uniswap v4, in an encrypted batch.",
    blocks: [
      {
        t: "lead",
        text: "A private swap trades WETH for PRAWL, a test token, on a Uniswap v4 pool. Your order is encrypted and waits in a batch with other people's orders; only the batch's net trade reaches Uniswap. It runs on Sepolia only.",
      },
      {
        t: "steps",
        items: [
          { title: "Open Swap", text: "On the main screen, tap Swap. Keep Fresh private account selected: it is a new account derived from your passkey, with no transaction linking it to your main address." },
          { title: "Fund a swap account", text: "Enter an amount of ETH and tap Fund new swap account. It moves that amount (plus a little for gas) out of your private balance. This takes about two minutes, because a proof is built first." },
          { title: "Open the swap dashboard", text: "The first time, it downloads Zama's encryption keys over Tor, which can take a minute." },
          { title: "Swap privately", text: "Enter an amount and tap Swap privately. Amounts are whole lots (a lot is a fixed small size shown on screen) and are rounded down. Prowl wraps, funds the vault and places your encrypted order." },
          { title: "Wait for the batch", text: "A batch settles once at least two accounts have ordered. Keep the sheet open: your wallet closes the batch, trades the net on Uniswap and credits your payout by itself. If the batch does not fill in time, your order is refunded." },
          { title: "Withdraw or shield back", text: "Withdraw the payout to the swap account, and use Shield back to return leftover WETH to your private balance." },
        ],
      },
      {
        t: "table",
        head: ["Hidden", "Not hidden"],
        rows: [
          ["Each order's direction and size", "That a swap account wrapped, funded and exited, and those amounts"],
          ["How much of a batch was matched", "Which accounts took part in a batch"],
          ["Each payout and vault balance", "The batch's net trade on Uniswap, and its price"],
        ],
      },
      {
        t: "note",
        kind: "warn",
        title: "Testnet, and not anonymity",
        text: "With few participants the net trade can reveal individual orders, and one extra account is enough to meet the minimum of two. Treat it as order-intent privacy on a test network. PRAWL is an ordinary token that Prowl cannot shield yet, so it stays in the swap account.",
      },
    ],
  },

  {
    slug: "offline-cash",
    title: "Offline cash",
    group: "Offline cash",
    summary: "Pay another phone with no network, then cash out online.",
    blocks: [
      {
        t: "lead",
        text: "Offline cash lets two phones pay each other with no network at all. The coins are backed by ETH locked in an on-chain escrow and are secured by the phone's one-time hardware keys. You mint a coin, hand it over by Bluetooth, and whoever ends up with it cashes out online later.",
      },
      { t: "h", text: "The four moves" },
      {
        t: "table",
        head: ["Move", "Who", "What happens"],
        rows: [
          ["Load", "You, online", "Mint a coin from your public account, or privately from the shielded balance."],
          ["Cash out", "Recipient", "The coin is redeemed to a public address, or shielded back into a private balance."],
          ["Refresh", "Holder", "Extend a coin before it expires, so it stays redeemable."],
          ["Reclaim", "You", "Check expired, unspent coins and refund the escrow to yourself."],
        ],
      },
      { t: "h", text: "Loading a coin" },
      {
        t: "steps",
        items: [
          { title: "Show your depositor QR", text: "In the Offline tab, tap Before minting: show my depositor QR. The phone scans it to learn where to send its signed request." },
          { title: "Pick public or private", text: "A public load comes from the account you funded. A private load commits, unshields to the coin's deposit address and activates it, so the coin never touches your public balance." },
          { title: "Hand the link or QR over", text: "The coin leaves as a link (#/offline/load?d=…) or a QR code. The phone keeps the one-time key in hardware." },
        ],
      },
      {
        t: "note",
        kind: "info",
        title: "Judged by events, not promises",
        text: "Every offline operation is simulated before it is sent, and Prowl only treats a coin as paid when the escrow's own events say so.",
      },
      {
        t: "note",
        kind: "warn",
        title: "Coins expire",
        text: "A coin is only redeemable until its expiry. Refresh it if a handoff is taking a while, and reclaim the escrow if a coin is never spent.",
      },
    ],
  },

  {
    slug: "install-app",
    title: "Install the Android app",
    group: "Apps",
    summary: "Download the APK, allow the install, and pair with the website.",
    blocks: [
      {
        t: "lead",
        text: "The Android app is what makes offline cash possible: it holds the one-time keys in hardware and speaks to the phone next to you over Bluetooth, with no network in between.",
      },
      {
        t: "steps",
        items: [
          { title: "Download the APK", text: "Use Download APK on the home page. It takes you to the latest release on GitHub, built from the repository by CI. It is the debug build of the product app, signed with the project's test key — fine for testing, not for release." },
          { title: "Allow this source", text: "Android asks once whether to install from this browser or file manager. Allow it, then confirm the install." },
          { title: "Open the app", text: "The app needs Android 12 or newer. It runs the same wallet UI in a WebView and adds the offline pieces." },
          { title: "Pair with the site", text: "Links from the website open the app directly. Passkeys inside the app rely on the site's assetlinks file listing the app's signing certificate." },
        ],
      },
      {
        t: "note",
        kind: "warn",
        title: "It is a test build",
        text: "The downloadable APK is a debug build. It accepts keys signed with the same debug certificate, which is fine for trying offline cash and wrong for anything real. A release build uses only the production certificate.",
      },
      { t: "h", text: "Building it yourself" },
      {
        t: "p",
        text: "The app is a normal Gradle project next to the wallet. From the repository root:",
      },
      {
        t: "code",
        lang: "sh",
        text: `cd offline/app
ANDROID_HOME=$HOME/Android/Sdk ./gradlew assembleDebug \\
  -Pprawl.site=https://<your-wallet-site>

# output: app/build/outputs/apk/prawl/debug/app-prawl-debug.apk`,
      },
    ],
  },

  {
    slug: "privacy",
    title: "How the privacy works",
    group: "Under the hood",
    summary: "Shielded pool, Tor per identity, and what each layer hides.",
    blocks: [
      {
        t: "lead",
        text: "Prowl hides different things at different layers, and it is worth knowing exactly which layer hides what — because each one has a different limit.",
      },
      { t: "h", text: "The shielded pool" },
      {
        t: "p",
        text: "Your balance is a RAILGUN note. Sends inside the pool prove in zero knowledge that the inputs exist and are unspent, without revealing amounts, senders or recipients. That is what makes a private send private on chain.",
      },
      { t: "h", text: "Tor per identity" },
      {
        t: "p",
        text: "Every chain read and write goes over Tor through Anon-RPC, and every identity gets its own circuit: the wallet's account, each transaction, each one-time sender, and the shared RAILGUN scan. No RPC node can tie your IP to your address or to each other.",
      },
      {
        t: "table",
        head: ["Identity", "Own circuit", "Why"],
        rows: [
          ["The wallet's account", "Yes", "Balances and nonces never share a circuit with payments."],
          ["Each transaction", "Yes", "Two payments cannot be correlated by an observer."],
          ["Each one-time sender", "Yes", "The senders have no history, and no shared path either."],
          ["RAILGUN scan", "Yes", "The bulk sync runs on ground of its own."],
        ],
      },
      { t: "h", text: "What a gateway sees" },
      {
        t: "note",
        kind: "warn",
        title: "A gateway sees your IP",
        text: "Prowl connects through a tor-js gateway (a WebRTC endpoint). That gateway sees your IP address but never what goes over Tor. A ?gateway= link can propose a different one, and Prowl asks you to confirm exactly because of this.",
      },
      { t: "h", text: "What is never stored" },
      {
        t: "ul",
        items: [
          "No seed phrase, and no server holding one.",
          "RAILGUN checkpoints are sealed with AES-GCM under the passkey-derived storage key.",
          "Activity lives on your device only, and it has no explorer links — an explorer would reveal your IP and which transaction is yours.",
        ],
      },
    ],
  },

  {
    slug: "activity",
    title: "Activity and history",
    group: "Using the wallet",
    summary: "A local, encrypted history with no explorer links.",
    blocks: [
      {
        t: "lead",
        text: "The Activity tab is a local history of shields, private sends, withdrawals and offline loads. It is encrypted on the device with the passkey-derived key, and it is deliberately not a block explorer.",
      },
      {
        t: "ul",
        items: [
          "Rows record what you did, when, the amount, and the transaction hash.",
          "Hashes can be copied — but there is no explorer link on purpose.",
          "The history belongs to a wallet: opening another wallet on the same device shows a different list.",
          "Losing the device without the passkey loses the history. The chain is still the chain.",
        ],
      },
    ],
  },

  {
    slug: "security",
    title: "Safety and limits",
    group: "Under the hood",
    summary: "What can go wrong, and what Prowl does about it.",
    blocks: [
      {
        t: "lead",
        text: "Prowl is honest about its edge: it is testnet software that hides your activity well, and it cannot hide everything.",
      },
      {
        t: "table",
        head: ["Risk", "What Prowl does"],
        rows: [
          ["Losing the passkey", "The same synced passkey on another device restores everything. Without it, the wallet is gone — there is no seed phrase to fall back on."],
          ["Correlating shield and withdrawal", "Warns you when an exit would link to your own account or follows a recent shield."],
          ["A gateway seeing your IP", "Never sees Tor traffic; a ?gateway= choice is always confirmed."],
          ["Stale network data", "Tor bootstrap and pool snapshot are refreshed with each deploy."],
          ["A tampered Tor worker", "The worker bundle is hash-pinned and its keccak is re-checked, failing closed."],
        ],
      },
      {
        t: "note",
        kind: "warn",
        title: "Not audited for production",
        text: "Assume testnet rules: small amounts, addresses you control, and no expectation that a bug will not cost you the balance.",
      },
    ],
  },

  {
    slug: "troubleshooting",
    title: "Troubleshooting",
    group: "Help",
    summary: "Tor, passkeys, stuck proofs and a balance that will not appear.",
    blocks: [
      { t: "h", text: "“Tor failed” or it never turns green" },
      {
        t: "ul",
        items: [
          "Press retry. Bootstrapping fails more often on a flaky network.",
          "A corporate proxy or a captive portal will block the WebRTC gateway.",
          "Rerun the gateway if you are hosting it yourself, and refresh the bootstrap snapshot.",
        ],
      },
      { t: "h", text: "The passkey button is disabled" },
      {
        t: "p",
        text: "This browser has no passkey support, or no screen lock is set up. Use a recent Chrome, Edge or Safari with a screen lock or a security key enrolled. Passkeys also need localhost or a real domain — a bare IP address will not work.",
      },
      { t: "h", text: "I shielded but the balance still reads zero" },
      {
        t: "p",
        text: "Wait for the PPOI check. Two to four minutes on Sepolia is normal, and the wallet refreshes every minute. The note shows Missing until it is checked and Valid once it is spendable.",
      },
      { t: "h", text: "My history is empty on a new device" },
      {
        t: "p",
        text: "History is local and encrypted. Restoring with the same passkey restores the wallet, but the history was never on a server to fetch. The balance is what matters, and that comes from the chain.",
      },
      { t: "h", text: "A coin will not cash out" },
      {
        t: "p",
        text: "It has probably expired. Refresh before the expiry while you still hold it; anyone holding it can reclaim the escrow once it is expired and unspent.",
      },
    ],
  },
];

export const GROUP_ORDER = ["Getting started", "Using the wallet", "Offline cash", "Apps", "Under the hood", "Help"];

export function chapterBySlug(slug: string): Chapter | undefined {
  return CHAPTERS.find((c) => c.slug === slug);
}

export function neighbours(slug: string): { prev?: Chapter; next?: Chapter } {
  const i = CHAPTERS.findIndex((c) => c.slug === slug);
  if (i < 0) return {};
  return { prev: CHAPTERS[i - 1], next: CHAPTERS[i + 1] };
}

/** Chapters grouped in display order. */
export function grouped(): { group: string; items: Chapter[] }[] {
  return GROUP_ORDER.map((group) => ({ group, items: CHAPTERS.filter((c) => c.group === group) })).filter(
    (g) => g.items.length > 0,
  );
}
