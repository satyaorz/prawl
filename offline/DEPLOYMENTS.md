# Sepolia deployments (offline-pay v3)
| Contract | Address | Tx | Constructor |
|---|---|---|---|
| PrawlEscrowV3 | 0x70b3B7EdCD18087C999ec80e3C3B0227c7e0D6E5 | 0x6838f722218d8332717245f0f0b239af6e169d36a00cea8bed97835e4b379d7f | grace 86400 s, maxLifetime 2592000 s, compensationSink = deployer 0x03a62B04aBe69f382bd7582f492be735B1dDb47B (testnet only; production needs a victim-compensation pool), requireBondedDevice false |
| PrawlEscrowV31 | 0x236b1dC3b1a90E23728DA6E361b0Ab1C386cd779 | 0x7ec07a4acb0b6cb3bd41fb0b1e91f886a61b305f35f1153ce997c8909d9774ec | grace 86400, maxLifetime 2592000, sink = deployer (testnet), requireBonded false, WETH 0xfFf9976782d46CC05630D1f6eBAb18b2324d6B14, RailgunSmartWallet 0xeCFCf3b4eC647c4Ca6D49108b311b7a7C9543fea |
| PrawlEscrowV32 (= v3.1 + audit fixes F2 max outputs, F3 capped sink sweep, F4 equivocation needs spend messages) | 0x2492B9199d7029a0e0801bf226Fd5afc75C99B12 | 0x1a62f2382a5e40d7280b2a9bc80d8baa02d62890737d1beb769374c9a25fd420 | same constructor as v3.1; storage slots 0-7 unchanged, new slots 8-9 |
