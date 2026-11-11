#!/usr/bin/env bash
# One run of the board's reporter, on a machine an environment follows: reads the machine's CPU, memory
# and disk for about a minute, keeps 6 hours of it, and writes the reading to the environment's variables,
# where every member's board reads it. It only sends: nothing listens on the machine, and no member needs
# a private network to see it.
#
# board-report.service runs it, as a user of its own that systemd makes for the run, with:
#   BOARD_ENV          the environment, owner/name
#   BOARD_HOST         the machine's name in the environment's configuration
#   STATE_DIRECTORY    where the history is kept
#   CREDENTIALS_DIRECTORY/token   a fine-grained token with "Variables: write" on BOARD_ENV, and nothing else
#
# Numbers only: no process, path, address, or anything about what the machine runs.
# The tests set REPORT_SAMPLES and REPORT_INTERVAL (shorter runs), REPORT_PROC (another /proc),
# REPORT_DRY (measure without sending) and REPORT_API (a stand-in for GitHub on 127.0.0.1).
set -euo pipefail
export LC_ALL=C

readonly state=${STATE_DIRECTORY:?run it from board-report.service, which sets STATE_DIRECTORY}
# 58 samples a second apart, so a run lasts about a minute.
readonly samples=${REPORT_SAMPLES:-58} interval=${REPORT_INTERVAL:-1}
readonly proc=${REPORT_PROC:-/proc}
readonly keep=360 # one point a minute: 6 hours

die() {
  echo "board-report: $*" >&2
  exit 1
}

# --- Reads the machine.

# MemAvailable in MiB, into $mib: bash alone, with no subshell, so that sleep is the only process a sample starts.
available() {
  local key value _
  while read -r key value _; do
    if [ "$key" = MemAvailable: ]; then
      mib=$(((value + 512) / 1024))
      return
    fi
  done <"$proc/meminfo"
  die "no MemAvailable in $proc/meminfo"
}
# user nice system idle iowait irq softirq steal. Guest time is counted in user already.
cpu() { awk '/^cpu / { printf "%.0f %.0f\n", $2 + $3 + $4 + $5 + $6 + $7 + $8 + $9, $5 + $6; exit }' "$proc/stat"; }

# A heavy job peaks for a few seconds: one sample a minute, or even every 5 seconds, misses what matters.
available
lowest=$mib
read -r total_before idle_before < <(cpu)
for ((i = 0; i < samples; i++)); do
  sleep "$interval"
  available
  if [ "$mib" -lt "$lowest" ]; then lowest=$mib; fi
done
read -r total_after idle_after < <(cpu)
busy=$(awk -v t=$((total_after - total_before)) -v i=$((idle_after - idle_before)) \
  'BEGIN { printf "%.0f", (t > 0) ? 100 * (t - i) / t : 0 }')

at=$(date +%s)
uptime=$(awk '{ printf "%.0f", $1 }' "$proc/uptime")
# The machine's threads: nproc would count the 5% of one CPU this service is allowed.
cpus=$(awk '/^cpu[0-9]+ / { n++ } END { print n + 0 }' "$proc/stat")
read -r load1 load5 _ <"$proc/loadavg"
memory_total=$(awk '/^MemTotal:/ { printf "%.0f", $2 / 1024; exit }' "$proc/meminfo")
available
memory_now=$mib
# The last sample is one too: the lowest is never above what is available now.
if [ "$memory_now" -lt "$lowest" ]; then lowest=$memory_now; fi
oom=$(awk '/^oom_kill / { print $2; exit }' "$proc/vmstat")
oom=${oom:-0}
# Counted from the end of the line: a filesystem's name can hold spaces.
read -r disk_total disk_free < <(df -P -m / | awk 'NR == 2 { print $(NF - 4), $(NF - 2) }')
# Null when the kernel doesn't expose pressure: reading the file then fails.
pressure=$(awk '/^some / { sub("avg60=", "", $3); print $3; exit }' "$proc/pressure/memory" 2>/dev/null || true)
[[ $pressure =~ ^[0-9]+(\.[0-9]+)?$ ]] || pressure=null

# Everything written is checked first, so that a surprise in /proc fails this run instead of
# publishing something that isn't a number.
for name in lowest busy at uptime cpus load1 load5 memory_total memory_now oom disk_total disk_free; do
  [[ ${!name} =~ ^[0-9]+(\.[0-9]+)?$ ]] || die "$name isn't a number: '${!name}'"
done

points=$state/points
printf '[%s,%s,%s,%s,%s]\n' "$at" "$lowest" "$busy" "$disk_free" "$oom" >>"$points"
# A line cut short by a power cut is dropped rather than published, before counting what to keep.
grep -E '^\[[0-9]+,[0-9]+,[0-9]+,[0-9]+,[0-9]+\]$' "$points" | tail -n "$keep" >"$points.new" || true
mv -f "$points.new" "$points"

# The format the board reads (parseReading in src/server/infra/probes.ts): a change raises "v".
reading=$state/reading.json
{
  printf '{"v":1,"at":%s,"uptime_s":%s,"cpus":%s,"cpu_busy_pct":%s,"load1":%s,"load5":%s,' \
    "$at" "$uptime" "$cpus" "$busy" "$load1" "$load5"
  printf '"memory_total_mib":%s,"memory_available_mib":%s,"memory_available_lowest_mib":%s,' \
    "$memory_total" "$memory_now" "$lowest"
  printf '"memory_pressure_avg60":%s,"oom_kills":%s,"disk_total_mib":%s,"disk_free_mib":%s,' \
    "$pressure" "$oom" "$disk_total" "$disk_free"
  printf '"points":['
  awk 'NR > 1 { printf "," } { printf "%s", $0 }' "$points"
  printf ']}\n'
} >"$reading.new"
mv -f "$reading.new" "$reading"

[ -z "${REPORT_DRY:-}" ] || exit 0

# --- Sends it.

readonly environment=${BOARD_ENV:?BOARD_ENV is the environment, owner/name}
[[ $environment =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || die "BOARD_ENV isn't owner/name: '$environment'"
readonly name=${BOARD_HOST:?BOARD_HOST is the name the environment knows this machine by}
[[ $name =~ ^[a-z0-9][a-z0-9-]{0,40}$ ]] || die "BOARD_HOST is lowercase letters, digits and dashes: '$name'"
readonly api=${REPORT_API:-https://api.github.com}
# The token goes to GitHub, or to a test's stand-in on this machine, never anywhere else.
[[ $api == https://api.github.com || $api =~ ^http://127\.0\.0\.1:[0-9]+$ ]] || die "REPORT_API is GitHub's"
readonly token_file=${CREDENTIALS_DIRECTORY:-/nonexistent}/token
[ -r "$token_file" ] || die "no token: install.sh install stores one"
token=$(tr -d '\r\n' <"$token_file")
[[ $token =~ ^github_pat_[A-Za-z0-9_]{20,255}$ ]] || die "the token isn't a fine-grained one"

# BOARD_HOST_CI_1 for ci-1: the board reads the name back from it.
variable=BOARD_HOST_$(printf '%s' "$name" | tr 'a-z-' 'A-Z_')
# A variable holds 48 KB: a reading is about 11.
[ "$(wc -c <"$reading")" -le 45000 ] || die "the reading is too long for a variable"
body=$state/body.json
printf '{"name":"%s","value":"%s"}' "$variable" "$(tr -d '\r\n' <"$reading" | sed 's/\\/\\\\/g; s/"/\\"/g')" >"$body"

# The token reaches curl on its standard input, never on a command line another process could read.
send() {
  printf 'header = "Authorization: Bearer %s"\n' "$token" |
    curl -sS --max-time 20 -o /dev/null -w '%{http_code}' -K - -X "$1" \
      -H 'Accept: application/vnd.github+json' -H 'X-GitHub-Api-Version: 2022-11-28' \
      -H 'Content-Type: application/json' --data-binary @"$body" "$api$2" || true
}
# Changed in place; made the first time.
status=$(send PATCH "/repos/$environment/actions/variables/$variable")
if [ "$status" = 404 ]; then status=$(send POST "/repos/$environment/actions/variables"); fi
printf '%s %s\n' "$(date +%s)" "$status" >"$state/sent"
case $status in
  201 | 204) ;;
  401) die "GitHub refuses the token: it has expired or was revoked. Store a new one with install.sh install." ;;
  403 | 404) die "GitHub answered $status: the token needs \"Variables: write\" on $environment." ;;
  000) die "GitHub couldn't be reached." ;;
  *) die "GitHub answered $status." ;;
esac
