# signalk-rpi-stats

Comprehensive Raspberry Pi system monitoring for Signal K — CPU, memory, storage,
power/thermal throttling, OverlayFS / boot read-only state, and display backlight
control — with **no sudo and no native dependencies**.

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
- `.overlayfs.active` (bool) — root filesystem is currently a RAM-backed overlay
- `.overlayfs.activeAtNextBoot` (bool) — what `cmdline.txt` on the boot partition says
- `.overlayfs.state` (string) — `active` / `inactive` / `pendingEnable` / `pendingDisable`
- `.overlayfs.upperSpace.utilisation` (ratio), `.capacity`, `.used`, `.available` (bytes) — the
  overlay's writable RAM layer; only published while the overlay is active
- `.bootPartition.mount` (string) — `/boot/firmware` (Bookworm) or `/boot`
- `.bootPartition.readOnly` (bool, current mount) / `.readOnlyAtNextBoot` (bool, from `/etc/fstab`)
- `.display.backlight` (ratio) — **read *and* write**; see [Display backlight](#display-backlight)
- `notifications.<prefix>.throttling` — `alarm` on active under-voltage / throttling
- `notifications.<prefix>.overlayfs.upperSpace` — `warn` / `alarm` as the overlay RAM layer fills

## How it reads (no sudo, no native modules)
- CPU utilisation is computed from `os.cpus()` deltas between samples — **no `sysstat` needed**.
- Temperature, frequency, memory and storage come from `/sys`, `/proc`, and `statfs`.
- Core voltage and throttling come from `vcgencmd` (a PATH binary on Raspberry Pi OS).
- OverlayFS and boot read-only status come from world-readable `/proc/mounts`, `/proc/cmdline`,
  `/etc/fstab`, the boot partition's `cmdline.txt` and `/etc/overlayroot.conf` — no `raspi-config`,
  no root. Both overlay mechanisms are recognised: raspi-config's own initramfs script
  (`boot=overlay`) and the `overlayroot` package (`overlayroot=tmpfs`, set on the kernel
  command line or in `overlayroot.conf`, where `disabled` or an empty value means off).
- Backlight brightness is read from and written to `/sys/class/backlight/<dev>/brightness`,
  which Raspberry Pi OS makes group-writable by `video` — so no sudo helper is needed.

## Requirements
- Raspberry Pi (tested on Pi 5 / Bookworm).
- For core voltage + throttling flags only: the Signal K user must be in the `video`
  group and `vcgencmd` must be present (both default on Raspberry Pi OS). Everything else
  works with no extra packages.
- For backlight *control* only: the same `video` group membership, plus a display whose
  driver exposes `/sys/class/backlight` (the official Raspberry Pi touch display does;
  most HDMI monitors do not).

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
| Report OverlayFS / boot read-only | true | reads `/proc` and `/etc/fstab` only |
| Notify when the OverlayFS RAM layer fills | true | only ever fires while the overlay is active |
| OverlayFS warn level | 0.8 | ratio full at which the notification goes `warn` |
| OverlayFS alarm level | 0.95 | ratio full at which it goes `alarm` |
| Report & control display backlight | true | publishes `.display.backlight` and registers the PUT handler |
| Backlight device | *(blank)* | name under `/sys/class/backlight`; blank auto-detects the first one |
| Minimum brightness | 0.05 | floor the control will not go below, so the screen never goes fully black |

## Display backlight

`.display.backlight` is a 0–1 ratio and is the one path here that is writable. The plugin
registers a Signal K PUT handler for it, so any client — KIP, the admin UI's data browser,
a REST call — can dim the screen:

```bash
curl -X PUT http://localhost:3000/signalk/v1/api/vessels/self/environment/rpi/display/backlight \
  -H 'Content-Type: application/json' -d '{"value": 0.4}'
```

Useful at night: bind it to a KIP slider or drive it from a plugin so the chartplotter
dims after sunset. Values are clamped to `[minimum brightness, 1]` — the floor exists so
you cannot black out the screen and then be unable to find the control to bring it back.
The written value is echoed straight back onto the path, so sliders track reality.

Device detection: with **Backlight device** blank the plugin takes the first entry under
`/sys/class/backlight` (`10-0045` on the official Raspberry Pi touch display); set the name
explicitly if you have more than one. If nothing is found, the path is simply never
published and no PUT handler is registered — the rest of the plugin is unaffected.

## Notes
- On the Pi 5 there is a single SoC thermal sensor, so "CPU temperature" is the SoC temperature.
- The throttling flags use the official `vcgencmd get_throttled` bitmask; `*Occurred`
  flags are sticky since boot. The notification firing on under-voltage is a good early
  warning for marine 12 V power-supply issues.
- OverlayFS (raspi-config → Performance → Overlay File System, or the `overlayroot` package)
  makes the root filesystem discard every write on reboot, which protects the SD card from a
  hard power-off but also silently throws away anything you change. Both it and the boot
  read-only setting only
  take effect on reboot, so each is reported twice: the running state and the on-disk
  config that applies at next boot. `state` collapses the two into
  `active` / `inactive` / `pendingEnable` / `pendingDisable`; the plugin status line shows
  `overlay` and `boot:ro` markers.
- `.overlayfs.upperSpace.*` is the headroom that actually matters while the overlay is on:
  the writable layer is a tmpfs in RAM, so when it fills, writes start failing across the
  whole system even though the SD card is nearly empty. Long-running logs are the usual
  culprit on a boat that stays powered for weeks. `notifications.<prefix>.overlayfs.upperSpace`
  covers this: `warn` (visual) at 0.8 full, `alarm` (visual + sound) at 0.95, back to `normal`
  when it drains, with the free space in the message. It is emitted only on a state *change*,
  and only while the overlay is active — a Pi with no overlay never sees the path at all.
- While the overlay is active, `.storage.*` for `/` reports that same RAM layer rather than
  the SD card, because that is what `statfs` on an overlay mount returns. Point the storage
  mount at the real device if you need card usage.

## Credits / license
In the lineage of `signalk-raspberry-pi-temperature` / `-monitoring` / `rpi-monitor`,
rebuilt dependency-free and sudo-free for the Pi 5. Licensed under Apache-2.0.
