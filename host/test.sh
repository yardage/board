#!/usr/bin/env bash
# Tests the reporter's install in a throwaway Ubuntu 26.04 container with systemd, never on a real machine,
# with a stand-in for GitHub on the container's loopback. Needs Docker. The container is removed at the
# end, whatever happens. What report.sh writes is also checked by test/server/host-report.test.ts.
#
#   host/test.sh
set -euo pipefail
# Git Bash would rewrite the container's paths into Windows ones.
export MSYS_NO_PATHCONV=1

here=$(cd "$(dirname "$0")" && pwd)
readonly image=board-report-test container=board-report-test-$$

docker build -q -t "$image" - >/dev/null <<'EOF'
FROM ubuntu:26.04
RUN apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --no-install-recommends \
      systemd systemd-sysv curl python3 >/dev/null && rm -rf /var/lib/apt/lists/*
STOPSIGNAL SIGRTMIN+3
CMD ["/sbin/init"]
EOF
trap 'docker rm -f "$container" >/dev/null 2>&1 || true' EXIT
docker run -d --name "$container" --hostname ci-7 --privileged --cgroupns=host -v /sys/fs/cgroup:/sys/fs/cgroup:rw \
  --tmpfs /run --tmpfs /run/lock "$image" >/dev/null
# The folder goes over as an install sends it.
tar -C "$here" -cf - . | docker exec -i "$container" bash -c 'mkdir -p /host && tar -xf - --no-same-owner -C /host'

docker exec -i "$container" bash -s <<'TEST'
set -euo pipefail
readonly token=github_pat_0123456789abcdefghij0123456789abcdefghij port=8099
fail() { echo "FAIL: $*" >&2; exit 1; }
ok() { echo "ok: $*"; }
until [[ $(systemctl is-system-running 2>/dev/null) =~ ^(running|degraded)$ ]]; do sleep 1; done

# GitHub's variables, as far as the reporter uses them: a request log, and the variables it holds.
cat >/usr/local/bin/fake-github <<'PY'
import http.server, json, sys
variables = {}
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args): pass
    def answer(self, status):
        self.send_response(status); self.send_header("Content-Length", "0"); self.end_headers()
    def handle_one(self, method):
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
        with open("/tmp/requests.log", "a") as log:
            log.write(json.dumps({"method": method, "path": self.path, "auth": self.headers.get("Authorization"), "body": body}) + "\n")
        name = self.path.rsplit("/", 1)[-1]
        if method == "PATCH":
            if name not in variables: return self.answer(404)
            variables[name] = json.loads(body)["value"]; return self.answer(204)
        if method == "POST":
            sent = json.loads(body); variables[sent["name"]] = sent["value"]; return self.answer(201)
        if method == "DELETE":
            variables.pop(name, None); return self.answer(204)
        self.answer(405)
    def do_PATCH(self): self.handle_one("PATCH")
    def do_POST(self): self.handle_one("POST")
    def do_DELETE(self): self.handle_one("DELETE")
http.server.HTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
PY
python3 -I /usr/local/bin/fake-github "$port" &
# Here a run lasts a second instead of a minute, and GitHub is the stand-in.
mkdir -p /etc/systemd/system/board-report.service.d
printf '[Service]\nEnvironment=REPORT_SAMPLES=1 REPORT_INTERVAL=1 REPORT_API=http://127.0.0.1:%s\n' "$port" \
  >/etc/systemd/system/board-report.service.d/test.conf

# --- What install refuses.

! bash /host/install.sh install acme/agora </dev/null 2>/dev/null || fail "an install without a token"
! printf 'ghp_classic0123456789012345678901234567\n' | bash /host/install.sh install acme/agora 2>/dev/null || fail "a classic token"
! printf '%s\n' "$token" | bash /host/install.sh install 'not a repo' 2>/dev/null || fail "a bad environment"
! printf '%s\n' "$token" | bash /host/install.sh install acme/agora 'CI 7' 2>/dev/null || fail "a bad name"
[ ! -e /etc/board-report ] || fail "a refused install left something"
ok "install refuses no token, a classic token, and bad names"

# --- Installed, as on a machine.

out=$(printf '%s\n' "$token" | bash /host/install.sh install acme/agora)
[ "$out" = "board-report done: ci-7 writes BOARD_HOST_CI_7 to acme/agora every minute" ] || fail "install said: $out"
[ "$(stat -c '%a %U' /etc/board-report/token)" = "600 root" ] || fail "the token's mode"
for _ in $(seq 30); do grep -q '"POST"' /tmp/requests.log 2>/dev/null && break; sleep 1; done
python3 -I - "$token" <<'PY' || fail "the first send"
import json, sys
requests = [json.loads(line) for line in open("/tmp/requests.log")]
assert [r["method"] for r in requests[:2]] == ["PATCH", "POST"], requests
assert requests[0]["path"] == "/repos/acme/agora/actions/variables/BOARD_HOST_CI_7"
assert all(r["auth"] == "Bearer " + sys.argv[1] for r in requests)
sent = json.loads(requests[1]["body"])
assert sent["name"] == "BOARD_HOST_CI_7"
reading = json.loads(sent["value"])
numbers = {"at", "uptime_s", "cpus", "cpu_busy_pct", "load1", "load5", "memory_total_mib",
           "memory_available_mib", "memory_available_lowest_mib", "oom_kills", "disk_total_mib", "disk_free_mib"}
assert set(reading) == numbers | {"v", "memory_pressure_avg60", "points"}, sorted(reading)
assert reading["v"] == 1 and all(type(reading[n]) in (int, float) for n in numbers)
assert 0 < reading["memory_available_lowest_mib"] <= reading["memory_available_mib"] <= reading["memory_total_mib"]
assert len(reading["points"]) == 1 and all(type(v) is int for v in reading["points"][0])
PY
ok "a run writes its reading to the machine's variable, made the first time"
python3 -I -c 'import json, sys; assert json.loads(json.loads(open("/tmp/requests.log").readlines()[1])["body"])["value"].count("\"cpus\":%s," % sys.argv[1]) == 1' \
  "$(grep -c '^cpu[0-9]' /proc/stat)" || fail "cpus counts the service's share, not the machine"
ok "it counts the machine's CPUs, not its own share"

for _ in $(seq 30); do [ "$(grep -c '"PATCH"' /tmp/requests.log)" -ge 2 ] && break; sleep 1; done
[ "$(grep -c '"PATCH"' /tmp/requests.log)" -ge 2 ] || fail "a second run"
ok "the timer starts the next run, which changes the variable in place"

owner=$(stat -c %u /var/lib/private/board-report)
[ "$owner" != 0 ] || fail "the history belongs to root"
! grep -q "$token" /var/lib/private/board-report/* 2>/dev/null || fail "the token is in the history"
ok "the run is its own user, and keeps no token"

again=$(bash /host/install.sh install acme/agora </dev/null)
[ "$again" = "board-report done: ci-7 writes BOARD_HOST_CI_7 to acme/agora every minute" ] || fail "a second install: $again"
grep -qx "$token" /etc/board-report/token || fail "a second install without a token kept it"
ok "install runs again, and keeps the stored token"

bash /host/install.sh status | grep -q 'GitHub answered 20[14]' || fail "status: $(bash /host/install.sh status)"
ok "status says what GitHub answered"

noise=$(journalctl -q --no-pager -u board-report.service | grep -cE 'Start|Finish|Deactivated' || true)
[ "$noise" = 0 ] || fail "$noise lines in the journal for runs that went well"
ok "a run that goes well writes nothing to the journal"
echo "   board-report.service: $(systemd-analyze security --no-pager board-report.service 2>/dev/null | tail -n 1)"

REPORT_API=http://127.0.0.1:$port bash /host/install.sh remove >/dev/null
grep -q '"DELETE"' /tmp/requests.log || fail "remove kept the variable"
! systemctl cat board-report.service >/dev/null 2>&1 || fail "a unit is left"
[ ! -e /etc/board-report ] && [ ! -e /var/lib/private/board-report ] && [ ! -e /usr/local/libexec/board-report ] || fail "a file is left"
ok "remove takes everything away, the variable included"
echo "PASS"
TEST
