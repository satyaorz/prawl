#!/usr/bin/env node
// Print the 0x-prefixed keccak256 of a file (how worker bundles are named and pinned).
import { readFileSync } from "node:fs";
import { keccak256 } from "viem";

const path = process.argv[2];
if (!path) {
  console.error("usage: keccak-file.mjs <file>");
  process.exit(1);
}
console.log(keccak256(readFileSync(path)));
