# Running the research on a VPS

Everything is pre-built for your always-on host. Two independent loops run
there, both using only public market data, no keys, no orders. Copy the
repositories to the VPS and start the services — that is the whole setup.

## 1. One-time setup on the VPS

```bash
# tools (unzip is required by the Deno installer)
sudo apt-get install -y python3 git curl unzip
curl -fsSL https://deno.land/install.sh | sh     # runs the V3 scanner (TypeScript, no npm deps)
echo 'export PATH="$HOME/.deno/bin:$PATH"' >> ~/.bashrc && source ~/.bashrc
deno --version   # prints a version number when Deno is on the PATH

# the research repo (private: use a fine-grained read token or SSH key)
git clone https://github.com/NorthernGrower/Gigadesk-.git
cd Gigadesk- && git checkout research/kraken-btcusd-backtest

# the app repo (holds the V3 direction engine and its scanner)
cd .. && git clone https://github.com/NorthernGrower/gigadesk.org.git
```

## 2. The research loop (Gigadesk-)

The full pre-built chain — unit tests, dataset prep (USD + BTC-native),
both combination sweeps, candlestick groups, Strike catalog (USD + BTC
-native), live pattern scanner, spec loop, gate — one stage finishing starts
the next, repeating every 30 minutes:

```bash
cd Gigadesk-
nohup python3 research/scripts/continuous.py --every-minutes 30 \
  >> research_loop.log 2>&1 &
```

First cycle downloads ~10 symbols of hourly history (~10-15 min, once);
every later cycle is fast. Results land in `research/reports/`, the board at
`research/reports/RESEARCH_BOARD.html`.

## 3. The V3 direction scanner (gigadesk.org)

Less-rigid directional reads — direction, conviction %, probabilistic drift
band, structural invalidation level — per symbol, on daily and 4-hour bars:

```bash
cd gigadesk.org
nohup deno run --allow-net --allow-read --allow-write vps/direction_scan.ts \
  --every-minutes 60 >> direction_scan.log 2>&1 &
```

Snapshots land in `vps/output/direction_signals.json` / `.md`. Options:
`--once` (single pass, for cron), `--every-minutes N`, `--symbols A,B,C`.

## 4. Optional: keep them alive across reboots (systemd)

```ini
# /etc/systemd/system/gigadesk-research.service
[Unit]
Description=GigaDesk research loop
[Service]
WorkingDirectory=/opt/Gigadesk-
ExecStart=/usr/bin/python3 research/scripts/continuous.py --every-minutes 30
Restart=always
[Install]
WantedBy=multi-user.target
```

```ini
# /etc/systemd/system/gigadesk-direction.service
[Unit]
Description=V3 direction scanner
[Service]
WorkingDirectory=/opt/gigadesk.org
ExecStart=/usr/bin/deno run --allow-net --allow-read --allow-write vps/direction_scan.ts --every-minutes 60
Restart=always
[Install]
WantedBy=multi-user.target
```

Enable with `systemctl enable --now gigadesk-research gigadesk-direction`.

## 5. Safety boundary

Both loops are read-only research: public market data only, no exchange keys,
no order placement, nothing connected to KuCoin or any account. Shorting
logic stays in research until the short-capable backtest exists and the
exchange/access decision is made explicitly.

## 6. First-run honesty

Neither loop has executed on a VPS yet — the first cycle is the verification:
if a step fails, the loop logs the stage and its last five error lines and
keeps going; bring that log back and the fix is usually one line.
