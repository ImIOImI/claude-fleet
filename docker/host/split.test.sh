#!/usr/bin/env bash
# The two-pod layout with plain Docker: wiring only. Docker has no mesh, so
# D73 is a cluster check. A container answering the sidecar readiness URL owns
# each "pod" network namespace, as istio-proxy would.
set -euo pipefail
image=$1
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
// OP=list|create [ID=…]: one broker request over CLAUDE_FLEET_BROKER_ADDR; prints the reply's JSON.
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
const create = process.env.OP === 'create';
const want = create ? 0x02 : 0x0b;
const c = net.connect(Number(p), h, () => c.write(create ? frame(0x01, { id: process.env.ID, cols: 80, rows: 24 }) : frame(0x0a)));
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
  "$image" fleet-host-entry workspace)")
ids+=("$(docker run -d --name "$n-hostnet" --network "$n" --network-alias host-svc -p 127.0.0.1::8080 --entrypoint node "$image" -e "$ready_js")")
# No state, projects or HOME overrides: host mode must find the image's own directories (D94).
ids+=("$(docker run -d --name "$n-host" --network "container:$n-hostnet" -u 1001:1001 \
  -e CLAUDE_FLEET_BROKER_ADDR=workspace-svc:7070 -e FLEET_HOST_MCP_ADDR=host-svc:8082 -e FLEET_DB_PASSWORD=app-pw \
  -v "$tmp/cfg:/etc/fleet-host:ro" -v "$tmp/key:/var/run/secrets/github-app:ro" \
  "$image" fleet-host-entry host)")
port=$(docker port "$n-hostnet" 8080/tcp | head -1 | sed 's/.*://')

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
  # 1B9E = 7070; 0A = LISTEN. Go binds 0.0.0.0 dual-stack, so the socket can be in tcp6.
  docker exec "$n-nomesh" sh -c '! grep -Eqs ":1B9E [0-9A-F]+:0000 0A" /proc/net/tcp /proc/net/tcp6' || fail "broker listened without a sidecar"
fi

# fleet-host's side of :7070.
retry bctl list >/dev/null || fail "broker unreachable over :7070"
bctl create split1 | grep -q '"ok":true' || fail "CREATE over :7070"
bctl list | grep -q '{"id":"split1","alive":true}' || fail "LIST over :7070"

# A workspace process reaches :8081 (unscoped → 400) and :8082 (tools/list).
cred_js="const [h,p]=process.env.FLEET_HOST_CRED_ADDR.split(':');const r=require('http').request({host:h,port:Number(p),method:'POST',path:'/token',headers:{'content-type':'application/json'}},(s)=>{console.log(s.statusCode);s.resume()});r.on('error',(e)=>console.log(e.code));r.end('{\"repositories\":[]}')"
until_eq 400 docker exec "$n-ws" node -e "$cred_js" || fail "unscoped POST /token from the workspace pod"
mcp_js="const s=require('net').connect(8082,'host-svc',()=>s.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'})+'\n'));let b='';s.setEncoding('utf8');s.on('data',(d)=>{b+=d;if(b.includes('\n')){console.log(JSON.parse(b).result.tools.length);s.destroy()}});s.on('error',(e)=>console.log(e.code))"
until_eq 14 docker exec "$n-ws" node -e "$mcp_js" || fail "tools/list on :8082 from the workspace pod"

# The MCP caller is the hosted workspace, whatever the wire says.
ws_id=$(docker exec -e PGPASSWORD=app-pw "$n-pg" psql -h 127.0.0.1 -U fleet_agent -d fleet -Atc 'SELECT workspace_id FROM host_meta')
[ -n "$ws_id" ] || fail "no hosted workspace id in host_meta"
docker exec "$n-host" test -s /var/lib/fleet-host/state/workspace-id.json || fail "host mode did not use the image's state dir"
caller_js="const s=require('net').connect(8082,'host-svc');let b='',n=0;s.setEncoding('utf8');
const call=(id,name,args)=>s.write(JSON.stringify({jsonrpc:'2.0',id,method:'tools/call',params:{name,arguments:args}})+'\\n');
s.on('connect',()=>call(1,'post_todo',{title:'split caller',key:'split-caller'}));
s.on('data',(d)=>{b+=d;let i;while((i=b.indexOf('\\n'))!==-1){const m=JSON.parse(b.slice(0,i));b=b.slice(i+1);
if(m.error||m.result.isError){console.log('error: '+JSON.stringify(m.error||m.result.content));s.destroy();return}
if(m.id===1)call(2,'list_todos',{});else{console.log(JSON.parse(m.result.content[0].text).map((t)=>t.source.id).join(','));s.destroy()}}});
s.on('error',(e)=>console.log(e.code))"
got=$(docker exec "$n-ws" node -e "$caller_js")
[ "$got" = "$ws_id" ] || fail "MCP caller over :8082 is '$got', want the hosted workspace $ws_id"

# What each pod holds.
test "$(docker exec "$n-host" id -u)" = 1001 || fail "host pod uid"
test "$(docker exec "$n-ws" id -u)" = 1000 || fail "workspace pod uid"
docker exec "$n-ws" test ! -e /var/run/secrets/github-app/key.pem || fail "key file in the workspace pod"
docker exec "$n-ws" sh -c 'for p in /proc/[0-9]*; do tr "\0" " " < "$p/cmdline" 2>/dev/null | grep -q "fleet-host[.]mjs" && exit 1; done; exit 0' \
  || fail "fleet-host runs in the workspace pod"

# Restarting the host pod leaves the broker and its sessions running.
ws_pid=$(docker inspect -f '{{.State.Pid}}' "$n-ws")
docker restart -t 15 "$n-host" >/dev/null
healthy || fail "host did not recover after a restart"
test "$(docker inspect -f '{{.State.Running}} {{.State.Pid}}' "$n-ws")" = "true $ws_pid" || fail "workspace pod restarted with the host"
bctl list | grep -q '{"id":"split1","alive":true}' || fail "session lost across a host restart"
docker logs "$n-host" 2>&1 | grep -q '"msg":"shutting down"' || fail "host restart was not a clean shutdown"

# The sidecar-less workspace pod gives up after 60 s and exits 1.
for _ in $(seq 1 90); do [ "$(docker inspect -f '{{.State.Running}}' "$n-nomesh")" = false ] && break; sleep 1; done
test "$(docker inspect -f '{{.State.ExitCode}}' "$n-nomesh")" = 1 || fail "workspace without a sidecar did not exit 1"
docker logs "$n-nomesh" 2>&1 | grep -q 'refusing to listen: no Istio sidecar' || fail "no-sidecar refusal not logged"
echo "runner-host two-pod split: OK"
