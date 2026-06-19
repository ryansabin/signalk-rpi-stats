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
 *   .memory.available       bytes
 *   .storage.utilisation    ratio (statfs of the configured mount)
 *   .uptime                 s     (os.uptime)
 *   .throttling.*           bool  (vcgencmd get_throttled bit flags)
 *   notifications.<prefix>.throttling  alarm on under-voltage / throttling
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

  const plugin = {
    id: 'signalk-rpi-stats',
    name: 'Raspberry Pi Stats',
    description: 'Publishes Raspberry Pi system stats (CPU temp/util/freq/voltage, memory, storage, uptime, load, throttling/under-voltage) to Signal K. No sudo, no native dependencies.'
  }

  plugin.schema = {
    type: 'object',
    properties: {
      rate: { type: 'number', title: 'Sample rate (seconds)', default: 20 },
      prefix: { type: 'string', title: 'Base Signal K path', default: 'environment.rpi' },
      perCore: { type: 'boolean', title: 'Report per-core CPU utilisation', default: true },
      storageMount: { type: 'string', title: 'Filesystem to report storage for', default: '/' },
      reportThrottle: { type: 'boolean', title: 'Report throttling / under-voltage (uses vcgencmd)', default: true },
      throttleNotify: { type: 'boolean', title: 'Raise a notification on under-voltage / throttling', default: true }
    }
  }

  function readNum (path, div) {
    try { return parseInt(fs.readFileSync(path, 'utf8').trim(), 10) / (div || 1) } catch (e) { return null }
  }
  function sh (cmd, args) {
    return new Promise((res) => execFile(cmd, args, { timeout: 4000 }, (e, o) => res(e ? null : String(o).trim())))
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
      if (total && avail != null) return { ratio: 1 - avail / total, total, available: avail }
    } catch (e) {}
    return null
  }

  function storageUtil (mount) {
    try {
      const s = fs.statfsSync(mount)
      const total = s.blocks * s.bsize
      const free = s.bavail * s.bsize
      if (total > 0) return { ratio: 1 - free / total, total, free }
    } catch (e) {}
    return null
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
    if (mem) { push(p + '.memory.utilisation', +mem.ratio.toFixed(3)); push(p + '.memory.available', mem.available) }

    const st = storageUtil(o.storageMount || '/')
    if (st) push(p + '.storage.utilisation', +st.ratio.toFixed(3))

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

    const parts = []
    if (t != null) parts.push(t.toFixed(0) + 'C')
    if (u) parts.push('cpu ' + (u.all * 100).toFixed(0) + '%')
    if (mem) parts.push('mem ' + (mem.ratio * 100).toFixed(0) + '%')
    if (st) parts.push('disk ' + (st.ratio * 100).toFixed(0) + '%')
    if (thr && (thr.underVoltage || thr.throttled)) parts.push('THROTTLED')
    try { app.setPluginStatus('RPi: ' + parts.join('  ')) } catch (e) {}
  }

  plugin.start = function (options) {
    const o = Object.assign(
      { rate: 20, prefix: 'environment.rpi', perCore: true, storageMount: '/', reportThrottle: true, throttleNotify: true },
      options || {}
    )
    const p = o.prefix
    app.handleMessage(plugin.id, { updates: [{ meta: [
      { path: p + '.cpu.temperature', value: { units: 'K' } },
      { path: p + '.cpu.utilisation', value: { units: 'ratio' } },
      { path: p + '.cpu.frequency', value: { units: 'Hz' } },
      { path: p + '.cpu.coreVoltage', value: { units: 'V' } },
      { path: p + '.memory.utilisation', value: { units: 'ratio' } },
      { path: p + '.memory.available', value: { units: 'bytes' } },
      { path: p + '.storage.utilisation', value: { units: 'ratio' } },
      { path: p + '.uptime', value: { units: 's' } }
    ] }] })
    lastCpu = null
    lastNotif = null
    poll(o)
    timer = setInterval(() => poll(o), (o.rate || 20) * 1000)
  }

  plugin.stop = function () { if (timer) { clearInterval(timer); timer = null } }

  return plugin
}
