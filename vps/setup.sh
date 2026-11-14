#!/usr/bin/env bash
# GigaDesk VP setup + start — run with:  bash vps/setup.sh
# Safe to re-run: it skips whatever is already done and never starts a
# second copy of a loop. Paste commands one at a time if you prefer —
# see vps/COMMANDS.txt for the plain list.

set -u

echo "== 1/5  system packages =="
apt-get update -qq
apt-get install -y python3 git curl unzip

echo "== 2/5  Deno =="
if ! command -v deno > /dev/null 2>&1; then
  curl -fsSL https://deno.land/install.sh | sh
fi
[ -d "$HOME/.deno/bin" ] && export PATH="$HOME/.deno/bin:$PATH"
grep -q '.deno/bin' ~/.bashrc 2>/dev/null \
  || echo 'export PATH="$HOME/.deno/bin:$PATH"' >> ~/.bashrc
echo "deno: $(deno --version 2>/dev/null | head -1 || echo 'MISSING — open a new shell (source ~/.bashrc) and re-run')"

echo "== 3/5  repositories =="
cd "$HOME"
[ -d Gigadesk- ] || git clone https://github.com/NorthernGrower/Gigadesk-.git
cd Gigadesk- && git checkout research/kraken-btcusd-backtest 2>/dev/null
cd "$HOME"
[ -d gigadesk.org ] || git clone https://github.com/NorthernGrower/gigadesk.org.git
cd gigadesk.org && git fetch origin && git checkout v3-direction-engine
cd "$HOME"

echo "== 4/5  research chain =="
cd "$HOME/Gigadesk-"
if ! pgrep -f "continuous.py" > /dev/null; then
  nohup python3 research/scripts/continuous.py --every-minutes 30 \
    >> research_loop.log 2>&1 &
  echo "research chain started (log: research_loop.log)"
else
  echo "research chain already running — not started twice"
fi

echo "== 5/5  V3 direction scanner =="
cd "$HOME/gigadesk.org"
if ! pgrep -f "direction_scan.ts" > /dev/null; then
  nohup deno run --allow-net --allow-read --allow-write vps/direction_scan.ts \
    --every-minutes 60 >> direction_scan.log 2>&1 &
  echo "V3 scanner started (log: direction_scan.log)"
else
  echo "V3 scanner already running — not started twice"
fi

echo
echo "Outputs: $HOME/Gigadesk-/research/reports/   (sweeps, board, pattern scanner)"
echo "         $HOME/gigadesk.org/vps/output/      (V3 direction snapshots)"
echo "Logs:    $HOME/Gigadesk-/research_loop.log  +  $HOME/gigadesk.org/direction_scan.log"
echo "Watch:   tail -f <log path>"
