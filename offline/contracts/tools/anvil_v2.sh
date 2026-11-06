#!/usr/bin/env bash
# Anvil (osaka) receipts for the REAL v2 phone vectors:
#  * r1: deposit + redeem with Bob's phone-signed redemption, at the escrow address the phone signed for
#    (0x...0E5C70, chain 31337). The escrow is deployed normally (immutables set by its constructor) and its
#    runtime code is then placed at that address with anvil_setCode.
#  * e1: deposit + proveEquivocation with the two REAL signatures of the multi-use key.
# Usage: tools/anvil_v2.sh [port]   (run from onchain_real/, after tools/vectors_v2_to_foundry.py)
set -euo pipefail
cd "$(dirname "$0")/.."
PORT=${1:-18646}
RPC=http://127.0.0.1:$PORT
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 # anvil dev key #0 (local only)
ESCROW=0x00000000000000000000000000000000000E5C70
mkdir -p logs
anvil --hardfork osaka --port "$PORT" --silent > logs/anvil_v2.log 2>&1 &
APID=$!
trap 'kill $APID 2>/dev/null || true' EXIT
until cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; do sleep 0.5; done

J=fixtures/payments_v2.json
q() { ../.venv/bin/python -c "import json,sys;d=json.load(open('$J'));
for k in sys.argv[1].split('.'): d=d[int(k)] if k.isdigit() else d[k]
print(d)" "$1"; }
gas() { cast receipt "$1" gasUsed --rpc-url "$RPC"; }
send() { cast send --json --private-key $PK --rpc-url "$RPC" "$@" | ../.venv/bin/python -c "import json,sys;r=json.load(sys.stdin);print(r['transactionHash'], int(r['gasUsed'],16), r['status'])"; }

BYTECODE=$(forge inspect --offline src/PrawlRealEscrow.sol:PrawlRealEscrow bytecode)
ARGS=$(cast abi-encode "c(uint256,bool)" 120 true)
DEPLOYED=$(cast send --json --private-key $PK --rpc-url "$RPC" --create "${BYTECODE}${ARGS#0x}" | ../.venv/bin/python -c "import json,sys;print(json.load(sys.stdin)['contractAddress'])")
cast rpc anvil_setCode $ESCROW "$(cast code $DEPLOYED --rpc-url "$RPC")" --rpc-url "$RPC" >/dev/null
echo "escrow runtime placed at $ESCROW (requireTipAuth=$(cast call $ESCROW 'requireTipAuth()(bool)' --rpc-url "$RPC"), chainId=$(cast chain-id --rpc-url "$RPC"))"

EXP=$(( $(cast block latest --field timestamp --rpc-url "$RPC") + 30*86400 ))
echo "r1 deposit:                 $(send $ESCROW 'deposit(string,string,bytes32,bytes32,uint64)' r1 0.3 $(q r1.k0x) $(q r1.k0y) $EXP --value 0.3ether)"
HOP="[($(q r1.hops.0.x),$(q r1.hops.0.y),$(q r1.hops.0.r),$(q r1.hops.0.s))]"
echo "r1 redeem REAL tip-auth:    $(send $ESCROW 'redeem(string,(bytes32,bytes32,bytes32,bytes32)[],address,bytes32,bytes32)' r1 "$HOP" $(q r1.redeem.payout) $(q r1.redeem.r) $(q r1.redeem.s))"
cast rpc evm_increaseTime 121 --rpc-url "$RPC" >/dev/null; cast rpc evm_mine --rpc-url "$RPC" >/dev/null
echo "r1 finalize:                $(send $ESCROW 'finalize(string)' r1)"
echo "payout balance (wei):       $(cast balance $(q r1.redeem.payout) --rpc-url "$RPC")"

echo "e1 deposit (plain):         $(send $ESCROW 'deposit(string,string,bytes32,bytes32,uint64)' e1 0.1 $(q e1.bobE.k0x) $(q e1.bobE.k0y) $EXP --value 0.1ether)"
SA="($(q e1.bobE.hops.0.messageHex),$(q e1.bobE.hops.0.r),$(q e1.bobE.hops.0.s))"
SB="($(q e1.charlieE.hops.0.messageHex),$(q e1.charlieE.hops.0.r),$(q e1.charlieE.hops.0.s))"
echo "e1 proveEquivocation REAL:  $(send $ESCROW 'proveEquivocation(string,(bytes32,bytes32,bytes32,bytes32)[],(bytes,bytes32,bytes32),(bytes,bytes32,bytes32))' e1 '[]' "$SA" "$SB")"
echo "e1 key broken:              $(cast call $ESCROW 'brokenKey(bytes32)(bool)' $(q e1.bobE.k0Hash) --rpc-url "$RPC")"
