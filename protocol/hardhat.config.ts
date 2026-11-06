import "@fhevm/hardhat-plugin";
import "@nomicfoundation/hardhat-chai-matchers";
import "@nomicfoundation/hardhat-ethers";
import "hardhat-deploy";
import { config as loadDotenv } from "dotenv";
import { resolve } from "node:path";
import "./tasks/settle";

loadDotenv({ path: resolve(process.cwd(), "../.env.local") });
loadDotenv({ path: resolve(process.cwd(), ".env") });

import type { HardhatUserConfig } from "hardhat/types";

const config: HardhatUserConfig = {
  defaultNetwork: "hardhat",
  namedAccounts: {
    deployer: 0,
    user1: 1,
    user2: 2,
    user3: 3,
  },
  networks: {
    hardhat: {
      // FHEVM local mock via the hardhat plugin.
    },
    sepolia: {
      chainId: 11155111,
      url: process.env.RPC_URL_SEPOLIA || process.env.SEPOLIA_RPC_URL || "",
      accounts: process.env.PROTOCOL_PRIVATE_KEY ? [process.env.PROTOCOL_PRIVATE_KEY] : [],
    },
  },
  paths: {
    sources: "./contracts",
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
    deployments: "./deployments",
  },
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: { enabled: true, runs: 800 },
    },
  },
};

export default config;
