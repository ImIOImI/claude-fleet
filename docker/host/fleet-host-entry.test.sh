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
echo "env ${CLAUDE_FLEET_BROKER_TCP_PORT:-} ${CLAUDE_FLEET_BROKER_REQUIRE_MESH:-} ${FLEET_HOST_CRED_ADDR:-}" >> "$FAKE_DIR/events"
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
note(`dirs ${process.env.FLEET_HOST_STATE ?? ''} ${process.env.FLEET_HOST_PROJECTS ?? ''} ${process.env.HOME ?? ''}`);
note(`env ${process.env.FLEET_HOST_CRED_TCP_PORT ?? ''} ${process.env.FLEET_HOST_MCP_TCP_PORT ?? ''} ${process.env.FLEET_HOST_REQUIRE_MESH ?? ''} ${process.env.FLEET_HOST_RESCAN_MS ?? ''}`);
appendFileSync(`${process.env.FAKE_DIR}/pids`, `${process.pid}\n`);
const starts = readFileSync(ev, 'utf8').split('\n').filter((l) => l === 'host-start').length;
const crashes = process.env.FAKE_HOST_CRASHES ?? '0';
if (crashes === 'all' || starts <= Number(crashes)) process.exit(Number(process.env.FAKE_HOST_EXIT ?? 1));
process.on('SIGTERM', () => { note('host-term'); process.exit(0); });
process.on('SIGHUP', () => note('host-hup'));
setInterval(() => undefined, 1000);
JS

# id -u reports FAKE_UID, so the uid guards are testable under any runner uid.
mkdir -p "$tmp/bin"
cat > "$tmp/bin/id" <<'SH'
#!/usr/bin/env bash
if [ "$*" = -u ]; then echo "$FAKE_UID"; else exec /usr/bin/id "$@"; fi
SH
chmod +x "$tmp/bin/id"

free_port() { node -e "const s=require('net').createServer().listen(0,'127.0.0.1',()=>{console.log(s.address().port);s.close()})"; }

# run <case> <mode|none> [env...]: starts the entry script in the background; sets $pid and $dir.
run() {
  dir="$tmp/case-$1"; local mode=$2; shift 2
  mkdir -p "$dir"; : > "$dir/events"
  local args=("$mode"); [ "$mode" = none ] && args=()
  env -u CLAUDE_FLEET_BROKER_TCP_PORT -u CLAUDE_FLEET_BROKER_REQUIRE_MESH -u FLEET_HOST_CRED_ADDR -u CLAUDE_FLEET_BROKER_ADDR \
    -u FLEET_HOST_MCP_ADDR -u FLEET_HOST_CRED_TCP_PORT -u FLEET_HOST_MCP_TCP_PORT -u FLEET_HOST_REQUIRE_MESH -u FLEET_HOST_RESCAN_MS \
    -u FLEET_MESH_READY_URL -u FLEET_HOST_STATE -u FLEET_HOST_PROJECTS \
    PATH="$tmp/bin:$PATH" FAKE_UID=1001 HOME=/home/fleet FAKE_DIR="$dir" FLEET_BROKER_BIN="$tmp/broker" FLEET_HOST_JS="$tmp/host.mjs" FLEET_HOST_PORT="$(free_port)" \
    FLEET_HOST_BACKOFF_START_MS=20 FLEET_HOST_BACKOFF_MAX_MS=80 FLEET_WORKSPACE_UID=99999 "$@" \
    bash "$here/fleet-host-entry" "${args[@]}" 2> "$dir/log" &
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
run restart single FAKE_HOST_CRASHES=2
until_count host-start 3
sleep 0.3
assert "$(count host-start)" "3" "restarted after two crashes"
kill -0 "$pid" 2>/dev/null; assert "$?" "0" "entry still running after restarts"
grep -q '"msg":"fleet-host-entry: fleet-host exited; restarting"' "$dir/log"; assert "$?" "0" "restart logged"
kill -TERM "$pid"; finish
assert "$st" "0" "SIGTERM exits 0 after restarts"

# 2. A crash loop (> FLEET_HOST_MAX_RESTARTS in the window) ends the container.
run loop single FAKE_HOST_CRASHES=all FLEET_HOST_MAX_RESTARTS=3
finish
assert "$st" "1" "crash loop exits non-zero"
assert "$(count host-start)" "4" "gave up after 3 restarts"
assert "$(count broker-term)" "1" "broker stopped on give-up"
grep -q 'crash-looping; giving up' "$dir/log"; assert "$?" "0" "give-up logged"

# 3. SIGTERM stops fleet-host, then the broker, and never restarts fleet-host.
run term single
until_count host-start 1
sleep 0.2
kill -TERM "$pid"; finish
assert "$st" "0" "SIGTERM exits 0"
sleep 0.3
assert "$(count host-start)" "1" "no restart on SIGTERM"
assert "$(grep -x -e host-term -e broker-term "$dir/events" | tr '\n' ' ')" "host-term broker-term " "fleet-host stopped before the broker"

# 4. The broker exiting ends the container with its status, stopping fleet-host first.
run broker single FAKE_BROKER_EXIT=3
finish
assert "$st" "3" "broker exit status propagates"
assert "$(count host-term)" "1" "fleet-host stopped when the broker exits"
assert "$(count host-start)" "1" "fleet-host not restarted after broker exit"

# 5. SIGHUP reaches fleet-host and doesn't stop anything.
run hup single
until_count host-start 1
sleep 0.2
kill -HUP "$pid"
until_count host-hup 1; assert "$(count host-hup)" "1" "SIGHUP forwarded to fleet-host"
sleep 0.2
kill -0 "$pid" 2>/dev/null; assert "$?" "0" "entry still running after SIGHUP"
assert "$(count host-start)" "1" "SIGHUP causes no restart"
kill -TERM "$pid"; finish

# 7. A TCP broker port is refused: the broker would listen unauthenticated on the pod IP.
run tcp single CLAUDE_FLEET_BROKER_TCP_PORT=7070
finish
assert "$st" "1" "refuses to start with CLAUDE_FLEET_BROKER_TCP_PORT set"
assert "$(count broker-start)" "0" "broker never started"
assert "$(count host-start)" "0" "fleet-host never started"
grep -q 'CLAUDE_FLEET_BROKER_TCP_PORT is set' "$dir/log"; assert "$?" "0" "refusal logged"

# 6. SIGTERM during a restart backoff exits at once without restarting.
run backoff single FAKE_HOST_CRASHES=all FLEET_HOST_BACKOFF_START_MS=5000
until_count host-start 1
sleep 0.3
kill -TERM "$pid"; t0=$SECONDS; finish
assert "$st" "0" "SIGTERM during backoff exits 0"
assert "$(( SECONDS - t0 < 3 ))" "1" "backoff sleep is interrupted"
assert "$(count host-start)" "1" "no restart after SIGTERM in backoff"

# 8. Someone else listening on the fleet-host port during a restart ends the container, never a retry onto it.
squat_port=$(free_port)
run squat single FAKE_HOST_CRASHES=1 FLEET_HOST_BACKOFF_START_MS=1000 FLEET_HOST_PORT="$squat_port"
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
run squat6 single FLEET_HOST_PORT="$squat_port"
finish
kill "$squatter" 2>/dev/null; wait "$squatter" 2>/dev/null
assert "$st" "1" "port taken (IPv6) at first start exits non-zero"
assert "$(count host-start)" "0" "fleet-host never started on a taken port"

# 10. Exit 75 (host DB unavailable) restarts with backoff but never counts toward the crash-loop give-up.
run tempfail single FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=75 FLEET_HOST_MAX_RESTARTS=2
until_count host-start 6
kill -0 "$pid" 2>/dev/null; assert "$?" "0" "entry still running after repeated exit 75"
grep -q 'crash-looping' "$dir/log"; assert "$?" "1" "exit 75 never triggers the give-up"
grep -q '"msg":"fleet-host-entry: fleet-host exited (db unavailable); restarting"' "$dir/log"; assert "$?" "0" "db-unavailable restart logged"
grep -q '"delayMs":80' "$dir/log"; assert "$?" "0" "exit 75 restarts back off"
kill -TERM "$pid"; finish
assert "$st" "0" "SIGTERM exits 0 after exit-75 restarts"

# 11. single refuses a credential TCP port: single keeps every listener on a Unix socket.
run credtcp single FLEET_HOST_CRED_TCP_PORT=8081
finish
assert "$st" "1" "refuses to start with FLEET_HOST_CRED_TCP_PORT set"
assert "$(count broker-start)" "0" "broker never started"
assert "$(count host-start)" "0" "fleet-host never started"
grep -q 'FLEET_HOST_CRED_TCP_PORT is set' "$dir/log"; assert "$?" "0" "refusal logged"

# 12. single refuses an MCP TCP port too.
run mcptcp single FLEET_HOST_MCP_TCP_PORT=8082
finish
assert "$st" "1" "refuses to start with FLEET_HOST_MCP_TCP_PORT set"
assert "$(count broker-start)" "0" "broker never started (MCP TCP)"
grep -q 'FLEET_HOST_MCP_TCP_PORT is set' "$dir/log"; assert "$?" "0" "MCP TCP refusal logged"

# 13. No mode, or an unknown one, refuses with usage and starts nothing.
run nomode none
finish
assert "$st" "2" "no mode exits 2"
assert "$(count broker-start)" "0" "no mode starts no broker"
assert "$(count host-start)" "0" "no mode starts no fleet-host"
grep -q 'usage: fleet-host-entry host|workspace|single' "$dir/log"; assert "$?" "0" "usage logged"
run badmode bogus
finish
assert "$st" "2" "unknown mode exits 2"
assert "$(count broker-start)" "0" "unknown mode starts no broker"

# 14. single warns about the shared uid and keeps the broker on its socket.
run singlewarn single
until_count host-start 1
grep -q 'single-container mode: sessions share fleet-host' "$dir/log"; assert "$?" "0" "single warns"
assert "$(grep '^env ' "$dir/events" | sort | tr '\n' '|')" "env   |env    |" "single exports no TCP or mesh env"
kill -TERM "$pid"; finish

# 15. workspace execs the broker on TCP behind the mesh guard and exports the credential address.
run ws workspace FAKE_UID=1000 FLEET_HOST_CRED_ADDR=host-svc:8081
until_count broker-start 1
assert "$(grep '^env ' "$dir/events")" "env 7070 1 host-svc:8081" "workspace exports broker and credential env"
assert "$(head -1 "$dir/pids")" "$pid" "workspace execs the broker"
assert "$(count host-start)" "0" "workspace runs no fleet-host"
kill -TERM "$pid"; finish
assert "$st" "0" "workspace exits with the broker"

# 16. workspace keeps an explicit port, forces the mesh flag on, and propagates the broker's exit status.
run wsexit workspace FAKE_UID=1000 FLEET_HOST_CRED_ADDR=h:1 CLAUDE_FLEET_BROKER_TCP_PORT=7171 CLAUDE_FLEET_BROKER_REQUIRE_MESH=0 FAKE_BROKER_EXIT=4
finish
assert "$st" "4" "workspace exit status is the broker's"
assert "$(grep '^env ' "$dir/events")" "env 7171 1 h:1" "workspace keeps an explicit broker port and overrides REQUIRE_MESH=0"

# 17. workspace refuses to start without FLEET_HOST_CRED_ADDR.
run wsnocred workspace FAKE_UID=1000
finish
assert "$st" "1" "workspace refuses a missing FLEET_HOST_CRED_ADDR"
assert "$(count broker-start)" "0" "no broker without FLEET_HOST_CRED_ADDR"
grep -q 'FLEET_HOST_CRED_ADDR is not set' "$dir/log"; assert "$?" "0" "missing credential address logged"

# 18. host refuses a missing broker or MCP address.
run hostnobroker host FLEET_HOST_MCP_ADDR=h:8082
finish
assert "$st" "1" "host refuses a missing CLAUDE_FLEET_BROKER_ADDR"
assert "$(count host-start)" "0" "fleet-host never started without CLAUDE_FLEET_BROKER_ADDR"
run hostnomcp host CLAUDE_FLEET_BROKER_ADDR=w:7070
finish
assert "$st" "1" "host refuses a missing FLEET_HOST_MCP_ADDR"
assert "$(count host-start)" "0" "fleet-host never started without FLEET_HOST_MCP_ADDR"

HOSTENV=(CLAUDE_FLEET_BROKER_ADDR=w:7070 FLEET_HOST_MCP_ADDR=h:8082)

# 19. host exports the host-pod env; a non-75 exit ends the container with its status; no broker.
run hostexit host "${HOSTENV[@]}" FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=3
finish
assert "$st" "3" "host exit status is fleet-host's"
assert "$(count host-start)" "1" "host leaves other exits to Kubernetes"
assert "$(grep -m1 '^env ' "$dir/events")" "env 8081 8082 1 5000" "host exports ports, mesh and rescan"
assert "$(count broker-start)" "0" "host runs no broker"

# 20. host forces the mesh flag on whatever the caller set.
run hostmesh host "${HOSTENV[@]}" FLEET_HOST_REQUIRE_MESH=0 FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=0
finish
assert "$(grep -m1 '^env ' "$dir/events")" "env 8081 8082 1 5000" "host overrides FLEET_HOST_REQUIRE_MESH=0"

# 21. host restarts exit 75 with backoff, never gives up, and SIGTERM in backoff exits 0.
run host75 host "${HOSTENV[@]}" FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=75 FLEET_HOST_MAX_RESTARTS=2
until_count host-start 4
kill -0 "$pid" 2>/dev/null; assert "$?" "0" "host still running after repeated exit 75"
grep -q '"delayMs":80' "$dir/log"; assert "$?" "0" "host exit-75 restarts back off"
kill -TERM "$pid"; finish
assert "$st" "0" "host SIGTERM in backoff exits 0"

# 22. host forwards SIGHUP and SIGTERM and never restarts on them.
run hosthup host "${HOSTENV[@]}"
until_count host-start 1
sleep 0.2
kill -HUP "$pid"
until_count host-hup 1; assert "$(count host-hup)" "1" "host forwards SIGHUP"
kill -TERM "$pid"; finish
assert "$st" "0" "host SIGTERM exits 0"
assert "$(count host-term)" "1" "SIGTERM reaches fleet-host"
assert "$(count host-start)" "1" "host never restarted on HUP or TERM"

# 23. host never starts onto a taken port.
squat_port=$(free_port)
node -e "require('net').createServer().listen($squat_port,'0.0.0.0')" &
squatter=$!
for _ in $(seq 1 50); do (exec 3<>"/dev/tcp/127.0.0.1/$squat_port") 2>/dev/null && break; sleep 0.05; done
run hostsquat host "${HOSTENV[@]}" FLEET_HOST_PORT="$squat_port"
finish
kill "$squatter" 2>/dev/null; wait "$squatter" 2>/dev/null
assert "$st" "1" "host refuses a taken port"
assert "$(count host-start)" "0" "host never starts onto a taken port"

# 24. host refuses to run as the workspace uid.
run hostuid host "${HOSTENV[@]}" FLEET_WORKSPACE_UID=1001
finish
assert "$st" "1" "host refuses the workspace uid"
assert "$(count host-start)" "0" "fleet-host never started as the workspace uid"
grep -q 'host mode refuses to run as uid 1001' "$dir/log"; assert "$?" "0" "uid refusal logged"

# 25. host keeps an explicit rescan interval.
run hostrescan host "${HOSTENV[@]}" FLEET_HOST_RESCAN_MS=2000 FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=0
finish
assert "$(grep -m1 '^env ' "$dir/events")" "env 8081 8082 1 2000" "host keeps FLEET_HOST_RESCAN_MS"

# 26. Production modes refuse a caller-chosen sidecar readiness URL.
run wsmeshurl workspace FAKE_UID=1000 FLEET_HOST_CRED_ADDR=h:1 FLEET_MESH_READY_URL=http://127.0.0.1:1/ready
finish
assert "$st" "1" "workspace refuses FLEET_MESH_READY_URL"
assert "$(count broker-start)" "0" "no broker with FLEET_MESH_READY_URL"
grep -q 'FLEET_MESH_READY_URL is set' "$dir/log"; assert "$?" "0" "workspace mesh URL refusal logged"
run hostmeshurl host "${HOSTENV[@]}" FLEET_MESH_READY_URL=http://127.0.0.1:1/ready
finish
assert "$st" "1" "host refuses FLEET_MESH_READY_URL"
assert "$(count host-start)" "0" "fleet-host never started with FLEET_MESH_READY_URL"
grep -q 'FLEET_MESH_READY_URL is set' "$dir/log"; assert "$?" "0" "host mesh URL refusal logged"

# 27. host moves state, projects and HOME off /home/fleet (D94).
run hostdirs host "${HOSTENV[@]}" FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=0
finish
assert "$(grep -m1 '^dirs ' "$dir/events")" "dirs /var/lib/fleet-host/state /var/lib/fleet-host/projects /var/lib/fleet-host/state" "host defaults state, projects and HOME"
run hostdirsimg host "${HOSTENV[@]}" FLEET_HOST_STATE=/home/fleet/.claude/fleet-host HOME=/ FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=0
finish
assert "$(grep -m1 '^dirs ' "$dir/events")" "dirs /var/lib/fleet-host/state /var/lib/fleet-host/projects /var/lib/fleet-host/state" "host replaces the image's FLEET_HOST_STATE"
run hostdirsset host "${HOSTENV[@]}" FLEET_HOST_STATE=/st FLEET_HOST_PROJECTS=/pr HOME=/h FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=0
finish
assert "$(grep -m1 '^dirs ' "$dir/events")" "dirs /st /pr /h" "host keeps explicit state, projects and HOME"
run hostdirshome host "${HOSTENV[@]}" FLEET_HOST_STATE=/st FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=0
finish
assert "$(grep -m1 '^dirs ' "$dir/events")" "dirs /st /var/lib/fleet-host/projects /st" "host points a /home/fleet HOME at the state dir"
run singledirs single
until_count host-start 1
assert "$(grep -m1 '^dirs ' "$dir/events")" "dirs   /home/fleet" "single leaves state, projects and HOME alone"
kill -TERM "$pid"; finish

# 28. host resets the backoff after a run that outlasted the window.
run hostreset host "${HOSTENV[@]}" FAKE_HOST_CRASHES=all FAKE_HOST_EXIT=75 FLEET_HOST_RESTART_WINDOW_S=0
until_count host-start 4
grep -q '"delayMs":40' "$dir/log"; assert "$?" "1" "host backoff reset after a run as long as the window"
assert "$(grep -c '"delayMs":20' "$dir/log")" "$(grep -c 'db unavailable' "$dir/log")" "every restart uses the starting delay"
kill -TERM "$pid"; finish

# 29. uid guards: host never runs as root or 1000; workspace never as root or 1001.
for u in 0 1000; do
  run "hostuid$u" host "${HOSTENV[@]}" FAKE_UID="$u"
  finish
  assert "$st" "1" "host refuses uid $u"
  assert "$(count host-start)" "0" "fleet-host never started as uid $u"
done
run hostuid1000ws host "${HOSTENV[@]}" FAKE_UID=1000 FLEET_WORKSPACE_UID=4242
finish
assert "$st" "1" "host refuses uid 1000 whatever FLEET_WORKSPACE_UID says"
for u in 0 1001; do
  run "wsuid$u" workspace FAKE_UID="$u" FLEET_HOST_CRED_ADDR=h:1
  finish
  assert "$st" "1" "workspace refuses uid $u"
  assert "$(count broker-start)" "0" "no broker as uid $u"
  grep -q "workspace mode refuses to run as uid $u" "$dir/log"; assert "$?" "0" "workspace uid $u refusal logged"
done

[ "$fails" -eq 0 ] && echo "ALL PASS" || exit 1
