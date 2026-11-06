#!/usr/bin/env bash
# Installs the extra Solidity dependencies the local Uniswap v4 harness needs.
#
# The v4 sources import solmate and forge-std by bare name, and universal-router
# imports @uniswap/v3-periphery (only for the migration path, which the harness
# never uses). Hardhat 2 resolves bare imports through node_modules, so they go
# next to the shared modules rather than in a remapping.
#
# Run once before `npx hardhat test`. Nothing here is imported by the product
# contracts, so a plain `npm test` of the FHEVM mocks still works without it.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
modules="$(cd "$here/.." && pwd)/node_modules"

# A persistent directory: the node_modules symlinks must survive between runs.
deps="$here/../.harness-deps"
mkdir -p "$deps"
if [ ! -d "$deps/node_modules/solmate" ] || [ ! -d "$deps/node_modules/forge-std" ]; then
  printf '{ "name": "prawl-swap-harness-deps", "version": "1.0.0", "private": true }\n' > "$deps/package.json"
  ( cd "$deps" && npm install --silent solmate@6.8.0 forge-std@1.1.2 )
fi

ln -sfn "$deps/node_modules/solmate" "$modules/solmate"
ln -sfn "$deps/node_modules/forge-std" "$modules/forge-std"

# permit2's package has no "main", so Hardhat cannot resolve it by bare name.
# Copy the sources into a minimal package that resolves.
rm -rf "$modules/permit2"
mkdir -p "$modules/permit2/src"
cp -r "$modules/@uniswap/permit2/src/." "$modules/permit2/src/"
printf '{ "name": "permit2", "version": "1.0.0", "private": true }\n' > "$modules/permit2/package.json"

# v3-periphery is imported by universal-router's migrator only. Provide the two
# interfaces it references so the router compiles; the harness passes
# address(0) for the v3 position manager and never migrates.
mkdir -p "$modules/@uniswap/v3-periphery/contracts/interfaces"
cat > "$modules/@uniswap/v3-periphery/package.json" <<'JSON'
{ "name": "@uniswap/v3-periphery", "version": "1.4.4", "private": true }
JSON
if [ ! -f "$modules/@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol" ]; then
  cat > "$modules/@uniswap/v3-periphery/contracts/interfaces/INonfungiblePositionManager.sol" <<'SOL'
// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.7.5;
struct CollectParams { uint256 tokenId; address recipient; uint128 amount0Max; uint128 amount1Max; }
struct DecreaseLiquidityParams { uint256 tokenId; uint128 liquidity; uint256 amount0Min; uint256 amount1Min; uint256 deadline; }
interface INonfungiblePositionManager {
    function ownerOf(uint256 tokenId) external view returns (address);
    function getApproved(uint256 tokenId) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function decreaseLiquidity(DecreaseLiquidityParams calldata params) external payable returns (uint256, uint256);
    function collect(CollectParams calldata params) external payable returns (uint256, uint256);
    function burn(uint256 tokenId) external payable;
}
SOL
  cat > "$modules/@uniswap/v3-periphery/contracts/interfaces/IERC721Permit.sol" <<'SOL'
// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity >=0.7.5;
interface IERC721Permit {
    function permit(address spender, uint256 tokenId, uint256 deadline, uint8 v, bytes32 r, bytes32 s) external payable;
}
SOL
fi

# Uniswap sources pin exact pragmas that conflict with each other. Relax them to
# caret ranges so one compiler version covers the whole graph. These copies are
# test-only; the product contracts are unaffected.
relax() { find "$1" -name '*.sol' -exec sed -i -E 's/pragma solidity (0\.8\.[0-9]+);/pragma solidity ^\1;/' {} +; }
relax "$modules/@uniswap/permit2/src"
relax "$modules/@uniswap/v4-core/src"
relax "$modules/@uniswap/v4-periphery/src"
relax "$modules/permit2/src"

echo "harness dependencies installed"
