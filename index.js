'use strict'

/*
 * signalk-rpi-stats — Raspberry Pi system stats for Signal K
 *
 * Publishes (default prefix environment.rpi):
 *   .cpu.temperature        K     (/sys/class/thermal/thermal_zone0/temp)
 *   .cpu.utilisation        ratio (overall, from os.cpus() deltas)
 *   .cpu.core.<n>.utilisation ratio (per core)
 *   .cpu.frequency          Hz    (/sys/.../scaling_cur_freq)
 *   .cpu.coreVoltage        V     (vcgencmd measure_volts core)
 *   .cpu.load.1m/.5m/.15m   -     (os.loadavg)
 *   .memory.utilisation     ratio (/proc/meminfo, 1 - MemAvailable/MemTotal)
 *   .memory.total           bytes
 *   .memory.used            bytes
 *   .memory.available       bytes
 *   .storage.utilisation    ratio (statfs of the configured mount)
 *   .storage.capacity       bytes (total size)
 *   .storage.used           bytes
 *   .storage.available      bytes
 *   .uptime                 s     (os.uptime)
 *   .throttling.*           bool  (vcgencmd get_throttled bit flags)
 *   .display.backlight      ratio (/sys/class/backlight/<dev>/brightness; READ + WRITE via PUT)
 *   .overlayfs.*            bool/string (/proc/mounts + /proc/cmdline + cmdline.txt)
 *   .overlayfs.upperSpace.* bytes/ratio (statfs of the overlay's RAM upper layer)
 *   .bootPartition.*        bool/string (/proc/mounts + /etc/fstab)
 *   notifications.<prefix>.throttling  alarm on under-voltage / throttling
 *   notifications.<prefix>.overlayfs.upperSpace  warn/alarm as the RAM layer fills
 *
 * Zero npm dependencies. No sudo. Reads /sys, /proc, statfs, os, and `vcgencmd`
 * (PATH binary; only needs the running user in the `video` group). Pi 5 friendly.
 */

const fs = require('fs')
const os = require('os')
const { execFile } = require('child_process')

module.exports = function (app) {
  let timer = null
  let lastCpu = null
  let lastNotif = null
  let lastOverlayNotif = null
  let bl = null           // resolved backlight device: { dir, name, max }
  let putPath = null      // path the PUT handler is registered for (guards re-registration)

  const plugin = {
    id: 'signalk-rpi-stats',
    name: 'Raspberry Pi Stats',
    description: 'Publishes Raspberry Pi system stats (CPU temp/util/freq/voltage, memory, storage, uptime, load, throttling/under-voltage) to Signal K. No sudo, no native dependencies.'
  }

  plugin.schema = {
    type: 'object',
    properties: {
      rate: { type: 'number', title: 'Sample rate (seconds)', default: 10 },
      prefix: { type: 'string', title: 'Base Signal K path', default: 'environment.rpi' },
      perCore: { type: 'boolean', title: 'Report per-core CPU utilisation', default: true },
      storageMount: { type: 'string', title: 'Filesystem to report storage for', default: '/' },
      reportThrottle: { type: 'boolean', title: 'Report throttling / under-voltage (uses vcgencmd)', default: true },
      throttleNotify: { type: 'boolean', title: 'Raise a notification on under-voltage / throttling', default: true },
      reportOverlay: { type: 'boolean', title: 'Report OverlayFS state and boot partition read-only status', default: true },
      overlayNotify: { type: 'boolean', title: 'Raise a notification when the OverlayFS RAM layer fills up', default: true },
      overlayWarn: { type: 'number', title: 'OverlayFS RAM layer warn level (0-1 ratio full)', default: 0.8 },
      overlayAlarm: { type: 'number', title: 'OverlayFS RAM layer alarm level (0-1 ratio full)', default: 0.95 },
      reportBacklight: { type: 'boolean', title: 'Report & control display backlight brightness', default: true },
      backlightDevice: { type: 'string', title: 'Backlight device under /sys/class/backlight (blank = auto-detect)', default: '' },
      minBacklight: { type: 'number', title: 'Minimum brightness the control allows (0-1 ratio, prevents blacking out the screen)', default: 0.05 }
    }
  }

  function readNum (path, div) {
    try { return parseInt(fs.readFileSync(path, 'utf8').trim(), 10) / (div || 1) } catch (e) { return null }
  }
  function fmtBytes (b) {
    if (b == null) return '?'
    if (b >= 1073741824) return (b / 1073741824).toFixed(1) + ' GB'
    if (b >= 1048576) return (b / 1048576).toFixed(0) + ' MB'
    return (b / 1024).toFixed(0) + ' kB'
  }
  function sh (cmd, args) {
    return new Promise((res) => execFile(cmd, args, { timeout: 4000 }, (e, o) => res(e ? null : String(o).trim())))
  }

  // Resolve the backlight device: honour an override name, else pick the first
  // entry under /sys/class/backlight. Reads max_brightness once. Returns null if none.
  function resolveBacklight (override) {
    try {
      const base = '/sys/class/backlight'
      const name = (override && override.trim()) ? override.trim() : (fs.readdirSync(base)[0] || '')
      if (!name) return null
      const dir = base + '/' + name
      const max = parseInt(fs.readFileSync(dir + '/max_brightness', 'utf8').trim(), 10)
      if (!max || Number.isNaN(max)) return null
      return { dir, name, max }
    } catch (e) { return null }
  }

  function readBacklightRatio () {
    if (!bl) return null
    const raw = readNum(bl.dir + '/brightness', 1)
    if (raw == null) return null
    return Math.max(0, Math.min(1, raw / bl.max))
  }

  // Clamp to [minRatio, 1] (floor keeps the screen visible so you can find the
  // control again), map to 0..max, write the raw value to sysfs. No sudo: the
  // brightness file is group-writable by `video` and Signal K runs as that user.
  function writeBacklightRatio (ratio, minRatio) {
    if (!bl) return { ok: false, msg: 'no backlight device' }
    let r = Number(ratio)
    if (Number.isNaN(r)) return { ok: false, msg: 'value is not a number' }
    const floor = (typeof minRatio === 'number' && minRatio >= 0 && minRatio <= 1) ? minRatio : 0.05
    r = Math.max(floor, Math.min(1, r))
    const raw = Math.round(r * bl.max)
    try {
      fs.writeFileSync(bl.dir + '/brightness', String(raw))
      return { ok: true, ratio: r, raw }
    } catch (e) { return { ok: false, msg: e.message } }
  }

  function cpuUtil () {
    const cur = os.cpus()
    if (!lastCpu || lastCpu.length !== cur.length) { lastCpu = cur; return null }
    const per = []
    let totBusy = 0
    let totAll = 0
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i].times
      const b = lastCpu[i].times
      const idle = a.idle - b.idle
      const all = (a.user - b.user) + (a.nice - b.nice) + (a.sys - b.sys) + (a.irq - b.irq) + idle
      const busy = all - idle
      per.push(all > 0 ? busy / all : 0)
      totBusy += busy
      totAll += all
    }
    lastCpu = cur
    return { all: totAll > 0 ? totBusy / totAll : 0, per }
  }

  function memUtil () {
    try {
      const mi = fs.readFileSync('/proc/meminfo', 'utf8')
      const g = (k) => { const m = mi.match(new RegExp('^' + k + ':\\s+(\\d+)', 'm')); return m ? parseInt(m[1], 10) * 1024 : null }
      const total = g('MemTotal')
      const avail = g('MemAvailable')
      if (total && avail != null) return { ratio: 1 - avail / total, total, used: total - avail, available: avail }
    } catch (e) {}
    return null
  }

  function storageUtil (mount) {
    try {
      const s = fs.statfsSync(mount)
      const capacity = s.blocks * s.bsize
      const available = s.bavail * s.bsize
      const used = (s.blocks - s.bfree) * s.bsize
      if (capacity > 0) return { ratio: 1 - s.bavail / s.blocks, capacity, used, available }
    } catch (e) {}
    return null
  }

  // ---- OverlayFS / boot partition read-only -------------------------------
  // raspi-config's "Overlay File System" turns the root fs into a RAM-backed
  // overlay (nothing survives a reboot) and can separately mount the boot
  // partition read-only. Both are worth knowing before you go changing things
  // on a boat. Everything below comes from world-readable /proc and /etc, so
  // this stays inside the no-sudo, no-dependency design.
  //
  // Each is reported twice: the running state, and the on-disk config that
  // applies at next boot — a raspi-config toggle only takes effect on reboot,
  // and the gap between the two is exactly what you want to see.

  const BOOT_MOUNTS = ['/boot/firmware', '/boot']

  function readText (path) {
    try { return fs.readFileSync(path, 'utf8') } catch (e) { return null }
  }

  // /proc/mounts fields: dev, mountpoint, fstype, options. Mount points escape
  // spaces (and a few other chars) octally; \040 is the one worth handling.
  function readMounts () {
    const txt = readText('/proc/mounts')
    if (txt == null) return null
    return txt.split('\n').filter((l) => l.trim()).map((l) => {
      const f = l.split(/\s+/)
      return { dev: f[0], mount: (f[1] || '').replace(/\\040/g, ' '), type: f[2] || '', opts: (f[3] || '').split(',') }
    })
  }

  function fstabOpts (mount) {
    const txt = readText('/etc/fstab')
    if (txt == null) return null
    for (const line of txt.split('\n')) {
      const s = line.trim()
      if (!s || s[0] === '#') continue
      const f = s.split(/\s+/)
      if (f[1] === mount) return (f[3] || '').split(',')
    }
    return null
  }

  // Two different overlay mechanisms are in use on Raspberry Pi OS and they
  // configure themselves completely differently:
  //
  //   raspi-config's own initramfs script  ->  boot=overlay  on the cmdline
  //   the `overlayroot` package            ->  overlayroot=tmpfs, on the cmdline
  //                                            or in /etc/overlayroot.conf
  //
  // Match both. overlayroot treats an empty value or "disabled" as off, which
  // is how you temporarily switch it off, so the value matters — the mere
  // presence of the key does not mean the overlay is on.
  const OVERLAYROOT_RE = /(?:^|\s)overlayroot=("[^"]*"|'[^']*'|\S*)/g

  function overlayrootOn (raw) {
    const v = String(raw).replace(/^['"]|['"]$/g, '').trim().toLowerCase()
    return !(v === '' || v === 'disabled')
  }

  // true / false / null, where null means "this source says nothing either way"
  // — distinct from false, so a silent cmdline can defer to overlayroot.conf.
  function overlayInCmdline (txt) {
    if (txt == null) return null
    if (/(?:^|\s)boot=overlay(?:\s|$)/.test(txt)) return true
    let last = null
    OVERLAYROOT_RE.lastIndex = 0
    let m
    while ((m = OVERLAYROOT_RE.exec(txt)) !== null) last = m[1]   // last assignment wins
    return last == null ? null : overlayrootOn(last)
  }

  // /etc/overlayroot.conf is shell-ish: overlayroot="tmpfs", with the stock
  // file shipping the examples commented out.
  function overlayInConf (path) {
    const txt = readText(path)
    if (txt == null) return null
    let last = null
    for (const line of txt.split('\n')) {
      const s = line.trim()
      if (!s || s[0] === '#') continue
      const m = /^overlayroot=("[^"]*"|'[^']*'|\S*)/.exec(s)
      if (m) last = m[1]
    }
    return last == null ? null : overlayrootOn(last)
  }

  function overlayInfo () {
    const mounts = readMounts()
    const cmdlineNow = readText('/proc/cmdline')
    if (!mounts && cmdlineNow == null) return null   // not Linux / nothing to report

    const root = mounts ? mounts.find((m) => m.mount === '/') : null

    // Active now: root really is an overlay mount, or the kernel was booted
    // asking for one. Either alone is conclusive; the mount is the stronger
    // signal since it is the actual outcome rather than the request.
    let active = null
    if (root || cmdlineNow != null) active = !!((root && root.type === 'overlay') || overlayInCmdline(cmdlineNow) === true)

    // The boot partition, wherever it is mounted (Bookworm moved it to
    // /boot/firmware). Order matters: prefer the newer location.
    let bootMount = null
    if (mounts) {
      for (const cand of BOOT_MOUNTS) {
        const m = mounts.find((x) => x.mount === cand)
        if (m) { bootMount = { mount: cand, opts: m.opts }; break }
      }
    }

    // Next boot: the persisted cmdline.txt on the boot partition, read from the
    // mount we found and falling back to the two standard locations. A cmdline
    // that mentions no overlay at all is not an answer — the overlayroot
    // package is just as often configured in /etc/overlayroot.conf — so defer
    // to the conf files, which the cmdline overrides when it does speak.
    let activeAtNextBoot = null
    let cmdlineFile = null
    const candidates = bootMount ? [bootMount.mount + '/cmdline.txt'] : []
    for (const cand of BOOT_MOUNTS) if (!candidates.includes(cand + '/cmdline.txt')) candidates.push(cand + '/cmdline.txt')
    for (const path of candidates) {
      const txt = readText(path)
      if (txt != null) { cmdlineFile = txt; activeAtNextBoot = overlayInCmdline(txt); break }
    }
    if (activeAtNextBoot == null) {
      for (const conf of ['/etc/overlayroot.local.conf', '/etc/overlayroot.conf']) {
        const r = overlayInConf(conf)
        if (r != null) { activeAtNextBoot = r; break }
      }
    }
    // Nothing anywhere says overlay, but we could read the cmdline: that is a
    // real "off", not an unknown.
    if (activeAtNextBoot == null && cmdlineFile != null) activeAtNextBoot = false

    // Overlay is only removable by a reboot, so surface the transition state
    // rather than making a consumer diff two booleans.
    let state = null
    if (active != null) {
      if (activeAtNextBoot == null) state = active ? 'active' : 'inactive'
      else if (active && activeAtNextBoot) state = 'active'
      else if (active && !activeAtNextBoot) state = 'pendingDisable'
      else if (!active && activeAtNextBoot) state = 'pendingEnable'
      else state = 'inactive'
    }

    const bootFstab = bootMount ? fstabOpts(bootMount.mount) : null
    const upperOpt = root ? root.opts.find((x) => x.indexOf('upperdir=') === 0) : null
    return {
      active,
      activeAtNextBoot,
      state,
      upperDir: upperOpt ? upperOpt.slice(9) : null,
      bootMount: bootMount ? bootMount.mount : null,
      bootReadOnly: bootMount ? bootMount.opts.includes('ro') : null,
      bootReadOnlyAtNextBoot: bootFstab ? bootFstab.includes('ro') : null
    }
  }

  // How full the overlay's writable upper layer is — on a Pi that layer is a
  // tmpfs, so filling it means running out of RAM and writes start failing
  // while the SD card still looks empty. The upperdir path from /proc/mounts
  // usually lives in the initramfs namespace that switch_root discarded, so it
  // is rarely statfs-able; overlayfs reports the upper layer's statfs through
  // the mount point itself, which is the reliable fallback.
  function upperSpace (info) {
    if (!info || !info.active) return null
    return (info.upperDir ? storageUtil(info.upperDir) : null) || storageUtil('/')
  }

  function decodeThrottle (hex) {
    const v = parseInt(hex, 16)
    if (Number.isNaN(v)) return null
    const bit = (n) => ((v >> n) & 1) === 1
    return {
      underVoltage: bit(0), freqCapped: bit(1), throttled: bit(2), softTempLimit: bit(3),
      underVoltageOccurred: bit(16), throttledOccurred: bit(18), raw: '0x' + v.toString(16)
    }
  }

  async function poll (o) {
    const p = o.prefix
    const values = []
    const push = (path, value) => { if (value !== null && value !== undefined) values.push({ path, value }) }

    const t = readNum('/sys/class/thermal/thermal_zone0/temp', 1000)
    push(p + '.cpu.temperature', t == null ? null : +(t + 273.15).toFixed(2))
    const f = readNum('/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq', 1)
    push(p + '.cpu.frequency', f == null ? null : f * 1000)

    const u = cpuUtil()
    if (u) {
      push(p + '.cpu.utilisation', +u.all.toFixed(3))
      if (o.perCore !== false) u.per.forEach((c, i) => push(p + '.cpu.core.' + (i + 1) + '.utilisation', +c.toFixed(3)))
    }

    const mem = memUtil()
    if (mem) {
      push(p + '.memory.utilisation', +mem.ratio.toFixed(3))
      push(p + '.memory.total', mem.total)
      push(p + '.memory.used', mem.used)
      push(p + '.memory.available', mem.available)
    }

    const st = storageUtil(o.storageMount || '/')
    if (st) {
      push(p + '.storage.utilisation', +st.ratio.toFixed(3))
      push(p + '.storage.capacity', st.capacity)
      push(p + '.storage.used', st.used)
      push(p + '.storage.available', st.available)
    }

    if (o.reportBacklight !== false && bl) {
      const br = readBacklightRatio()
      push(p + '.display.backlight', br == null ? null : +br.toFixed(3))
    }

    let ov = null
    let ovUp = null
    if (o.reportOverlay !== false) {
      ov = overlayInfo()
      if (ov) {
        push(p + '.overlayfs.active', ov.active)
        push(p + '.overlayfs.activeAtNextBoot', ov.activeAtNextBoot)
        push(p + '.overlayfs.state', ov.state)
        push(p + '.bootPartition.mount', ov.bootMount)
        push(p + '.bootPartition.readOnly', ov.bootReadOnly)
        push(p + '.bootPartition.readOnlyAtNextBoot', ov.bootReadOnlyAtNextBoot)
        ovUp = upperSpace(ov)
        if (ovUp) {
          push(p + '.overlayfs.upperSpace.utilisation', +ovUp.ratio.toFixed(3))
          push(p + '.overlayfs.upperSpace.capacity', ovUp.capacity)
          push(p + '.overlayfs.upperSpace.used', ovUp.used)
          push(p + '.overlayfs.upperSpace.available', ovUp.available)
        }
      }
    }

    push(p + '.uptime', Math.round(os.uptime()))
    const la = os.loadavg()
    push(p + '.cpu.load.1m', +la[0].toFixed(2))
    push(p + '.cpu.load.5m', +la[1].toFixed(2))
    push(p + '.cpu.load.15m', +la[2].toFixed(2))

    let thr = null
    if (o.reportThrottle !== false) {
      const volts = await sh('vcgencmd', ['measure_volts', 'core'])
      if (volts) { const m = volts.match(/=([\d.]+)V/); if (m) push(p + '.cpu.coreVoltage', +parseFloat(m[1]).toFixed(3)) }
      const gt = await sh('vcgencmd', ['get_throttled'])
      if (gt) { const m = gt.match(/=0x([0-9a-fA-F]+)/); if (m) thr = decodeThrottle(m[1]) }
      if (thr) {
        push(p + '.throttling.underVoltage', thr.underVoltage)
        push(p + '.throttling.throttled', thr.throttled)
        push(p + '.throttling.freqCapped', thr.freqCapped)
        push(p + '.throttling.softTempLimit', thr.softTempLimit)
        push(p + '.throttling.underVoltageOccurred', thr.underVoltageOccurred)
        push(p + '.throttling.throttledOccurred', thr.throttledOccurred)
      }
    }

    if (values.length) app.handleMessage(plugin.id, { updates: [{ values }] })

    if (thr && o.throttleNotify !== false) {
      const active = thr.underVoltage || thr.throttled
      const key = active ? 'alarm' : 'normal'
      if (lastNotif !== key) {
        lastNotif = key
        const w = []
        if (thr.underVoltage) w.push('under-voltage')
        if (thr.throttled) w.push('throttled')
        app.handleMessage(plugin.id, { updates: [{ values: [{
          path: 'notifications.' + p + '.throttling',
          value: { state: active ? 'alarm' : 'normal', method: active ? ['visual', 'sound'] : [], message: active ? ('Raspberry Pi ' + w.join(' + ')) : 'Raspberry Pi power/thermal normal' }
        }] }] })
      }
    }

    // A full overlay RAM layer breaks writes system-wide while the SD card still
    // looks empty, and nothing else on the box will tell you — hence its own
    // notification rather than leaving it to a zone alarm on .storage.*. Only
    // armed while the overlay is actually active, so a normal Pi never sees it.
    if (o.reportOverlay !== false && o.overlayNotify !== false && ov && ov.active && ovUp) {
      const warnAt = (typeof o.overlayWarn === 'number') ? o.overlayWarn : 0.8
      const alarmAt = (typeof o.overlayAlarm === 'number') ? o.overlayAlarm : 0.95
      let state = 'normal'
      if (ovUp.ratio >= alarmAt) state = 'alarm'
      else if (ovUp.ratio >= warnAt) state = 'warn'
      if (state !== lastOverlayNotif) {
        lastOverlayNotif = state
        const pct = (ovUp.ratio * 100).toFixed(0) + '%'
        app.handleMessage(plugin.id, { updates: [{ values: [{
          path: 'notifications.' + p + '.overlayfs.upperSpace',
          value: {
            state,
            method: state === 'alarm' ? ['visual', 'sound'] : (state === 'warn' ? ['visual'] : []),
            message: state === 'normal'
              ? ('Raspberry Pi overlay RAM layer OK (' + pct + ' full)')
              : ('Raspberry Pi overlay RAM layer ' + pct + ' full, ' + fmtBytes(ovUp.available) + ' free — writes fail when it fills')
          }
        }] }] })
      }
    }

    const parts = []
    if (t != null) parts.push(t.toFixed(0) + 'C')
    if (u) parts.push('cpu ' + (u.all * 100).toFixed(0) + '%')
    if (mem) parts.push('mem ' + (mem.ratio * 100).toFixed(0) + '%')
    if (st) parts.push('disk ' + (st.ratio * 100).toFixed(0) + '%')
    if (thr && (thr.underVoltage || thr.throttled)) parts.push('THROTTLED')
    if (ov) {
      const fill = ovUp ? ' ' + (ovUp.ratio * 100).toFixed(0) + '%' : ''
      if (ov.state === 'pendingDisable') parts.push('overlay' + fill + '(off@boot)')
      else if (ov.state === 'pendingEnable') parts.push('overlay@boot')
      else if (ov.active) parts.push('overlay' + fill)
      if (ov.bootReadOnly) parts.push('boot:ro')
    }
    try { app.setPluginStatus('RPi: ' + parts.join('  ')) } catch (e) {}
  }

  plugin.start = function (options) {
    const o = Object.assign(
      { rate: 10, prefix: 'environment.rpi', perCore: true, storageMount: '/', reportThrottle: true, throttleNotify: true, reportOverlay: true, overlayNotify: true, overlayWarn: 0.8, overlayAlarm: 0.95, reportBacklight: true, backlightDevice: '', minBacklight: 0.05 },
      options || {}
    )
    const p = o.prefix

    bl = (o.reportBacklight !== false) ? resolveBacklight(o.backlightDevice) : null
    app.handleMessage(plugin.id, { updates: [{ meta: [
      { path: p + '.cpu.temperature', value: { units: 'K' } },
      { path: p + '.cpu.utilisation', value: { units: 'ratio' } },
      { path: p + '.cpu.frequency', value: { units: 'Hz' } },
      { path: p + '.cpu.coreVoltage', value: { units: 'V' } },
      { path: p + '.memory.utilisation', value: { units: 'ratio' } },
      { path: p + '.memory.total', value: { units: 'bytes' } },
      { path: p + '.memory.used', value: { units: 'bytes' } },
      { path: p + '.memory.available', value: { units: 'bytes' } },
      { path: p + '.storage.utilisation', value: { units: 'ratio' } },
      { path: p + '.storage.capacity', value: { units: 'bytes' } },
      { path: p + '.storage.used', value: { units: 'bytes' } },
      { path: p + '.storage.available', value: { units: 'bytes' } },
      { path: p + '.uptime', value: { units: 's' } },
      { path: p + '.display.backlight', value: { units: 'ratio' } },
      { path: p + '.overlayfs.upperSpace.utilisation', value: { units: 'ratio' } },
      { path: p + '.overlayfs.upperSpace.capacity', value: { units: 'bytes' } },
      { path: p + '.overlayfs.upperSpace.used', value: { units: 'bytes' } },
      { path: p + '.overlayfs.upperSpace.available', value: { units: 'bytes' } }
    ] }] })

    // Register the PUT handler once per target path so KIP (or any client) can
    // set brightness by writing the ratio path. Guarded so a config reload that
    // keeps the same path does not double-register.
    if (o.reportBacklight !== false && bl) {
      const target = p + '.display.backlight'
      if (putPath !== target) {
        app.registerPutHandler('vessels.self', target, (context, path, value) => {
          const res = writeBacklightRatio(value, o.minBacklight)
          if (res.ok) {
            app.handleMessage(plugin.id, { updates: [{ values: [{ path: target, value: +res.ratio.toFixed(3) }] }] })
            return { state: 'COMPLETED', statusCode: 200 }
          }
          return { state: 'COMPLETED', statusCode: 400, message: res.msg }
        })
        putPath = target
      }
      app.debug && app.debug('backlight device: ' + bl.name + ' (max ' + bl.max + ')')
    }

    lastCpu = null
    lastNotif = null
    lastOverlayNotif = null
    poll(o)
    timer = setInterval(() => poll(o), (o.rate || 10) * 1000)
  }

  plugin.stop = function () { if (timer) { clearInterval(timer); timer = null } }

  return plugin
}
