#!/usr/bin/env bash
# Re-runs every seam-B experiment. Outputs land next to this script.
set -e
cd "$(dirname "$0")"
( cd rust_lockcert && cargo build --release -q && ./target/release/lockcert ) | tee rust_run.log
( cd contracts && forge test -vv ) | tee forge_test.log
( cd contracts && forge test --gas-report ) > forge_gas_report.log
./run_anvil_gas.sh
( cd sim && python3 committee_and_sizes.py > committee_and_sizes.out && python3 market_quorum_sim.py > market_quorum_sim.out && python3 zone_sweep.py > zone_sweep.out )
echo done
