# Changelog

## 0.3.0

- Report the display backlight brightness as `display.backlight` (ratio) and
  set it with a PUT to the same path. The lowest brightness a PUT can set is
  configurable, so the screen cannot be switched off by accident.

## 0.2.1 - 2026-06-18

- Sample every 10 seconds by default (was 20).

## 0.2.0 - 2026-06-18

- Report memory and storage in bytes as well: `memory.total`, `memory.used`,
  `memory.available`, `storage.capacity`, `storage.used` and
  `storage.available`.

## 0.1.0 - 2026-06-18

- First release: CPU temperature, utilisation (overall and per core),
  frequency and core voltage, load averages, memory and storage utilisation,
  uptime, and the throttling and under-voltage flags with an alarm
  notification. No sudo and no npm dependencies.
