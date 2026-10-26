'use strict'

const { test, beforeEach, afterEach } = require('node:test')
const assert = require('node:assert/strict')
const childProcess = require('child_process')

// index.js takes execFile from child_process when it is loaded, so the stub
// has to be in place first. It answers the two vcgencmd calls the plugin makes.
const vcgencmd = { missing: false, volts: 'volt=0.8563V', throttled: 'throttled=0x0' }
childProcess.execFile = (cmd, args, opts, cb) => {
  if (cmd !== 'vcgencmd') return cb(new Error('unexpected command ' + cmd))
  if (vcgencmd.missing) return cb(Object.assign(new Error('spawn vcgencmd ENOENT'), { code: 'ENOENT' }))
  if (args[0] === 'measure_volts') return cb(null, vcgencmd.volts + '\n')
  if (args[0] === 'get_throttled') return cb(null, vcgencmd.throttled + '\n')
  cb(new Error('unexpected vcgencmd ' + args.join(' ')))
}

const createPlugin = require('../index.js')

function fakeApp () {
  const deltas = []
  const waiters = []
  return {
    deltas,
    status: null,
    putHandlers: [],
    handleMessage (id, delta) {
      deltas.push({ id, delta })
      waiters.splice(0).forEach((w) => w())
    },
    setPluginStatus (s) { this.status = s },
    registerPutHandler (context, path, handler) { this.putHandlers.push({ context, path, handler }) },
    debug () {},
    // Resolves once a delta carrying values has arrived (the first poll).
    nextValues () {
      return new Promise((resolve) => {
        const check = () => {
          if (deltas.some((d) => d.delta.updates[0].values)) resolve()
          else waiters.push(check)
        }
        check()
      })
    }
  }
}

function values (app) {
  const out = {}
  for (const { delta } of app.deltas) {
    for (const u of delta.updates) for (const v of u.values || []) out[v.path] = v.value
  }
  return out
}

function metaPaths (app) {
  return app.deltas.flatMap(({ delta }) => delta.updates.flatMap((u) => (u.meta || []).map((m) => m.path)))
}

let app
let plugin

beforeEach(() => {
  vcgencmd.missing = false
  vcgencmd.volts = 'volt=0.8563V'
  vcgencmd.throttled = 'throttled=0x0'
  app = fakeApp()
  plugin = createPlugin(app)
})

afterEach(() => plugin.stop())

test('has the id, name and a schema with defaults', () => {
  assert.equal(plugin.id, 'signalk-rpi-stats')
  assert.equal(typeof plugin.name, 'string')
  assert.equal(plugin.schema.type, 'object')
  assert.equal(plugin.schema.properties.rate.default, 10)
  assert.equal(plugin.schema.properties.prefix.default, 'environment.rpi')
})

test('publishes units meta under the configured prefix', () => {
  plugin.start({ prefix: 'environment.pi', rate: 3600 })
  const paths = metaPaths(app)
  assert.ok(paths.includes('environment.pi.cpu.temperature'))
  assert.ok(paths.includes('environment.pi.uptime'))
  assert.ok(paths.every((p) => p.startsWith('environment.pi.')))
})

test('starts without any configuration', async () => {
  plugin.start({})
  await app.nextValues()
  const v = values(app)
  assert.equal(typeof v['environment.rpi.uptime'], 'number')
  assert.equal(typeof v['environment.rpi.cpu.load.1m'], 'number')
  assert.match(app.status, /^RPi:/)
})

test('reports core voltage and decodes the throttling flags', async () => {
  vcgencmd.throttled = 'throttled=0x50005'
  plugin.start({ rate: 3600 })
  await app.nextValues()
  const v = values(app)
  assert.equal(v['environment.rpi.cpu.coreVoltage'], 0.856)
  assert.equal(v['environment.rpi.throttling.underVoltage'], true)
  assert.equal(v['environment.rpi.throttling.freqCapped'], false)
  assert.equal(v['environment.rpi.throttling.throttled'], true)
  assert.equal(v['environment.rpi.throttling.softTempLimit'], false)
  assert.equal(v['environment.rpi.throttling.underVoltageOccurred'], true)
  assert.equal(v['environment.rpi.throttling.throttledOccurred'], true)
})

test('raises an alarm on under-voltage', async () => {
  vcgencmd.throttled = 'throttled=0x1'
  plugin.start({ rate: 3600 })
  await app.nextValues()
  const n = values(app)['notifications.environment.rpi.throttling']
  assert.equal(n.state, 'alarm')
  assert.match(n.message, /under-voltage/)
  assert.match(app.status, /THROTTLED/)
})

test('raises no alarm while power and temperature are normal', async () => {
  plugin.start({ rate: 3600 })
  await app.nextValues()
  assert.equal(values(app)['notifications.environment.rpi.throttling'].state, 'normal')
})

test('skips vcgencmd when throttling reports are off', async () => {
  vcgencmd.throttled = 'throttled=0x50005'
  plugin.start({ rate: 3600, reportThrottle: false })
  await app.nextValues()
  const paths = Object.keys(values(app))
  assert.ok(!paths.some((p) => p.includes('throttling') || p.endsWith('coreVoltage')))
})

test('publishes the other values when vcgencmd is missing', async () => {
  vcgencmd.missing = true
  plugin.start({ rate: 3600 })
  await app.nextValues()
  const v = values(app)
  assert.equal(typeof v['environment.rpi.uptime'], 'number')
  assert.ok(!Object.keys(v).some((p) => p.includes('throttling') || p.endsWith('coreVoltage')))
})
