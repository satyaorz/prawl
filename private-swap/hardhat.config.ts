import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import type { HardhatUserConfig } from "hardhat/types";

/**
 * The FHEVM mock tests need paris-compatible bytecode; the local Uniswap v4
 * harness needs Cancun (tstore/tload/mcopy) and viaIR. Cancun satisfies both,
 * so every compiler uses it and the harness settings mirror Uniswap's own
 * foundry.toml (optimizer_runs 44444444, via_ir).
 */
const config: HardhatUserConfig = {
  solidity: {
    compilers: [
      { version: "0.8.27", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true } },
      { version: "0.8.26", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true } },
      { version: "0.8.24", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true } },
      { version: "0.8.17", settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun", viaIR: true } },
    ],
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
  },
};

export default config;
