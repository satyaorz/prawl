import { useEffect, useState } from "react";
import { formatEther, formatUnits, parseUnits } from "viem";
import { openSwapSession, swapConfigured, unshieldEth } from "../lib/wallet";
import { useWallet } from "../lib/use-wallet";
import { SLIPPAGE_FLOOR_BPS, type SwapBalances, type SwapOrderStatus, type SwapService } from "../swap/service";

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

export function SwapDashboard() {
  const wallet = useWallet();
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

  useEffect(() => { setService(undefined); setBalances(undefined); setOrder(undefined); }, [wallet.evmAddress, wallet.phase === "locked"]);

  /** Balances and the round/order state are public reads; refresh them together. */
  async function refresh(session = service, decrypt = true) {
    if (!session) return;
    const [next, nextOrder] = await Promise.all([session.balances({ decrypt }), session.orderStatus().catch(() => undefined)]);
    setBalances(next);
    setOrder(nextOrder);
  }

  /**
   * While this sheet is open: read public state (never the confidential balances: decrypting tells the
   * gateway you are looking), then do the next permissionless step for this wallet's own order or exit.
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
      const session = await openSwapSession();
      const next = await session.balances();
      setService(session); setBalances(next); setOrder(await session.orderStatus().catch(() => undefined)); setStatus("");
      if (session.config.tokenB.toLowerCase() === wallet.wrappedBaseToken?.toLowerCase()) setDirection(2);
    } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); setStatus(""); }
    finally { setOpening(false); }
  }

  async function run(action: (session: SwapService, value: bigint) => Promise<unknown>, completed: string) {
    if (!service || busy) return;
    setError(""); setStatus("");
    let value: bigint;
    try { value = parseUnits(amount, 6); if (value <= 0n) throw new Error(); }
    catch { setError("Enter a positive amount with at most six decimal places."); return; }
    setBusy(true);
    try {
      await action(service, value);
      setStatus(completed);
      await refresh(service);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }

  const inputAsset = (direction === 1 ? 0 : 1) as 0 | 1;
  const outputAsset = (1 - inputAsset) as 0 | 1;
  const labels: [string, string] = service?.config.tokenA.toLowerCase() === wallet.wrappedBaseToken?.toLowerCase() ? ["WETH", "Custom token"] : ["Custom token", "WETH"];
  let quantity = 0n;
  try { quantity = parseUnits(amount || "0", 6); } catch { /* rendered as unavailable */ }
  const lotIn = direction === 1 ? balances?.lotA : balances?.lotB;
  const lotOut = direction === 1 ? balances?.lotB : balances?.lotA;
  const estimate = lotIn && lotOut && quantity > 0n && quantity % lotIn === 0n ? quantity / lotIn * lotOut : undefined;
  const floor = estimate === undefined ? undefined : estimate * SLIPPAGE_FLOOR_BPS / 10000n;
  const amountText = (value: bigint) => formatUnits(value, 6);
  const isWeth = labels[inputAsset] === "WETH";

  return (
    <div className="space-y-4">
      {!swapConfigured() ? (
        <div className="rounded-2xl border border-amber-900 bg-amber-950/30 p-4 text-sm text-amber-200" role="status">
          Swaps are not available yet. A verified WETH and custom-token pool must be configured for this wallet.
        </div>
      ) : !service ? (
        <button onClick={() => void connect()} disabled={opening || busy} className="w-full rounded-full bg-emerald-500 px-4 py-3 text-sm font-semibold text-zinc-950 disabled:opacity-50">
          {opening ? "Connecting…" : "Open swap dashboard"}
        </button>
      ) : null}

      <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
        <p className="text-xs text-zinc-500">Single pool · Sepolia</p>
        <p className="mt-1 text-lg font-semibold">WETH / custom token</p>
        <p className="mt-2 text-xs text-zinc-400">Orders are encrypted and settle in batches against a Uniswap v4 pool.</p>
      </div>

      <div className="space-y-2 rounded-2xl border border-zinc-800 p-4 text-sm">
        <div className="flex justify-between gap-3"><span className="text-zinc-400">Spendable RAILGUN WETH</span><span className="font-mono">{wallet.balances ? formatEther(spendable) : "…"}</span></div>
        {balances && ([0, 1] as const).map((asset) => (
          <div key={asset} className="border-t border-zinc-800 pt-2">
            <div className="font-medium text-zinc-200">{labels[asset]}</div>
            <div className="mt-1 flex justify-between text-xs text-zinc-400"><span>Public / wrapped / swap vault</span><span className="font-mono">{formatUnits(balances.public[asset], 18)} / {amountText(balances.wrapped[asset])} / {amountText(balances.vault[asset])}</span></div>
          </div>
        ))}
        {balances && <div className="border-t border-zinc-800 pt-2 text-xs text-zinc-400">Round {balances.round.toString()} · {balances.submitters.toString()}/{balances.minSubmitters.toString()} participants · earliest close {new Date(Number(balances.closesAt) * 1000).toLocaleTimeString()}</div>}
        {balances?.priceError && <p className="text-xs text-amber-400">Price unavailable: {balances.priceError}</p>}
      </div>

      {order && order.phase !== "none" && (
        <div className="space-y-2 rounded-2xl border border-zinc-800 bg-zinc-900/40 p-4 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-medium text-zinc-200">Round {order.round.toString()}</span>
            <span className={`text-xs ${ORDER_TONE[order.phase]}`}>{ORDER_LABEL[order.phase]}</span>
          </div>
          <p className="text-xs leading-relaxed text-zinc-400">{order.detail}</p>
          {order.canRefund && service && (
            <button disabled={busy} onClick={() => void (async () => {
              if (!service || busy) return;
              setBusy(true); setError(""); setStatus("");
              try { await service.refund(order.round, setStatus); await refresh(service); }
              catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
              finally { setBusy(false); }
            })()} className="w-full rounded-xl border border-amber-700 px-3 py-2 text-xs text-amber-200 disabled:opacity-40">Claim my order back</button>
          )}
        </div>
      )}

      {service && balances && (
        <div className="space-y-3 rounded-2xl border border-zinc-800 p-4">
          <div className="flex items-center justify-between text-sm"><span>Sell {labels[inputAsset]} → {labels[outputAsset]}</span><button onClick={() => { setDirection(direction === 1 ? 2 : 1); }} disabled={busy} className="text-emerald-400">Reverse</button></div>
          <label className="block text-xs text-zinc-400">Amount
            <input type="text" inputMode="decimal" value={amount} onChange={(event) => setAmount(event.target.value)} placeholder="0.0" className="mt-1 w-full rounded-xl border border-zinc-700 bg-zinc-900 p-3 font-mono text-sm text-zinc-100" />
          </label>
          <p className="text-xs leading-relaxed text-zinc-400">Indicative output: {estimate === undefined ? "—" : `${amountText(estimate)} ${labels[outputAsset]}`}. The batch trade is refused (and your order refunded) unless it returns at least {Number(SLIPPAGE_FLOOR_BPS) / 100}% of the quoted price: {floor === undefined ? "—" : `${amountText(floor)} ${labels[outputAsset]}`}. Pool fee: {service.config.pool.fee / 10000}%.</p>
          <div className="grid grid-cols-2 gap-2 text-xs">
            {isWeth && <button disabled={busy || !wallet.evmAddress} onClick={() => void run(async (_s, value) => {
              if (!wallet.evmAddress) throw new Error("Wallet account unavailable");
              const ok = await unshieldEth(wallet.evmAddress as `0x${string}`, value * 10n ** 12n, { asWeth: true });
              if (!ok) throw new Error("RAILGUN withdrawal did not complete; check the wallet action status before retrying.");
            }, "WETH moved to the public account.")} className="rounded-xl border border-zinc-700 px-2 py-2 text-zinc-200 disabled:opacity-40">Move private WETH to public</button>}
            <button disabled={busy} onClick={() => void run((s, value) => s.wrap(inputAsset, value, setStatus), "Tokens wrapped. Fund the swap vault next.")} className="rounded-xl border border-zinc-700 px-2 py-2 text-zinc-200 disabled:opacity-40">Wrap public tokens</button>
            <button disabled={busy} onClick={() => void run((s, value) => s.fund(inputAsset, value, setStatus), "Confidential tokens sent to the swap vault.")} className="rounded-xl border border-zinc-700 px-2 py-2 text-zinc-200 disabled:opacity-40">Fund swap vault</button>
            <button disabled={busy} onClick={() => void run((s, value) => s.exit(inputAsset, value, setStatus), "Exit requested. It is released to your public account automatically in a minute or two.")} className="rounded-xl border border-zinc-700 px-2 py-2 text-zinc-200 disabled:opacity-40">Exit vault to public</button>
          </div>
          <button disabled={busy || !!balances.priceError} onClick={() => void run((s, value) => {
            if (floor === undefined) throw new Error("Enter a whole number of price lots.");
            return s.order(direction, value, floor, setStatus);
          }, "Encrypted order submitted. Track the round before placing another order.")} className="w-full rounded-full bg-emerald-500 px-4 py-3 text-sm font-semibold text-zinc-950 disabled:opacity-40">Submit private swap</button>
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
      <p className="text-xs leading-relaxed text-zinc-400">Order amounts, directions and minimums are encrypted. Funding and exits are public; the batch’s net trade and participant addresses are visible. Moving WETH from RAILGUN to your public account can link those activities. Swaps require public ETH for gas.</p>
    </div>
  );
}
