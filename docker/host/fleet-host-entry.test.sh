#!/usr/bin/env bash
# Tests for fleet-host-entry with fake broker/fleet-host processes.
# Run: bash docker/host/fleet-host-entry.test.sh
set -u
here="$(cd "$(dirname "$0")" && pwd)"
fails=0
assert() { if [ "$1" = "$2" ]; then echo "ok: $3"; else echo "FAIL: $3 (got '$1' want '$2')"; fails=$((fails+1)); fi; }

tmp="$(mktemp -d)"
# Kill any fake left behind by a misbehaving entry script, so no orphan holds the output pipe.
cleanup() { cat "$tmp"/case-*/pids 2>/dev/null | while read -r p; do kill -KILL "$p" 2>/dev/null; done; rm -rf "$tmp"; }
trap cleanup EXIT

cat > "$tmp/broker" <<'SH'
#!/usr/bin/env bash
trap 'echo broker-term >> "$FAKE_DIR/events"; exit 0' TERM
echo $$ >> "$FAKE_DIR/pids"
echo broker-start >> "$FAKE_DIR/events"
if [ -n "${FAKE_BROKER_EXIT:-}" ]; then sleep 0.3; exit "$FAKE_BROKER_EXIT"; fi
while :; do sleep 0.05; done
SH
chmod +x "$tmp/broker"

# FAKE_HOST_CRASHES: how many starts exit at once ("all" = every start), with FAKE_HOST_EXIT (default 1).
cat > "$tmp/host.mjs" <<'JS'
import { appendFileSync, readFileSync } from 'node:fs';
const ev = `${process.env.FAKE_DIR}/events`;
const note = (s) => appendFileSync(ev, s + '\n');
note('host-start');
appendFileSync(`${process.env.FAKE_DIR}/pids`, `${process.pid}\n`);
const starts = readFileSync(ev, 'utf8').split('\n').filter((l) => l === 'host-start').length;
const crashes = process.env.FAKE_HOST_CRASHES ?? '0';
if (crashes === 'all' || starts <= Number(crashes)) process.exit(Number(process.env.FAKE_HOST_EXIT ?? 1));
process.on('SIGTERM', () => { note('host-term'); process.exit(0); });
process.on('SIGHUP', () => note('host-hup'));
setInterval(() => undefined, 1000);
JS

free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }

# run <case> [env...]: starts the entry script in the background; sets $pid and $dir.
run() {
  dir="$tmp/case-$1"; shift
  mkdir -p "$dir"; : > "$dir/events"
  env -u CLAUDE_FLEET_BROKER_TCP_PORT FAKE_DIR="$dir" FLEET_BROKER_BIN="$tmp/broker" FLEET_HOST_JS="$tmp/host.mjs" FLEET_HOST_PORT="$(free_port)" \
    FLEET_HOST_BACKOFF_START_MS=20 FLEET_HOST_BACKOFF_MAX_MS=80 "$@" \
    bash "$here/fleet-host-entry" 2> "$dir/log" &
  pid=$!
}
count() { grep -cx "$1" "$dir/events"; }
until_count() { for _ in $(seq 1 100); do [ "$(count "$1")" -ge "$2" ] && return 0; sleep 0.05; done; return 1; }
# Waits in this shell (never a subshell) so the entry's status is visible.
finish() {
  for _ in $(seq 1 200); do kill -0 "$pid" 2>/dev/null || break; sleep 0.05; done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid"; wait "$pid"; st=timeout; return; fi
  wait "$pid"; st=$?
}

# 1. A crashing fleet-host is restarted; the container stays up.
run restart FAKE_HOST_CRASHES=2
until_count host-start 3
sleep 0.3
assert "$(count host-start)" "3" "restarted after two crashes"
kill -0 "$pid" 2>/dev/null; assert "$?" "0" "entry still running after restarts"
grep -q '"msg":"fleet-host-entry: fleet-host exited; restarting"' "$dir/log"; assert "$?" "0" "restart logged"
kill -TERM "$pid"; finish
assert "$st" "0" "SIGTERM exits 0 after restarts"

# 2. A crash loop (> FLEET_HOST_MAX_RESTARTS in the window) ends the container.
run loop FAKE_HOST_CRASHES=all FLEET_HOST_MAX_RESTARTS=3
finish
assert "$st" "1" "crash loop exits non-zero"
assert "$(count host-start)" "4" "gave up after 3 restarts"
assert "$(count broker-term)" "1" "broker stopped on give-up"
grep -q 'crash-looping; giving up' "$dir/log"; assert "$?" "0" "give-up logged"

# 3. SIGTERM stops fleet-host, then the broker, and never restarts fleet-host.
run term
until_count host-start 1
sleep 0.2
kill -TERM "$pid"; finish
assert "$st" "0" "SIGTERM exits 0"
sleep 0.3
assert "$(count host-start)" "1" "no restart on SIGTERM"
assert "$(grep -x -e host-term -e broker-term "$dir/events" | tr '\n' ' ')" "host-term broker-term " "fleet-host stopped before the broker"

# 4. The broker exiting ends the container with its status, stopping fleet-host first.
run broker FAKE_BROKER_EXIT=3
finish
assert "$st" "3" "broker exit status propagates"
assert "$(count host-term)" "1" "fleet-host stopped when the broker exits"
assert "$(count host-start)" "1" "fleet-host not restarted after broker exit"

# 5. SIGHUP reaches fleet-host and doesn't stop anything.
run hup
until_count host-start 1
sleep 0.2
kill -HUP "$pid"
until_count host-hup 1; assert "$(count host-hup)" "1" "SIGHUP forwarded to fleet-host"
sleep 0.2
kill -0 "$pid" 2>/dev/null; assert "$?" "0" "entry still running after SIGHUP"
assert "$(count host-start)" "1" "SIGHUP causes no restart"
kill -TERM "$pid"; finish

# 7. A TCP broker port is refused: the broker would listen unauthenticated on the pod IP.
run tcp CLAUDE_FLEET_BROKER_TCP_PORT=7070
finish
assert "$st" "1" "refuses to start with CLAUDE_FLEET_BROKER_TCP_PORT set"
assert "$(count broker-start)" "0" "broker never started"
assert "$(count host-start)" "0" "fleet-host never started"
grep -q 'CLAUDE_FLEET_BROKER_TCP_PORT is set' "$dir/log"; assert "$?" "0" "refusal logged"

# 6. SIGTERM during a restart backoff exits at once without restarting.
run backoff FAKE_HOST_CRASHES=all FLEET_HOST_BACKOFF_START_MS=5000
until_count host-start 1
sleep 0.3
kill -TERM "$pid"; t0=$SECONDS; finish
assert "$st" "0" "SIGTERM during backoff exits 0"
assert "$(( SECONDS - t0 < 3 ))" "1" "backoff sleep is interrupted"
assert "$(count host-start)" "1" "no restart after SIGTERM in backoff"

# 8. Someone else listening on the fleet-host port during a restart ends the container, never a retry onto it.
squat_port=$(free_port)
run squat FAKE_HOST_CRASHES=1 FLEET_HOST_BACKOFF_START_MS=1000 FLEET_HOST_PORT="$squat_port"
until_count host-start 1
node -e "require('net').createServer().listen($squat_port,'0.0.0.0')" &
squatter=$!
finish
kill "$squatter" 2>/dev/null; wait "$squatter" 2>/dev/null
assert "$st" "1" "port taken at restart exits non-zero"
assert "$(count host-start)" "1" "fleet-host not restarted onto a taken port"
assert "$(count broker-term)" "1" "broker stopped when the port is taken"
grep -q "port $squat_port is already bound" "$dir/log"; assert "$?" "0" "taken port logged"

# 9. The same check runs before the first start.
squat_port=$(free_port)
node -e "require('net').createServer().listen($squat_port,'::')" &
squatter=$!
for _ in $(seq 1 50); do (exec 3<>"/dev/tcp/127.0.0.1/$squat_port") 2>/dev/null && break; sleep 0.05; done
run squat6 FLEET_HOST_PORT="$squat_port"
finish
kill "$squatter" 2>/dev/null; wait "$squatter" 2>/dev/null
assert "$st" "1" "port taken (IPv6) at first start exits non-zero"
assert "$(count host-start)" "0" "fleet-host never started on a taken port"

# 10. Exit 75 (host DB unavailable) restarts with backoff but never counts toward the crash-loop give-up.
run tempfail FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=75 FLEET_HOST_MAX_RESTARTS=2
until_count host-start 6
kill -0 "$pid" 2>/dev/null; assert "$?" "0" "entry still running after repeated exit 75"
grep -q 'crash-looping' "$dir/log"; assert "$?" "1" "exit 75 never triggers the give-up"
grep -q '"msg":"fleet-host-entry: fleet-host exited (db unavailable); restarting"' "$dir/log"; assert "$?" "0" "db-unavailable restart logged"
grep -q '"delayMs":80' "$dir/log"; assert "$?" "0" "exit 75 restarts back off"
kill -TERM "$pid"; finish
assert "$st" "0" "SIGTERM exits 0 after exit-75 restarts"

[ "$fails" -eq 0 ] && echo "ALL PASS" || exit 1
