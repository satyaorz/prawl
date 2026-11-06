import { TorStatusCard } from "./components/TorStatusCard";
import { TraceList } from "./components/TraceList";
import { PrivateActions } from "./components/PrivateActions";
import { ReceiveCard } from "./components/ReceiveCard";
import { OfflineCard } from "./components/OfflineCard";
import { ShieldForm } from "./components/ShieldForm";
import { WalletCard } from "./components/WalletCard";
import { WatchAddress } from "./components/WatchAddress";

export function App() {
  return (
    <main className="mx-auto flex max-w-xl flex-col gap-4 px-4 py-10">
      <header className="mb-2">
        <h1 className="text-2xl font-semibold tracking-tight">Prawl</h1>
        <p className="text-sm text-zinc-400">Private by default. Every request goes over Tor.</p>
      </header>
      <WalletCard />
      <ShieldForm />
      <PrivateActions />
      <ReceiveCard />
      <OfflineCard />
      <TorStatusCard />
      <WatchAddress />
      <TraceList />
    </main>
  );
}
