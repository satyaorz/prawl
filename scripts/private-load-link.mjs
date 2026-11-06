#!/usr/bin/env node
// Make a SYNTHETIC load-private handoff link for testing the website's checks
// (HANDOFF v1.1). The coin's genesis key is the public P-256 generator point,
// so anyone could spend it: never fund this coin with anything you care about.
// It asks the real escrow (a read-only eth_call) for the deposit address.
//
// Usage: node scripts/private-load-link.mjs --rpc <url> --depositor 0x… [--value 0.003] [--hours 2] [--tip 0]
import { createPublicClient, encodeFunctionData, http, parseAbi, parseEther, toHex } from "viem";
import { randomBytes } from "node:crypto";

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const rpc = arg("rpc"); const depositor = arg("depositor");
if (!rpc || !/^0x[0-9a-fA-F]{40}$/.test(depositor ?? "")) { console.error("usage: --rpc <url> --depositor 0x… [--value 0.003] [--hours 2] [--tip 0]"); process.exit(1); }
const ESCROW = "0x236b1dC3b1a90E23728DA6E361b0Ab1C386cd779";
const value = parseEther(arg("value", "0.003"));
const params = {
  coinId: toHex(randomBytes(32)),
  expiry: BigInt(Math.floor(Date.now() / 1000) + Number(arg("hours", "2")) * 3600),
  // NIST P-256 generator: a public point, i.e. a coin anyone can spend.
  k0x: 0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  k0y: 0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
  depositor, minValue: value, maxValue: value, tip: BigInt(parseEther(arg("tip", "0"))),
};
const abi = parseAbi(["struct DepositParams { bytes32 coinId; uint64 expiry; uint256 k0x; uint256 k0y; address depositor; uint256 minValue; uint256 maxValue; uint256 tip; }",
  "function depositAddress(DepositParams p) view returns (address)"]);
const client = createPublicClient({ transport: http(rpc) });
const depositAddress = await client.readContract({ address: ESCROW, abi, functionName: "depositAddress", args: [params] });
const hex32 = (n) => toHex(n, { size: 32 });
const payload = { v: 1, t: "load-private", chainId: 11155111, escrow: ESCROW,
  params: { coinId: params.coinId, expiry: Number(params.expiry), k0x: hex32(params.k0x), k0y: hex32(params.k0y), depositor, minValue: String(params.minValue), maxValue: String(params.maxValue), tip: String(params.tip) },
  depositAddress };
const d = Buffer.from(JSON.stringify(payload)).toString("base64url");
console.log(`https://localhost/#/offline/load-private?d=${d}`);
console.error(`coin ${params.coinId.slice(0, 12)}…  deposit address ${depositAddress}  (SYNTHETIC key: test only)`);
