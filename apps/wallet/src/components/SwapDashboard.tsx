import { useCallback, useEffect, useState } from "react";
import { formatEther, formatUnits, parseEther, parseUnits } from "viem";
import {
  fundSwapAccount,
  maxPrivateAmountWei,
  newSwapAccount,
  openSwapSession,
  shieldBackFromSwapAccount,
  swapAccountBalances,
  swapAccounts,
  swapConfigured,
  SWAP_ACCOUNT_GAS_WEI,
  unshieldEth,
  type SwapAccount,
} from "../lib/wallet";
import { useWallet } from "../lib/use-wallet";
import { SLIPPAGE_FLOOR_BPS, type SwapBalances, type SwapOrderStatus, type SwapService } from "../swap/service";
import { short } from "./ui";

/** Human labels for each order phase, and the tone used to render it. */
const ORDER_LABEL: Record<SwapOrderStatus["phase"], string> = {
  none: "No order",
  open: "Waiting for participants",
  "awaiting-settlement": "Settling",
  settled: "Settled",
  refundable: "Refundable",
  refunded: "Refunded",
};
const ORDER_TONE: Record<SwapOrderStatus["phase"], string> = {
  none: "text-zinc-500",
  open: "text-amber-400",
  "awaiting-settlement": "text-sky-400",
  settled: "text-emerald-400",
  refundable: "text-amber-300",
  refunded: "text-zinc-400",
};

type Mode = "fresh" | "main";
const btn = "rounded-xl border border-zinc-700 px-2 py-2 text-zinc-200 disabled:opacity-40";
const primary = "w-full rounded-full bg-emerald-500 px-4 py-3 text-sm font-semibold text-zinc-950 disabled:opacity-40";

export function SwapDashboard() {
  const wallet = useWallet();
  const [mode, setMode] = useState<Mode>("fresh");
  const [accounts, setAccounts] = useState<SwapAccount[]>([]);
  const [selected, setSelected] = useState<number>();
  const [fundAmount, setFundAmount] = useState("");
  // A swap account whose funding did not complete: a retry reuses it instead of reserving another one.
  const [unfunded, setUnfunded] = useState<SwapAccount>();
  const [acct, setAcct] = useState<{ ethWei: bigint; wethWei: bigint }>();
  const [service, setService] = useState<SwapService>();
  const [balances, setBalances] = useState<SwapBalances>();
  const [order, setOrder] = useState<SwapOrderStatus>();
  const [direction, setDirection] = useState<1 | 2>(1);
  const [amount, setAmount] = useState("");
  // The wallet moves its own round forward (close, settle, credit, exit); an error pauses that until retried.
  const [autoError, setAutoError] = useState("");
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const weth = (wallet.balances ?? []).filter((balance) => balance.token === wallet.wrappedBaseToken);
  const spendable = weth.filter((balance) => balance.poiStatus === "Valid").reduce((sum, balance) => sum + BigInt(balance.amount), 0n);
  const unlocked = !!wallet.evmAddress;
  // A swap runs as the main account, or as a fresh account that has no transaction linking it to the main one.
  const accountIndex = mode === "main" ? undefined : selected;
  const needsAccount = mode === "fresh" && selected === undefined;

  const loadAccounts = useCallback(async () => {
    const list = await swapAccounts().catch(() => []);
    setAccounts(list);
    setSelected((current) => current ?? list.at(-1)?.index);
  }, []);
  useEffect(() => { if (unlocked) void loadAccounts(); }, [unlocked, loadAccounts, wallet.evmAddress]);

  // A different wallet, a lock, or another swap account means a different session.
  useEffect(() => { setService(undefined); setBalances(undefined); setOrder(undefined); setAutoError(""); }, [wallet.evmAddress, wallet.phase === "locked", mode, selected]);

  const refreshAccount = useCallback(async () => {
    if (mode !== "fresh" || selected === undefined) { setAcct(undefined); return; }
    setAcct(await swapAccountBalances(selected).catch(() => undefined));
  }, [mode, selected]);
  useEffect(() => { void refreshAccount(); }, [refreshAccount, busy]);

  /** Balances and the round/order state are public reads; refresh them together. */
  async function refresh(session = service, decrypt = true) {
    if (!session) return;
    const [next, nextOrder] = await Promise.all([session.balances({ decrypt }), session.orderStatus().catch(() => undefined)]);
    setBalances(next);
    setOrder(nextOrder);
  }

  /**
   * While this sheet is open: read public state (never the confidential balances: decrypting tells the
   * gateway you are looking), then do the next permissionless step for this account's own order or exit.
   */
  useEffect(() => {
    if (!service) return;
    let stopped = false;
    const tick = async () => {
      if (busy || stopped) return;
      try {
        await refresh(service, false);
        if (autoError) return;
        const did = await service.advance(setStatus);
        if (did && !stopped) { setStatus(did); await refresh(service, true); }
      } catch (cause) {
        const text = cause instanceof Error ? cause.message : String(cause);
        if (!/already running|closed/i.test(text)) setAutoError(text);
      }
    };
    void tick();
    const timer = setInterval(() => void tick(), 15_000);
    return () => { stopped = true; clearInterval(timer); };
  }, [service, busy, autoError]);

  async function connect() {
    setOpening(true); setError(""); setStatus("Checking deployment and connecting the confidential swap…");
    try {
      const session = await openSwapSession(accountIndex);
      const next = await session.balances();
      setService(session); setBalances(next); setOrder(await session.orderStatus().catch(() => undefined)); setStatus("");
      if (session.config.tokenB.toLowerCase() === wallet.wrappedBaseToken?.toLowerCase()) setDirection(2);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setStatus(""); }
    finally { setOpening(false); }
  }

  /** Run one guarded action: one at a time, errors shown, state refreshed afterwards. */
  async function guarded(action: () => Promise<unknown>, completed: string) {
    if (busy) return;
    setError(""); setStatus("");
    setBusy(true);
    try {
      await action();
      setStatus(completed);
      if (service) await refresh(service);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  async function run(action: (session: SwapService, value: bigint) => Promise<unknown>, completed: string) {
    if (!service) return;
    let value: bigint;
    try { value = parseUnits(amount, 6); if (value <= 0n) throw new Error(); }
    catch { setError("Enter a positive amount with at most six decimal places."); return; }
    await guarded(() => action(service, value), completed);
  }

  /** Create a fresh account and fund it from the private balance. */
  async function fundNew() {
    let wei: bigint;
    try { wei = parseEther(fundAmount); if (wei <= 0n) throw new Error(); } catch { setError("Enter an amount of ETH to move into the swap account."); return; }
    const most = maxPrivateAmountWei("unshield", spendable);
    if (wei + SWAP_ACCOUNT_GAS_WEI > most) { setError(`Your spendable private balance covers at most ${formatEther(most > SWAP_ACCOUNT_GAS_WEI ? most - SWAP_ACCOUNT_GAS_WEI : 0n)} ETH here (fees and the swap account's gas come out of it).`); return; }
    await guarded(async () => {
      const account = unfunded ?? await newSwapAccount();
      setUnfunded(account);
      await loadAccounts();
      const ok = await fundSwapAccount(account.index, wei, setStatus);
      if (!ok) throw new Error("Funding the swap account did not complete (the reason is on the wallet's status line once you close this sheet). Nothing was lost: press the button again to retry with the same account.");
      setUnfunded(undefined);
      setSelected(account.index);
      setFundAmount("");
      await loadAccounts();
    }, "Swap account funded. Open it to swap.");
  }

  const inputAsset = (direction === 1 ? 0 : 1) as 0 | 1;
  const outputAsset = (1 - inputAsset) as 0 | 1;
  const labels: [string, string] = service?.config.tokenA.toLowerCase() === wallet.wrappedBaseToken?.toLowerCase() ? ["WETH", "Custom token"] : ["Custom token", "WETH"];
  let quantity = 0n;
  try { quantity = parseUnits(amount || "0", 6); } catch { /* rendered as unavailable */ }
  const lotIn = direction === 1 ? balances?.lotA : balances?.lotB;
  const lotOut = direction === 1 ? balances?.lotB : balances?.lotA;
  // An order is a whole number of price lots, and the lot size follows the pool's price: round the amount DOWN
  // to whole lots and say so, instead of making the user do lot arithmetic.
  const lots = lotIn && lotIn > 0n ? quantity / lotIn : 0n;
  const rounded = lotIn ? lots * lotIn : 0n;
  const estimate = lotIn && lotOut && lots > 0n ? lots * lotOut : undefined;
  const floor = estimate === undefined ? undefined : estimate * SLIPPAGE_FLOOR_BPS / 10000n;
  const amountText = (value: bigint) => formatUnits(value, 6);
  const isWeth = labels[inputAsset] === "WETH";

  /** Wrap what is missing, fund the vault, then place the encrypted order: three transactions, one tap. */
  async function swapPrivately(session: SwapService, requested: bigint) {
    setStatus("Reading your confidential balances…");
    const now = await session.balances();
    // Re-read the lot sizes now (the pool price may have moved since the quote above) and round down to whole lots.
    const lotInNow = direction === 1 ? now.lotA : now.lotB;
    const lotOutNow = direction === 1 ? now.lotB : now.lotA;
    if (lotInNow === 0n || lotOutNow === 0n) throw new Error(now.priceError ?? "The swap price is unavailable right now.");
    const value = requested / lotInNow * lotInNow;
    if (value === 0n) throw new Error(`That is less than one lot. One lot is ${amountText(lotInNow)} ${labels[inputAsset]}.`);
    const minimum = value / lotInNow * lotOutNow * SLIPPAGE_FLOOR_BPS / 10000n;
    if (value !== requested) setStatus(`Using ${amountText(value)} ${labels[inputAsset]}: the largest whole number of lots (one lot is ${amountText(lotInNow)}).`);
    const inVault = now.vault[inputAsset];
    if (inVault < value) {
      const need = value - inVault;
      if (now.wrapped[inputAsset] < need) await session.wrap(inputAsset, need - now.wrapped[inputAsset], setStatus);
      await session.fund(inputAsset, need, setStatus);
    }
    await session.order(direction, value, minimum, setStatus);
  }

  return (
    <div className="space-y-4">
      {!swapConfigured() && (
        <div className="rounded-2xl border border-amber-900 bg-amber-950/30 p-4 text-sm text-amber-200" role="status">
          Swaps are not available yet. A verified WETH and custom-token pool must be configured for this wallet.
        </div>
      )}

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
        <p className="text-xs text-zinc-500">Single pool · Sepolia</p>
        <p className="mt-1 text-lg font-semibold">WETH / custom token</p>
        <p className="mt-2 text-xs text-zinc-400">Orders are encrypted and settle in batches against a Uniswap v4 pool.</p>
      </div>

      {swapConfigured() && unlocked && (
        <div className="space-y-3 rounded-2xl border border-zinc-800 p-4 text-sm">
          <div role="tablist" aria-label="Swap account" className="grid grid-cols-2 gap-1 rounded-full bg-zinc-900 p-1 text-xs">
            {(["fresh", "main"] as const).map((m) => (
              <button key={m} role="tab" aria-selected={mode === m} disabled={busy} onClick={() => setMode(m)} className={`rounded-full px-3 py-1.5 ${mode === m ? "bg-emerald-500 font-semibold text-zinc-950" : "text-zinc-300"}`}>
                {m === "fresh" ? "Fresh private account" : "Main account"}
              </button>
            ))}
          </div>

          {mode === "main" ? (
            <p className="text-xs leading-relaxed text-amber-300">
              The swap runs from your main public address, so anyone can see that address wrapped and exited these amounts. Use a fresh account to keep it apart from you.
            </p>
          ) : (
            <>
              <p className="text-xs leading-relaxed text-zinc-400">
                A fresh account, derived from your passkey, funded straight from your private balance. No transaction connects it to your main address, and it uses its own Tor circuit.
              </p>
              {accounts.length > 0 && (
                <div className="flex flex-wrap gap-2">
                  {accounts.map((a) => (
                    <button key={a.index} disabled={busy} onClick={() => setSelected(a.index)} aria-pressed={selected === a.index} className={`rounded-full border px-3 py-1 font-mono text-xs ${selected === a.index ? "border-emerald-500 text-emerald-300" : "border-zinc-700 text-zinc-300"}`}>
                      {short(a.address, 6, 4)}
                    </button>
                  ))}
                </div>
              )}
              {acct && selected !== undefined && (
                <div className="space-y-2 rounded-xl border border-zinc-800 p-3 text-xs text-zinc-400">
                  <div className="flex justify-between"><span>Public ETH (gas)</span><span className="font-mono">{formatEther(acct.ethWei)}</span></div>
                  <div className="flex justify-between"><span>Public WETH</span><span className="font-mono">{formatEther(acct.wethWei)}</span></div>
                  <button disabled={busy || (acct.wethWei === 0n && acct.ethWei <= 3_000_000_000_000_000n)} onClick={() => void guarded(() => shieldBackFromSwapAccount(selected, setStatus), "Moved back into your private balance. It shows as pending until the PPOI check clears.")} className={`${btn} w-full`}>
                    Shield back to my private balance
                  </button>
                </div>
              )}
              <div className="space-y-2">
                <p className="text-xs text-zinc-500">Spendable private WETH: <span className="font-mono">{wallet.balances ? formatEther(spendable) : "…"}</span></p>
                <div className="flex gap-2">
                  <input value={fundAmount} onChange={(e) => setFundAmount(e.target.value.trim())} inputMode="decimal" placeholder="Amount in ETH" aria-label="ETH to move to a new swap account" className="min-w-0 flex-1 rounded-xl border border-zinc-700 bg-zinc-900 p-2 font-mono text-sm" />
                  <button disabled={busy || !fundAmount} onClick={() => void fundNew()} className="rounded-xl bg-zinc-100 px-3 text-xs font-semibold text-zinc-950 disabled:opacity-40">Fund new swap account</button>
                </div>
                <p className="text-xs text-zinc-500">Comes out of your private balance with the usual RAILGUN fee, plus {formatEther(SWAP_ACCOUNT_GAS_WEI)} ETH kept in the account for its own gas.</p>
              </div>
            </>
          )}
        </div>
      )}

      {swapConfigured() && !service && (
        <button onClick={() => void connect()} disabled={opening || busy || needsAccount || !unlocked} className={primary}>
          {opening ? "Connecting…" : needsAccount ? "Fund a swap account first" : "Open swap dashboard"}
        </button>
      )}

      <div className="space-y-2 rounded-2xl border border-zinc-800 p-4 text-sm">
        {mode === "main" && <div className="flex justify-between gap-3"><span className="text-zinc-400">Spendable RAILGUN WETH</span><span className="font-mono">{wallet.balances ? formatEther(spendable) : "…"}</span></div>}
        {balances && ([0, 1] as const).map((asset) => (
          <div key={asset} className={asset === 0 && mode === "fresh" ? "" : "border-t border-zinc-800 pt-2"}>
            <div className="font-medium text-zinc-200">{labels[asset]}</div>
            <div className="mt-1 flex justify-between text-xs text-zinc-400"><span>Public / wrapped / swap vault</span><span className="font-mono">{formatUnits(balances.public[asset], 18)} / {amountText(balances.wrapped[asset])} / {amountText(balances.vault[asset])}</span></div>
          </div>
        ))}
        {balances && <div className="border-t border-zinc-800 pt-2 text-xs text-zinc-400">Round {balances.round.toString()} · {balances.submitters.toString()}/{balances.minSubmitters.toString()} participants · earliest close {new Date(Number(balances.closesAt) * 1000).toLocaleTimeString()}</div>}
        {balances?.priceError && <p className="text-xs text-amber-400">Price unavailable: {balances.priceError}</p>}
        {!balances && <p className="text-xs text-zinc-500">Open the swap dashboard to see your confidential balances.</p>}
      </div>

      {order && order.phase !== "none" && (
        <div className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium text-zinc-200">Round {order.round.toString()}</span>
            <span className={`text-xs ${ORDER_TONE[order.phase]}`}>{ORDER_LABEL[order.phase]}</span>
          </div>
          <p className="text-xs leading-relaxed text-zinc-400">{order.detail}</p>
          {order.canRefund && service && (
            <button disabled={busy} onClick={() => void guarded(() => service.refund(order.round, setStatus), "Refund requested.")} className="w-full rounded-xl border border-amber-700 px-3 py-2 text-xs text-amber-200 disabled:opacity-40">Claim my order back</button>
          )}
        </div>
      )}

      {service && balances && (
        <div className="space-y-3 rounded-2xl border border-zinc-800 p-4">
          <div className="flex items-center justify-between text-sm"><span>Sell {labels[inputAsset]} → {labels[outputAsset]}</span><button onClick={() => { setDirection(direction === 1 ? 2 : 1); }} disabled={busy} className="text-emerald-400">Reverse</button></div>
          <label className="block text-xs text-zinc-400">Amount
            <input type="text" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.0" className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900 p-3 font-mono text-sm text-zinc-100" />
          </label>
          {lotIn && quantity > 0n && (
            <p className="text-xs text-zinc-500">
              {lots === 0n
                ? `Smaller than one lot (${amountText(lotIn)} ${labels[inputAsset]}).`
                : rounded === quantity
                  ? `${lots.toString()} lot${lots > 1n ? "s" : ""} of ${amountText(lotIn)} ${labels[inputAsset]}.`
                  : `Rounded down to ${amountText(rounded)} ${labels[inputAsset]}: ${lots.toString()} lot${lots > 1n ? "s" : ""} of ${amountText(lotIn)}.`}
            </p>
          )}
          <p className="text-xs leading-relaxed text-zinc-400">Indicative output: {estimate === undefined ? "—" : `${amountText(estimate)} ${labels[outputAsset]}`}. The batch trade is refused (and your order refunded) unless it returns at least {Number(SLIPPAGE_FLOOR_BPS) / 100}% of the quoted price: {floor === undefined ? "—" : `${amountText(floor)} ${labels[outputAsset]}`}. Pool fee: {service.config.pool.fee / 10000}%.</p>
          <button disabled={busy || !!balances.priceError} onClick={() => void run(swapPrivately, "Encrypted order submitted. The wallet will close, settle and credit the round by itself.")} className={primary}>Swap privately</button>

          {([0, 1] as const).filter((asset) => balances.vault[asset] > 0n).map((asset) => (
            <button key={asset} disabled={busy} onClick={() => void guarded(() => service.exit(asset, balances.vault[asset], setStatus), "Withdrawal requested. It is released to this account's public balance automatically in a minute or two.")} className={`${btn} w-full text-xs`}>
              Withdraw {amountText(balances.vault[asset])} {labels[asset]} to {mode === "fresh" ? "the swap account" : "my public account"}
            </button>
          ))}

          <details className="text-xs">
            <summary className="cursor-pointer text-zinc-400">Advanced: step by step</summary>
            <div className="mt-3 grid grid-cols-2 gap-2">
              {mode === "main" && isWeth && <button disabled={busy || !wallet.evmAddress} onClick={() => void run(async (_s, value) => {
                if (!wallet.evmAddress) throw new Error("Wallet account unavailable");
                const ok = await unshieldEth(wallet.evmAddress as `0x${string}`, value * 10n ** 12n, { asWeth: true });
                if (!ok) throw new Error("RAILGUN withdrawal did not complete; check the wallet action status before retrying.");
              }, "WETH moved to the public account.")} className={btn}>Move private WETH to public</button>}
              <button disabled={busy} onClick={() => void run((s, value) => s.wrap(inputAsset, value, setStatus), "Tokens wrapped. Fund the swap vault next.")} className={btn}>Wrap public tokens</button>
              <button disabled={busy} onClick={() => void run((s, value) => s.fund(inputAsset, value, setStatus), "Confidential tokens sent to the swap vault.")} className={btn}>Fund swap vault</button>
              <button disabled={busy} onClick={() => void run((s, value) => s.exit(inputAsset, value, setStatus), "Exit requested. It is released to this account's public balance automatically in a minute or two.")} className={btn}>Exit vault to public</button>
              <button disabled={busy || !!balances.priceError} onClick={() => void run((s, value) => {
                if (rounded === 0n || floor === undefined) throw new Error("Enter at least one whole lot.");
                return s.order(direction, rounded, floor, setStatus);
              }, "Encrypted order submitted. Track the round before placing another order.")} className={`${btn} col-span-2`}>Submit private swap</button>
            </div>
          </details>
          <button disabled={busy} onClick={() => { setBusy(true); void service.balances().then(() => refresh(service), (cause) => setError(cause instanceof Error ? cause.message : String(cause))).finally(() => setBusy(false)); }} className="w-full text-xs text-zinc-400 disabled:opacity-40">Refresh balances and round</button>
        </div>
      )}
      {status && <p role="status" className="break-words text-xs text-zinc-300">{status}</p>}
      {error && <p role="alert" className="break-words text-xs text-red-400">{error}</p>}
      {autoError && (
        <p role="alert" className="break-words text-xs text-amber-300">
          Automatic progress paused: {autoError}{" "}
          <button className="underline" onClick={() => setAutoError("")}>Try again</button>
        </p>
      )}
      <p className="text-xs leading-relaxed text-zinc-400">
        What stays hidden: each order&rsquo;s direction and size, and how much of a round was matched. What does not: that this account wrapped, funded and exited (and the amounts of those steps), which accounts took part, and the round&rsquo;s net trade on Uniswap. With few participants the net can reveal individual orders, so treat this as order-intent privacy, not anonymity.
      </p>
    </div>
  );
}
