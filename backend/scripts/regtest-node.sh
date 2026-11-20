#!/usr/bin/env bash
# Local Bitcoin Core regtest node for developing/demoing CoSeal against a REAL node.
#   scripts/regtest-node.sh start      start bitcoind (regtest), create a funded "miner" wallet
#   scripts/regtest-node.sh mine [n]   mine n blocks (default 1)
#   scripts/regtest-node.sh fund <address> <sats>   send coins to an address (e.g. an escrow)
#   scripts/regtest-node.sh stop
# Then run the API with:
#   BITCOIN_LIVE=true BITCOIN_NETWORK=regtest BITCOIN_CHAIN=rpc BITCOIN_RPC_URL=http://127.0.0.1:18443 \
#   BITCOIN_RPC_USER=coseal BITCOIN_RPC_PASSWORD=coseal ARBITRATOR_PUBKEY=<33-byte hex> npm start
set -euo pipefail
BITCOIND="${BITCOIND_BIN:-$(command -v bitcoind || echo "$HOME/.local/opt/bitcoin-32.1/bin/bitcoind")}"
CLI="${BITCOIN_CLI_BIN:-$(command -v bitcoin-cli || echo "$HOME/.local/opt/bitcoin-32.1/bin/bitcoin-cli")}"
DATADIR="${REGTEST_DATADIR:-$HOME/.coseal-regtest}"
RPC=(-regtest "-datadir=$DATADIR" -rpcuser=coseal -rpcpassword=coseal -rpcport=18443)

case "${1:-}" in
  start)
    mkdir -p "$DATADIR"
    "$BITCOIND" "${RPC[@]}" -listen=0 -server=1 -txindex=1 -fallbackfee=0.0002 -dnsseed=0 -discover=0 -daemon
    for _ in $(seq 1 60); do "$CLI" "${RPC[@]}" getblockcount >/dev/null 2>&1 && break; sleep 0.5; done
    "$CLI" "${RPC[@]}" createwallet miner >/dev/null 2>&1 || "$CLI" "${RPC[@]}" loadwallet miner >/dev/null 2>&1 || true
    ADDR=$("$CLI" "${RPC[@]}" -rpcwallet=miner getnewaddress)
    [ "$("$CLI" "${RPC[@]}" getblockcount)" -lt 101 ] && "$CLI" "${RPC[@]}" generatetoaddress 101 "$ADDR" >/dev/null
    echo "regtest node up; height $("$CLI" "${RPC[@]}" getblockcount); rpc http://127.0.0.1:18443 (coseal/coseal)" ;;
  mine)
    ADDR=$("$CLI" "${RPC[@]}" -rpcwallet=miner getnewaddress)
    "$CLI" "${RPC[@]}" generatetoaddress "${2:-1}" "$ADDR" ;;
  fund)
    "$CLI" "${RPC[@]}" -rpcwallet=miner sendtoaddress "$2" "$(python3 -c "print('%.8f' % (${3}/1e8))")" ;;
  stop) "$CLI" "${RPC[@]}" stop ;;
  *) sed -n '2,9p' "$0" ;;
esac
