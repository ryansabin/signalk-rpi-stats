# signalk-rpi-stats

Comprehensive Raspberry Pi system monitoring for Signal K — CPU, memory, storage, and
power/thermal throttling — with **no sudo and no native dependencies**.

## Paths published (default prefix `environment.rpi`)
- `.cpu.temperature` (K) — `/sys/class/thermal/thermal_zone0/temp`
- `.cpu.utilisation` (ratio, overall) and `.cpu.core.<n>.utilisation` (per core)
- `.cpu.frequency` (Hz) — current ARM clock
- `.cpu.coreVoltage` (V) — `vcgencmd measure_volts core`
- `.cpu.load.1m` / `.5m` / `.15m` — load averages
- `.memory.utilisation` (ratio), `.memory.total`, `.memory.used`, `.memory.available` (bytes)
- `.storage.utilisation` (ratio), `.storage.capacity`, `.storage.used`, `.storage.available` (bytes) — for the configured mount (default `/`)
- `.uptime` (s)
- `.throttling.underVoltage` / `.throttled` / `.freqCapped` / `.softTempLimit` (bool, current)
- `.throttling.underVoltageOccurred` / `.throttledOccurred` (bool, sticky since boot)
- `notifications.<prefix>.throttling` — `alarm` on active under-voltage / throttling

## How it reads (no sudo, no native modules)
- CPU utilisation is computed from `os.cpus()` deltas between samples — **no `sysstat` needed**.
- Temperature, frequency, memory and storage come from `/sys`, `/proc`, and `statfs`.
- Core voltage and throttling come from `vcgencmd` (a PATH binary on Raspberry Pi OS).

## Requirements
- Raspberry Pi (tested on Pi 5 / Bookworm).
- For core voltage + throttling flags only: the Signal K user must be in the `video`
  group and `vcgencmd` must be present (both default on Raspberry Pi OS). Everything else
  works with no extra packages.

## Install
From the Signal K appstore, or with npm:

```bash
cd ~/.signalk
npm install signalk-rpi-stats
```

Then enable **Raspberry Pi Stats** in the Signal K plugin config and restart the server.

## Configuration
| Option | Default | Notes |
|---|---|---|
| Sample rate (s) | 10 | |
| Base Signal K path | `environment.rpi` | prefix for all paths |
| Per-core CPU utilisation | true | also publish `.cpu.core.<n>.utilisation` |
| Storage filesystem | `/` | mount to report storage for |
| Report throttling | true | uses `vcgencmd get_throttled` |
| Notify on under-voltage/throttling | true | raise an alarm notification |

## Notes
- On the Pi 5 there is a single SoC thermal sensor, so "CPU temperature" is the SoC temperature.
- The throttling flags use the official `vcgencmd get_throttled` bitmask; `*Occurred`
  flags are sticky since boot. The notification firing on under-voltage is a good early
  warning for marine 12 V power-supply issues.

## Credits / license
In the lineage of `signalk-raspberry-pi-temperature` / `-monitoring` / `rpi-monitor`,
rebuilt dependency-free and sudo-free for the Pi 5. Licensed under Apache-2.0.
