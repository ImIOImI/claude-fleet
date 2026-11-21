#!/usr/bin/env bash
# The two-pod layout with plain Docker: wiring only. Docker has no mesh, so
# D73 is a cluster check. A container answering the sidecar readiness URL owns
# each "pod" network namespace, as istio-proxy would.
set -Eeuo pipefail
# Under -e a check without `|| fail` would exit silently; name the line instead.
trap 'echo "FAIL: line $LINENO: $BASH_COMMAND"' ERR
image=$1
here=$(cd "$(dirname "$0")" && pwd)
pg_image=pgvector/pgvector:0.8.7-pg16@sha256:0dd3149a06e4579a0d70d8fef9945636cd514005e7237deb27f9b67886f8dc4f
n=split-$$
tmp=$(mktemp -d)
ids=()
cleanup() {
  for c in "${ids[@]}"; do echo "--- $c"; docker logs "$c" 2>&1 | tail -20 || true; docker rm -f "$c" >/dev/null 2>&1 || true; done
  local left
  left=$(docker ps -aq --filter "name=^$n-")
  [ -n "$left" ] && docker rm -f $left >/dev/null 2>&1
  docker network rm "$n" >/dev/null 2>&1 || true
  docker volume rm "$n-ws-data" >/dev/null 2>&1 || true
  rm -rf "$tmp"
}
trap cleanup EXIT
fail() { echo "FAIL: $*"; exit 1; }
retry() { for _ in $(seq 1 30); do "$@" && return 0; sleep 1; done; return 1; }
until_eq() { local want=$1; shift; for _ in $(seq 1 30); do [ "$("$@" 2>/dev/null)" = "$want" ] && return 0; sleep 1; done; return 1; }

docker network create "$n" >/dev/null
mkdir -p "$tmp/cfg" "$tmp/key"
openssl genrsa -out "$tmp/key/key.pem" 2048 2>/dev/null
cat > "$tmp/cfg/config.yaml" <<'YAML'
workspace: { name: split }
grants:
  - { team: acme/platform, tier: session }
github: { appId: 1, installationId: 2, keyFile: /var/run/secrets/github-app/key.pem }
db: { host: pg, database: fleet, user: fleet_agent, password: { kind: env, name: FLEET_DB_PASSWORD }, ssl: disable }
search: { embedder: false }
YAML
chmod 0755 "$tmp/cfg" "$tmp/key"; chmod 0444 "$tmp/key/key.pem" "$tmp/cfg/config.yaml"

cat > "$tmp/brokerctl.js" <<'JS'
// OP=list|create|status [ID=…]: one broker request over CLAUDE_FLEET_BROKER_ADDR; prints the reply's JSON.
const net = require('net');
const [h, p] = process.env.CLAUDE_FLEET_BROKER_ADDR.split(':');
const frame = (t, o) => {
  const b = Buffer.from(o === undefined ? '' : JSON.stringify(o));
  const f = Buffer.alloc(5 + b.length);
  f.writeUInt32BE(b.length + 1, 0);
  f[4] = t;
  b.copy(f, 5);
  return f;
};
const op = process.env.OP;
const want = op === 'create' ? 0x02 : op === 'status' ? 0x1b : 0x0b;
const req = op === 'create' ? frame(0x01, { id: process.env.ID, cols: 80, rows: 24 }) : op === 'status' ? frame(0x1a, {}) : frame(0x0a);
const c = net.connect(Number(p), h, () => c.write(req));
let buf = Buffer.alloc(0);
c.on('data', (d) => {
  buf = Buffer.concat([buf, d]);
  while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) {
    const len = buf.readUInt32BE(0);
    const type = buf[4];
    const body = buf.subarray(5, 4 + len);
    buf = buf.subarray(4 + len);
    if (type === want) { console.log(body.toString()); c.destroy(); return; }
  }
});
c.on('error', (e) => { console.error(e.code || e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(1); }, 10000).unref();
JS

ids+=("$(docker run -d --name "$n-pg" --network "$n" --network-alias pg -e POSTGRES_PASSWORD=admin "$pg_image")")
# -h 127.0.0.1: the image's init-time server listens on the Unix socket only.
retry docker exec "$n-pg" pg_isready -h 127.0.0.1 -U postgres -q || fail "postgres never came up"
docker run --rm --network "$n" -v "$tmp/cfg:/etc/fleet-host:ro" -e PGADMIN_PW=admin -e FLEET_DB_PASSWORD=app-pw \
  "$image" fleet-host bootstrap --admin-password-env PGADMIN_PW --admin-user postgres || fail "bootstrap"

ready_js="require('http').createServer((q,r)=>{r.statusCode=q.url==='/healthz/ready'?200:404;r.end()}).listen(15021,'127.0.0.1')"

# A workspace pod with no sidecar must never listen.
ids+=("$(docker run -d --name "$n-nomesh" --network "$n" -u 1000:1000 -e FLEET_HOST_CRED_ADDR=host-svc:8081 "$image" fleet-host-entry workspace)")

ids+=("$(docker run -d --name "$n-wsnet" --network "$n" --network-alias workspace-svc --entrypoint node "$image" -e "$ready_js")")
ids+=("$(docker run -d --name "$n-ws" --network "container:$n-wsnet" -u 1000:1000 \
  -e FLEET_HOST_CRED_ADDR=host-svc:8081 -e CLAUDE_FLEET_BROKER_CLAUDE=/bin/cat \
  -e CLAUDE_FLEET_BROKER_DRAIN_SOFT=3s -e CLAUDE_FLEET_BROKER_DRAIN_HARD=8s \
  "$image" fleet-host-entry workspace)")
ids+=("$(docker run -d --name "$n-hostnet" --network "$n" --network-alias host-svc -p 127.0.0.1::8080 --entrypoint node "$image" -e "$ready_js")")
# No state, projects or HOME overrides: host mode must find the image's own directories (D94).
# Read-only root as in the host pod; the state tmpfs mirrors its emptyDir (0777).
ids+=("$(docker run -d --name "$n-host" --network "container:$n-hostnet" -u 1001:1001 \
  --read-only --tmpfs /tmp --tmpfs /var/lib/fleet-host/state:mode=0777 \
  -e CLAUDE_FLEET_BROKER_ADDR=workspace-svc:7070 -e FLEET_HOST_MCP_ADDR=host-svc:8082 -e FLEET_DB_PASSWORD=app-pw \
  -v "$tmp/cfg:/etc/fleet-host:ro" -v "$tmp/key:/var/run/secrets/github-app:ro" \
  "$image" fleet-host-entry host)")
port=$(docker port "$n-hostnet" 8080/tcp | head -1 | sed 's/.*://') || fail "no published host port"
[ -n "$port" ] || fail "no published host port"

healthy() {
  local body=
  for _ in $(seq 1 60); do
    body=$(curl -fsS "http://127.0.0.1:$port/healthz" 2>/dev/null || true)
    case $body in *'"lease":"holder"'*'"mesh":"ready"'*) return 0 ;; esac
    sleep 1
  done
  echo "last /healthz: ${body:-none}"
  return 1
}
bctl() { docker exec -i -e OP="$1" -e ID="${2:-}" "$n-host" node < "$tmp/brokerctl.js"; }

healthy || fail "host never became holder with mesh ready"
if [ "$(docker inspect -f '{{.State.Running}}' "$n-nomesh")" = true ]; then
  # 1B9E = 7070, 1B9F = 7071; 0A = LISTEN. Go binds 0.0.0.0 dual-stack, so the socket can be in tcp6.
  docker exec "$n-nomesh" sh -c '! grep -Eqs ":1B9[EF] [0-9A-F]+:0000 0A" /proc/net/tcp /proc/net/tcp6' || fail "broker listened without a sidecar"
fi

# fleet-host's side of :7070.
retry bctl list >/dev/null || fail "broker unreachable over :7070"
bctl create split1 | grep -q '"ok":true' || fail "CREATE over :7070"
bctl list | grep -q '{"id":"split1","alive":true}' || fail "LIST over :7070"

# A workspace process reaches :8081 (unscoped → 400) and :8082 (tools/list).
cred_js="const [h,p]=process.env.FLEET_HOST_CRED_ADDR.split(':');const r=require('http').request({host:h,port:Number(p),method:'POST',path:'/token',headers:{'content-type':'application/json'}},(s)=>{console.log(s.statusCode);s.resume()});r.on('error',(e)=>console.log(e.code));r.end('{\"repositories\":[]}')"
until_eq 400 docker exec "$n-ws" node -e "$cred_js" || fail "unscoped POST /token from the workspace pod"
mcp_js="const s=require('net').connect(8082,'host-svc',()=>s.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n'));let b='';s.setEncoding('utf8');s.on('data',(d)=>{b+=d;if(b.includes('\n')){console.log(JSON.parse(b).result.tools.length);s.destroy()}});s.on('error',(e)=>console.log(e.code))"
until_eq 20 docker exec "$n-ws" node -e "$mcp_js" || fail "tools/list on :8082 from the workspace pod"

# The MCP caller is the hosted workspace, whatever the wire says.
ws_id=$(docker exec -e PGPASSWORD=app-pw "$n-pg" psql -h 127.0.0.1 -U fleet_agent -d fleet -Atc 'SELECT workspace_id FROM host_meta') || fail "host_meta query"
[ -n "$ws_id" ] || fail "no hosted workspace id in host_meta"
docker exec "$n-host" test -s /var/lib/fleet-host/state/workspace-id.json || fail "host mode did not use the image's state dir"
caller_js="const s=require('net').connect(8082,'host-svc');let b='',n=0;s.setEncoding('utf8');
const call=(id,name,args)=>s.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})+'\\n');
s.on('connect',()=>call(1,'post_todo',{title:'split caller',key:'split-caller'}));
s.on('data',(d)=>{b+=d;let i;while((i=b.indexOf('\\n'))!==-1){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);
if(m.error||m.result.isError){console.log('error: '+JSON.stringify(m.error||m.result.content));s.destroy();return}
if(m.id===1)call(2,'list_todos',{});else{console.log(JSON.parse(m.result.content[0].text).map((t)=>t.source.id).join(','));s.destroy()}}});
s.on('error',(e)=>console.log(e.code))"
got=$(docker exec "$n-ws" node -e "$caller_js") || fail "MCP caller script: $got"
[ "$got" = "$ws_id" ] || fail "MCP caller over :8082 is '$got', want the hosted workspace $ws_id"

# What each pod holds.
test "$(docker exec "$n-host" id -u)" = 1001 || fail "host pod uid"
test "$(docker exec "$n-ws" id -u)" = 1000 || fail "workspace pod uid"
docker exec "$n-ws" test ! -e /var/run/secrets/github-app/key.pem || fail "key file in the workspace pod"
docker exec "$n-ws" sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline" 2>/dev/null | grep -q "fleet-host[.]mjs" && exit 1; done; exit 0' \
  || fail "fleet-host runs in the workspace pod"

# Restarting the host pod leaves the broker and its sessions running.
ws_pid=$(docker inspect -f '{{.State.Pid}}' "$n-ws") || fail "inspect the workspace pod"
docker restart -t 15 "$n-host" >/dev/null || fail "docker restart host"
healthy || fail "host did not recover after a restart"
test "$(docker inspect -f '{{.State.Running}} {{.State.Pid}}' "$n-ws")" = "true $ws_pid" || fail "workspace pod restarted with the host"
bctl list | grep -q '{"id":"split1","alive":true}' || fail "session lost across a host restart"
grep -q '"msg":"shutting down"' <<<"$(docker logs "$n-host" 2>&1)" || fail "host restart was not a clean shutdown"

# Drain (D142–D147): an idle session closes at once, a busy one is killed at the hard deadline, then the preStop returns.
bctl create drainidle | grep -q '"ok":true' || fail "CREATE drainidle"
bctl create drainbusy | grep -q '"ok":true' || fail "CREATE drainbusy"
docker exec "$n-ws" /usr/local/bin/broker ready || fail "broker not ready before the drain"
# The readiness probe (D158): GET /ready on :7071, read-only.
ready_http() { docker exec -e M="${1:-GET}" "$n-ws" node -e "const r=require('http').request({host:'127.0.0.1',port:7071,path:'/ready',method:process.env.M},(s)=>{let b='';s.on('data',(d)=>b+=d);s.on('end',()=>console.log(s.statusCode+' '+b.trim()))});r.on('error',(e)=>console.log(e.code));r.end()"; }
test "$(ready_http)" = "200 serving" || fail "GET /ready before the drain: $(ready_http)"
test "$(ready_http POST)" = "405 method not allowed" || fail "POST /ready accepted"
test "$(docker exec "$n-ws" stat -c '%a %U %F' /run/broker/ctl.sock)" = "600 fleet socket" || fail "control socket is not 0600 fleet"
# `; true`: the loop's last `[ ] && …` is usually false, which would fail the pipeline under pipefail.
idle_pid=$(docker exec "$n-ws" sh -c 'for p in /proc/[0-9]*; do [ "$(cat $p/environ 2>/dev/null | tr "\0" "\n" | grep -x CLAUDE_FLEET_BROKER_SESSION_ID=drainidle)" ] && basename $p; done; true' | head -1) || true
[ -n "$idle_pid" ] || fail "no drainidle process"
# The broker matches procStart to /proc/<pid>/stat field 22 (a stale file reads busy).
docker exec "$n-ws" sh -c "mkdir -p ~/.claude/sessions && ps=\$(cut -d')' -f2- /proc/$idle_pid/stat | awk '{print \$20}') && printf '{\"pid\":$idle_pid,\"procStart\":\"%s\",\"sessionId\":\"x\",\"status\":\"idle\"}' \"\$ps\" > ~/.claude/sessions/$idle_pid.json" \
  || fail "write the drainidle status file"
start=$SECONDS
docker exec "$n-ws" /usr/local/bin/broker drain > "$tmp/drain.out" || fail "broker drain exited non-zero"
grep -q '"phase":"done"' "$tmp/drain.out" || fail "drain never reported done"
(( SECONDS - start <= 20 )) || fail "drain took longer than the hard deadline allows"
docker exec "$n-ws" /usr/local/bin/broker ready && fail "broker ready while drained"
test "$(ready_http)" = "503 done" || fail "GET /ready after the drain: $(ready_http)"
bctl status | grep -q '"id":"drainidle","alive":false,"ended":"drain-idle"' || fail "idle session not closed as drain-idle"
bctl status | grep -q '"id":"drainbusy","alive":false,"ended":"drain-killed"' || fail "busy session not killed at the hard deadline"
bctl create late | grep -q 'draining: the workspace is restarting' || fail "CREATE accepted while drained"
docker stop -t 15 "$n-ws" >/dev/null || fail "docker stop workspace"
test "$(docker inspect -f '{{.State.ExitCode}}' "$n-ws")" = 0 || fail "drained broker did not exit 0 on SIGTERM"

# Pinned loadouts (D159–D168): a fake credential server + GitHub API; the sync runs before the broker listens.
ready_get_js="require('http').get('http://127.0.0.1:7071/ready',(s)=>{let b='';s.on('data',(d)=>b+=d);s.on('end',()=>console.log(s.statusCode+' '+b.trim()))}).on('error',(e)=>console.log(e.code))"
docker volume create "$n-ws-data" >/dev/null
docker run --rm -u 0 -v "$n-ws-data:/workspace" --entrypoint chown "$image" 1000:1000 /workspace || fail "chown the workspace volume"
ids+=("$(docker run -d --name "$n-gh" --network "$n" --network-alias gh-fake -u 1000:1000 -e FAKE_FAIL_TAGS=demo/v2.0.0 \
  -v "$here/testdata:/fake:ro" --entrypoint node "$image" /fake/fake-github.mjs)")
retry sh -c "docker logs '$n-gh' 2>/dev/null | grep -q '\"ready\":true'" || fail "fake GitHub never started"
# loadouts_pod <name> <FLEET_LOADOUTS>: a workspace pod on the shared /workspace volume, pointed at the fake.
loadouts_pod() {
  ids+=("$(docker run -d --name "$n-$1net" --network "$n" --entrypoint node "$image" -e "$ready_js")")
  ids+=("$(docker run -d --name "$n-$1" --network "container:$n-$1net" -u 1000:1000 -v "$n-ws-data:/workspace" \
    -e FLEET_HOST_CRED_ADDR=gh-fake:8081 -e FLEET_LOADOUTS_API=http://gh-fake:8090 -e "FLEET_LOADOUTS=$2" -e CLAUDE_FLEET_BROKER_CLAUDE=/bin/cat \
    "$image" fleet-host-entry workspace)")
  until_eq "200 serving" docker exec "$n-$1" node -e "$ready_get_js" || fail "$1: broker never served"
}

loadouts_pod ld1 demo@1.0.0
grep -q 'Demo skill 1.0.0' <<<"$(docker exec "$n-ld1" cat /workspace/.claude/skills/demo/SKILL.md)" || fail "pinned loadout not installed"
grep -q '"version": "1.0.0"' <<<"$(docker exec "$n-ld1" cat /workspace/.claude/fleet-loadouts.json)" || fail "install not recorded"
ld1_logs=$(docker logs "$n-ld1" 2>&1)
sync_at=$(grep -n '"msg":"loadout sync done"' <<<"$ld1_logs" | head -1 | cut -d: -f1)
listen_at=$(grep -n 'listening on' <<<"$ld1_logs" | head -1 | cut -d: -f1)
[ -n "$sync_at" ] && [ -n "$listen_at" ] && (( sync_at < listen_at )) || fail "the sync did not finish before the broker listened"
gh_logs=$(docker logs "$n-gh" 2>&1)
grep -q '"token_request":{"owner":"SumerSports","repositories":\["claude-fleet-loadouts"\],"permissions":{"contents":"read"}}' <<<"$gh_logs" \
  || fail "token request is not contents: read on the loadouts repo"
grep -q '"path":"/codeload/[0-9a-f]*","auth":false' <<<"$gh_logs" || fail "codeload request carried a token"
docker stop -t 15 "$n-ld1" >/dev/null || fail "stop ld1"

# A failed download keeps the installed version and the broker still serves.
loadouts_pod ld2 demo@2.0.0
grep -q '"msg":"loadout sync failed".*"stage":"download"' <<<"$(docker logs "$n-ld2" 2>&1)" || fail "failed download not logged"
grep -q 'Demo skill 1.0.0' <<<"$(docker exec "$n-ld2" cat /workspace/.claude/skills/demo/SKILL.md)" || fail "previous version not kept"
docker stop -t 15 "$n-ld2" >/dev/null || fail "stop ld2"

# Nothing pinned: the recorded loadout is reverted.
loadouts_pod ld3 ''
docker exec "$n-ld3" test ! -e /workspace/.claude/skills/demo/SKILL.md || fail "unpinned loadout not reverted"
grep -q '"msg":"loadout reverted"' <<<"$(docker logs "$n-ld3" 2>&1)" || fail "revert not logged"
docker stop -t 15 "$n-ld3" >/dev/null || fail "stop ld3"

# The sidecar-less workspace pod gives up after 60 s and exits 1.
for _ in $(seq 1 90); do [ "$(docker inspect -f '{{.State.Running}}' "$n-nomesh")" = false ] && break; sleep 1; done
test "$(docker inspect -f '{{.State.ExitCode}}' "$n-nomesh")" = 1 || fail "workspace without a sidecar did not exit 1"
grep -q 'refusing to listen: no Istio sidecar' <<<"$(docker logs "$n-nomesh" 2>&1)" || fail "no-sidecar refusal not logged"
echo "runner-host two-pod split: OK"
