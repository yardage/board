# The board's reporter

What puts a machine's CPU, memory and disk on the board's Hosts tab. It runs on each machine an environment follows, a CI runner or a server, and writes one reading a minute to the environment's repository variables, where every member's board reads it.

It only sends. Nothing listens on the machine, no member needs a private network to see it, and the board never reaches the machine.

## What it does

- **It reads, about once a minute.** `board-report.timer` starts a run as soon as the last one ends. A run samples `MemAvailable` every second and keeps the lowest, because a heavy job peaks for a few seconds. It also measures how busy the CPU was over the minute, and reads the load, memory pressure, OOM kills and the `/` filesystem. It reads only `/proc` and `df`.
- **It keeps 6 hours.** One point a minute, 360 at most, in `/var/lib/board-report`, so the history survives a reboot.
- **It writes one variable.** `BOARD_HOST_<NAME>` in the environment's repository, `BOARD_HOST_CI_1` for `ci-1`, through GitHub's API, with a token that can do nothing else.
- **It costs next to nothing.** Under 32 MB and 5% of one CPU, at the lowest priority. A run that goes well writes nothing to the journal.
- **Numbers only.** No process name, path, address, or anything about what the machine runs.

## What it needs

- A Linux machine with systemd and `curl`.
- Its name in the environment's configuration, under Settings · Machines, with its role: `ci`, `dev`, `server` or `other`. A machine the configuration doesn't name shows as "other".
- A **fine-grained token**, made by a member at [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new): the environment's owner as resource owner, **only** the environment's repository, and one permission, **Variables: Read and write**. An organisation may have to approve it. A classic token is refused: it would reach every repository of the person who made it. One token can serve every machine; give it an expiry date, and install a new one before then.

## Install, check, remove

As root, from a copy of this folder, with the token on standard input so that it is never on a command line:

```sh
sudo ./install.sh install acme/agora ci-1 < token.txt   # install or update: it can run again
sudo ./install.sh install acme/agora ci-1 < /dev/null   # update, keeping the stored token
sudo ./install.sh status                                # whether it runs, and what GitHub last answered
sudo ./install.sh remove                                # everything it put there, and its variable
```

The machine's name defaults to its short host name. Within a minute, the Hosts tab shows it on every member's board.

What `install.sh` puts on a machine:

| What | Where |
| --- | --- |
| `report.sh` | `/usr/local/libexec/board-report` |
| [`units/`](units) | `/etc/systemd/system/` |
| The environment and the machine's name | `/etc/board-report/environment` |
| The token, root's alone | `/etc/board-report/token`, handed to each run by systemd (`LoadCredential`) |
| The history | `/var/lib/board-report/` |

A run is a user systemd makes for it (`DynamicUser`), that owns nothing but the history. It reads the token only through what systemd hands it, can't write anywhere else, and has no other privilege.

## What a reading is worth

Whoever runs as root on the machine, such as a job on a CI runner, can stop the reporter, make it say anything about this machine, or read the token. With the token, they could write any variable of the environment's repository, and nothing else: not its code, threads or settings. The board treats a reading as someone else's text, keeps only numbers in range, and only displays them. **So nothing may act on a reading.**

## The format

`v: 1`, which `parseReading` in [`src/server/infra/probes.ts`](../src/server/infra/probes.ts) reads, and refuses for one odd field:

| Field | Meaning |
| --- | --- |
| `v` | Format version, `1` |
| `at` | When the run ended, in Unix seconds, by the machine's clock |
| `uptime_s` | Time since boot, which shows a reboot and scopes `oom_kills` |
| `cpus` | The machine's CPU threads |
| `cpu_busy_pct` | % of the CPU busy over the run |
| `load1`, `load5` | Load averages |
| `memory_total_mib` | `MemTotal` |
| `memory_available_mib` | `MemAvailable` at the end of the run. Not `MemFree`, which counts the page cache as used |
| `memory_available_lowest_mib` | The lowest `MemAvailable` of the run |
| `memory_pressure_avg60` | `some avg60` from `/proc/pressure/memory`, or `null` if the kernel doesn't expose it |
| `oom_kills` | `oom_kill` from `/proc/vmstat`, since boot |
| `disk_total_mib`, `disk_free_mib` | The `/` filesystem |
| `points` | Up to 360 `[at, lowest available MiB, % CPU busy, free disk MiB, oom_kills]`, oldest first |

A change of format raises `v`, in both places at once.

## Testing

```sh
npm test         # test/server/host-report.test.ts: what report.sh writes, read by the board's own parser
host/test.sh     # the install under systemd, in a throwaway Ubuntu 26.04 container; needs Docker
```

`host/test.sh` never runs on a real machine. It checks the refusals, a first run that makes the variable and a second that changes it, the token's place and mode, a run as its own user, a second install, the status, a quiet journal, and a removal that takes everything away. It ends with `PASS`.
