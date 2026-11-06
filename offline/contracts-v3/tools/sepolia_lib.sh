# shellcheck shell=bash
# Shared helpers for sepolia_deposit.sh / sepolia_redeem.sh (sourced, not executed).
#
# Configuration (environment):
#   ESCROW         escrow address (default: the deployed Sepolia PrawlEscrowV3)
#   KEYSTORE       encrypted keystore of the sender (default ~/.prawl-offline-keys/deployer)
#   PASSWORD_FILE  its password file (default ~/.prawl-offline-keys/deployer.pw)
#   PY             python with `cryptography` (default: the seam_a venv)
# The key is only ever handed to cast as --keystore/--password-file paths; nothing here prints or copies it.
# Every transaction these scripts send goes to $ESCROW and nowhere else.

ESCROW=${ESCROW:-0x70b3B7EdCD18087C999ec80e3C3B0227c7e0D6E5}
KEYSTORE=${KEYSTORE:-$HOME/.prawl-offline-keys/deployer}
PASSWORD_FILE=${PASSWORD_FILE:-$HOME/.prawl-offline-keys/deployer.pw}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(dirname "$HERE")"
PY=${PY:-$ROOT/../../seam_a_uncopyable/.venv/bin/python}
REDEEM_SIG="redeem((bytes32,uint256,uint64,uint256,uint256,address),((uint256,bytes32)[],uint256,bytes32,bytes32,bytes32,bytes32)[],((uint256,bytes32)[],uint256,address,bytes32,bytes32))"

die() { echo "REFUSED: $*" >&2; exit 1; }
lc() { echo "$1" | tr '[:upper:]' '[:lower:]'; }

# parse "--rpc URL" and "--simulate-only" out of the arguments; sets RPC, SIMULATE_ONLY, ARGS
parse_common() {
  RPC=${RPC:-}; SIMULATE_ONLY=0; ARGS=()
  while [ $# -gt 0 ]; do
    case "$1" in
      --rpc) RPC=$2; shift 2 ;;
      --simulate-only) SIMULATE_ONLY=1; shift ;;
      *) ARGS+=("$1"); shift ;;
    esac
  done
  [ -n "$RPC" ] || die "no RPC: pass --rpc <url> (or set RPC); there is deliberately no default"
}

# read KEY=VALUE lines from v3_bundle_args.py into F[...] (no eval)
declare -A F
load_fields() {
  local out
  out=$("$PY" "$HERE/v3_bundle_args.py" "$@") || die "phone file does not verify (see message above)"
  while IFS='=' read -r k v; do F[$k]=$v; done <<< "$out"
}

sender_address() {
  [ -r "$KEYSTORE" ] && [ -r "$PASSWORD_FILE" ] || die "keystore or password file not readable"
  cast wallet address --keystore "$KEYSTORE" --password-file "$PASSWORD_FILE"
}

check_chain_and_escrow() {
  local cid code
  cid=$(cast chain-id --rpc-url "$RPC") || die "RPC unreachable"
  [ "$cid" = "${F[CHAIN_ID]}" ] || die "RPC chain id $cid != coin chainId ${F[CHAIN_ID]}"
  [ "$(lc "${F[ESCROW]}")" = "$(lc "$ESCROW")" ] || die "coin was minted for escrow ${F[ESCROW]}, not $ESCROW (the phones sign the escrow address)"
  code=$(cast code "$ESCROW" --rpc-url "$RPC")
  [ ${#code} -gt 2 ] || die "no contract code at $ESCROW on this RPC"
}

commitment() { # value expiry k0x k0y depositor
  cast keccak "$(cast abi-encode "f(uint256,uint64,uint256,uint256,address)" "$1" "$2" "$3" "$4" "$5")"
}

# the 0x... revert data in a cast error message -> "Name(args)" via the escrow's own error selectors
decode_revert() {
  local data sel
  data=$(echo "$1" | grep -oE '0x[0-9a-fA-F]{8,}' | tail -1)
  [ -n "$data" ] || { echo "(no revert data) $1"; return; }
  sel=${data:2:8}
  local name
  name=$(forge inspect --offline --root "$ROOT" src/PrawlEscrowV3.sol:PrawlEscrowV3 errors --json 2>/dev/null \
    | "$PY" -c "import json,sys;d=json.load(sys.stdin);print(next((k for k,v in d.items() if v==sys.argv[1]),'unknown'))" "$sel")
  echo "$name  (revert data $data)"
}

receipt_field() { "$PY" -c "import json,sys;r=json.load(sys.stdin);v=r.get(sys.argv[1]);print(int(v,16) if isinstance(v,str) and v.startswith('0x') and sys.argv[1]!='transactionHash' else v)" "$1"; }

# Wait (max ~60 s) until the RPC node serving us has block $1 (public RPCs load-balance across lagging nodes).
wait_block() { local i; for i in $(seq 1 30); do
  [ "$(cast block-number --rpc-url "$RPC" 2>/dev/null || echo 0)" -ge "$1" ] && return 0; sleep 2; done
  echo "WARNING: RPC still behind block $1; reads may be stale" >&2; }
