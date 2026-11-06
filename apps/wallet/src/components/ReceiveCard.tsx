import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { useWallet } from "../lib/use-wallet";

type Kind = "private" | "public";

/** QR code as a data URL, drawn locally (no network). */
function useQr(text: string | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let live = true;
    if (!text) return setUrl(undefined);
    void QRCode.toDataURL(text, { margin: 1, width: 220, errorCorrectionLevel: "M", color: { dark: "#09090b", light: "#fafafa" } }).then(
      (u) => live && setUrl(u),
    );
    return () => {
      live = false;
    };
  }, [text]);
  return url;
}

/** Show the private 0zk address (to get paid privately) or the public account (to fund, then shield). */
export function ReceiveCard() {
  const w = useWallet();
  const [kind, setKind] = useState<Kind>("private");
  const [copied, setCopied] = useState(false);
  const address = kind === "private" ? w.railgunAddress : w.evmAddress;
  const qr = useQr(address);
  if (!w.railgunAddress) return null;

  return (
    <section className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-5">
      <div className="flex gap-4 text-sm">
        {(["private", "public"] as const).map((k) => (
          <button key={k} onClick={() => setKind(k)} className={kind === k ? "font-medium text-zinc-100" : "text-zinc-500 hover:text-zinc-300"}>
            {k === "private" ? "Receive privately" : "Fund (public)"}
          </button>
        ))}
      </div>
      <p className="mt-2 text-xs text-zinc-500">
        {kind === "private"
          ? "Share this 0zk address to be paid privately. Nobody can see what it holds or receives."
          : "Send Sepolia ETH here from an exchange or another wallet, then shield it. Anything here is public."}
      </p>
      <div className="mt-3 flex flex-col items-center gap-3 sm:flex-row sm:items-start">
        {qr && <img src={qr} alt={`QR code of the ${kind} address`} width={160} height={160} className="rounded-lg" />}
        <div className="min-w-0 flex-1">
          <p className="break-all font-mono text-xs text-zinc-300">{address}</p>
          <button
            className="mt-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs"
            onClick={() => {
              if (!address) return;
              void navigator.clipboard.writeText(address).then(() => {
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              });
            }}
          >
            {copied ? "Copied" : "Copy address"}
          </button>
        </div>
      </div>
    </section>
  );
}
