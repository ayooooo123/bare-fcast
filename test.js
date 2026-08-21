/**
 * Wire-format tests for bare-fcast.
 *
 * These cover the three codecs — FCast framing, Chromecast CASTV2 protobuf, and
 * mDNS/DNS name encoding — and nothing else. No sockets, no receiver, no radio:
 * every test here runs offline and deterministically, because the codecs are the
 * part that has to be right byte-for-byte and the part a remote peer controls.
 *
 * Run: bare test.js
 */

import Buffer from 'bare-buffer'

import {
  Opcode,
  MAX_FRAME_BYTES,
  encodeFrame,
  decodeFrames
} from './lib/fcast.js'

import {
  Namespace,
  MAX_BUFFER_SIZE,
  encodeVarint,
  decodeVarint,
  encodeCastBody,
  decodeCastBody,
  encodeCastMessage,
  decodeCastMessage
} from './lib/chromecast.js'

import {
  ServiceType,
  encodeName,
  decodeName,
  buildQuery,
  parseResponse
} from './lib/discovery.js'

let passed = 0
let failed = 0

function test (name, fn) {
  try {
    fn()
    passed++
    console.log(`ok   ${name}`)
  } catch (err) {
    failed++
    console.log(`FAIL ${name}`)
    console.log(`     ${err.message}`)
  }
}

function assert (cond, message) {
  if (!cond) throw new Error(message || 'assertion failed')
}

function equal (actual, expected, message) {
  if (actual !== expected) {
    throw new Error(message || `expected ${expected}, got ${actual}`)
  }
}

function throws (fn, message) {
  try {
    fn()
  } catch {
    return
  }
  throw new Error(message || 'expected a throw')
}

// ---------------------------------------------------------------------------
// FCast framing: [size:uint32_le][opcode:uint8][body:json]
// ---------------------------------------------------------------------------

test('fcast frame layout puts size, then opcode, then body', () => {
  const frame = encodeFrame(Opcode.SEEK, { time: 42 })
  const body = JSON.stringify({ time: 42 })

  equal(frame.readUInt32LE(0), 1 + Buffer.byteLength(body), 'size covers opcode + body, not itself')
  equal(frame.readUInt8(4), Opcode.SEEK, 'opcode sits at offset 4')
  equal(frame.slice(5).toString('utf8'), body, 'body is the JSON tail')
})

test('fcast frame round-trips through the decoder', () => {
  const seen = []
  const rest = decodeFrames(encodeFrame(Opcode.PLAY, { url: 'x' }), (opcode, body) => {
    seen.push([opcode, body])
  })

  equal(seen.length, 1)
  equal(seen[0][0], Opcode.PLAY)
  equal(seen[0][1].url, 'x')
  equal(rest.length, 0, 'a whole frame leaves no remainder')
})

test('decoder drains several frames from one buffer', () => {
  const buffer = Buffer.concat([
    encodeFrame(Opcode.PAUSE, {}),
    encodeFrame(Opcode.RESUME, {}),
    encodeFrame(Opcode.STOP, {})
  ])

  const opcodes = []
  const rest = decodeFrames(buffer, (opcode) => opcodes.push(opcode))

  equal(opcodes.join(','), [Opcode.PAUSE, Opcode.RESUME, Opcode.STOP].join(','))
  equal(rest.length, 0)
})

test('a frame split across two reads is buffered, not misparsed', () => {
  const whole = encodeFrame(Opcode.SET_VOLUME, { volume: 0.5 })
  const head = whole.slice(0, 6)
  const tail = whole.slice(6)

  let calls = 0
  const rest = decodeFrames(head, () => calls++)
  equal(calls, 0, 'a partial frame must not fire')
  equal(rest.length, head.length, 'a partial frame is retained whole')

  const seen = []
  const after = decodeFrames(Buffer.concat([rest, tail]), (opcode, body) => seen.push(body))
  equal(seen.length, 1)
  equal(seen[0].volume, 0.5)
  equal(after.length, 0)
})

test('a trailing partial frame survives to the next read', () => {
  const buffer = Buffer.concat([
    encodeFrame(Opcode.PAUSE, {}),
    encodeFrame(Opcode.SEEK, { time: 1 }).slice(0, 3)
  ])

  const seen = []
  const rest = decodeFrames(buffer, (opcode) => seen.push(opcode))

  equal(seen.length, 1, 'only the complete frame fires')
  equal(rest.length, 3, 'the partial tail is kept')
})

test('an oversized declared length is rejected before it is buffered', () => {
  const hostile = Buffer.alloc(8)
  hostile.writeUInt32LE(0xffffffff, 0)

  throws(() => decodeFrames(hostile, () => {}), 'a 4 GiB frame must be refused')
})

test('a declared length just past the cap is rejected', () => {
  const hostile = Buffer.alloc(8)
  hostile.writeUInt32LE(MAX_FRAME_BYTES + 1, 0)

  throws(() => decodeFrames(hostile, () => {}))
})

test('a zero-length frame is rejected rather than looping forever', () => {
  const hostile = Buffer.alloc(8)
  hostile.writeUInt32LE(0, 0)

  throws(() => decodeFrames(hostile, () => {}), 'size 0 would advance nothing')
})

test('a body that is not JSON yields an empty object, not a throw', () => {
  const junk = Buffer.from('not json', 'utf8')
  const frame = Buffer.alloc(5 + junk.length)
  frame.writeUInt32LE(1 + junk.length, 0)
  frame.writeUInt8(Opcode.PLAYBACK_UPDATE, 4)
  junk.copy(frame, 5)

  const seen = []
  decodeFrames(frame, (opcode, body) => seen.push(body))

  equal(seen.length, 1)
  equal(Object.keys(seen[0]).length, 0)
})

// ---------------------------------------------------------------------------
// Chromecast CASTV2: protobuf wire format
// ---------------------------------------------------------------------------

test('varints encode to the documented byte lengths', () => {
  equal(encodeVarint(0).length, 1)
  equal(encodeVarint(127).length, 1, '127 is the largest single-byte varint')
  equal(encodeVarint(128).length, 2, '128 needs a continuation byte')
  equal(encodeVarint(16383).length, 2)
  equal(encodeVarint(16384).length, 3)
})

test('varint 300 matches the protobuf spec example', () => {
  const bytes = encodeVarint(300)
  equal(bytes[0], 0xac)
  equal(bytes[1], 0x02)
})

test('varints round-trip and report how many bytes they consumed', () => {
  for (const value of [0, 1, 127, 128, 300, 16384, 1 << 20, 0x7fffffff]) {
    const encoded = encodeVarint(value)
    const { value: decoded, bytes } = decodeVarint(encoded, 0)

    equal(decoded, value, `round-trip ${value}`)
    equal(bytes, encoded.length, `byte count for ${value}`)
  }
})

test('varint decoding respects a starting offset', () => {
  const buffer = Buffer.concat([Buffer.from([0xff, 0xff]), encodeVarint(300)])
  const { value, bytes } = decodeVarint(buffer, 2)

  equal(value, 300)
  equal(bytes, 2, '300 is a two-byte varint')
})

test('encodeCastMessage and decodeCastMessage are inverses', () => {
  // Regression: encode framed the message with a 32-bit length prefix while
  // decode expected an unframed body. It happened to work for bodies under 128
  // bytes, where the stray prefix parsed as a discardable field, and desynced
  // on anything larger.
  const decoded = decodeCastMessage(encodeCastMessage({
    sourceId: 'sender-0',
    destinationId: 'transport-1',
    namespace: Namespace.MEDIA,
    payloadUtf8: JSON.stringify({ type: 'LOAD', pad: 'x'.repeat(400) })
  }))

  equal(decoded.namespace, Namespace.MEDIA, 'namespace survives a >128 byte body')
  equal(decoded.sourceId, 'sender-0')
  equal(JSON.parse(decoded.payloadUtf8).type, 'LOAD')
})

test('encodeCastBody and decodeCastBody are inverses', () => {
  const decoded = decodeCastBody(encodeCastBody({
    sourceId: 'sender-0',
    destinationId: 'receiver-0',
    namespace: Namespace.RECEIVER,
    payloadUtf8: JSON.stringify({ type: 'GET_STATUS', pad: 'y'.repeat(500) })
  }))

  equal(decoded.namespace, Namespace.RECEIVER)
  equal(JSON.parse(decoded.payloadUtf8).type, 'GET_STATUS')
})

test('decodeCastMessage returns null on an incomplete frame', () => {
  const whole = encodeCastMessage({
    sourceId: 'a',
    destinationId: 'b',
    namespace: Namespace.CONNECTION,
    payloadUtf8: '{}'
  })

  equal(decodeCastMessage(whole.slice(0, 3)), null, 'less than a header')
  equal(decodeCastMessage(whole.slice(0, whole.length - 1)), null, 'body short by one')
  assert(decodeCastMessage(whole) !== null, 'the whole frame decodes')
})

test('decodeCastMessage rejects a declared length past the cap', () => {
  const hostile = Buffer.alloc(8)
  hostile.writeUInt32BE(0xffffffff, 0)
  throws(() => decodeCastMessage(hostile), 'a 4 GiB frame must be refused')

  const justOver = Buffer.alloc(8)
  justOver.writeUInt32BE(MAX_BUFFER_SIZE + 1, 0)
  throws(() => decodeCastMessage(justOver), 'one byte past the cap is still refused')

  const atCap = Buffer.alloc(8)
  atCap.writeUInt32BE(MAX_BUFFER_SIZE, 0)
  equal(decodeCastMessage(atCap), null, 'at the cap it waits for more data rather than throwing')
})

test('a CastMessage round-trips every routing field', () => {
  const encoded = encodeCastMessage({
    sourceId: 'sender-0',
    destinationId: 'receiver-0',
    namespace: Namespace.HEARTBEAT,
    payloadUtf8: JSON.stringify({ type: 'PING' })
  })

  const decoded = decodeCastMessage(encoded)

  equal(decoded.sourceId, 'sender-0')
  equal(decoded.destinationId, 'receiver-0')
  equal(decoded.namespace, Namespace.HEARTBEAT)
  equal(JSON.parse(decoded.payloadUtf8).type, 'PING')
})

test('a CastMessage carrying a media payload survives the round trip', () => {
  const payload = JSON.stringify({
    type: 'LOAD',
    media: { contentId: 'http://example.test/a.mp4', contentType: 'video/mp4' }
  })

  const decoded = decodeCastMessage(encodeCastMessage({
    sourceId: 'sender-0',
    destinationId: 'transport-1',
    namespace: Namespace.MEDIA,
    payloadUtf8: payload
  }))

  equal(decoded.namespace, Namespace.MEDIA)
  equal(JSON.parse(decoded.payloadUtf8).media.contentType, 'video/mp4')
})

test('cast namespaces are the urn strings the receiver expects', () => {
  assert(Namespace.CONNECTION.startsWith('urn:x-cast:'), 'connection namespace')
  assert(Namespace.HEARTBEAT.startsWith('urn:x-cast:'), 'heartbeat namespace')
  assert(Namespace.RECEIVER.startsWith('urn:x-cast:'), 'receiver namespace')
  assert(Namespace.MEDIA.startsWith('urn:x-cast:'), 'media namespace')
})

// ---------------------------------------------------------------------------
// mDNS / DNS name encoding
// ---------------------------------------------------------------------------

test('a DNS name encodes as length-prefixed labels ending in a null', () => {
  const encoded = encodeName('_fcast._tcp.local.')

  equal(encoded[0], 6, 'first label "_fcast" is 6 bytes')
  equal(encoded.slice(1, 7).toString('utf8'), '_fcast')
  equal(encoded[encoded.length - 1], 0, 'names terminate with a null label')
})

test('the trailing dot is optional and does not change the bytes', () => {
  equal(
    encodeName('_fcast._tcp.local.').toString('hex'),
    encodeName('_fcast._tcp.local').toString('hex')
  )
})

test('a DNS name round-trips', () => {
  const encoded = encodeName(ServiceType.FCAST)
  const { name, offset } = decodeName(encoded, 0, encoded)

  equal(name.replace(/\.$/, ''), ServiceType.FCAST.replace(/\.$/, ''))
  equal(offset, encoded.length, 'offset lands past the null label')
})

test('decodeName follows a compression pointer', () => {
  // A real mDNS response rarely repeats a name. It writes it once and then
  // points at it with a two-byte 0xc0 pointer, so the decoder has to chase the
  // offset back into the message. This is the case that breaks naive parsers.
  const target = encodeName('_googlecast._tcp.local')
  const message = Buffer.concat([
    Buffer.from([0x00, 0x00]),        // two bytes of padding, so the target is at offset 2
    target,
    Buffer.from([0xc0, 0x02])        // pointer to offset 2
  ])

  const pointerAt = 2 + target.length
  const { name, offset } = decodeName(message, pointerAt, message)

  equal(name.replace(/\.$/, ''), '_googlecast._tcp.local')
  equal(offset, pointerAt + 2, 'a pointer consumes exactly two bytes')
})

test('a query is a well-formed PTR question with the unicast bit set', () => {
  const query = buildQuery(ServiceType.FCAST, true)

  equal(query.readUInt16BE(2), 0, 'flags are zero for a query')
  equal(query.readUInt16BE(4), 1, 'exactly one question')
  equal(query.readUInt16BE(6), 0, 'no answers in a query')

  const qtypeAt = query.length - 4
  equal(query.readUInt16BE(qtypeAt), 12, 'QTYPE is PTR (12)')
  equal(query.readUInt16BE(qtypeAt + 2) & 0x8000, 0x8000, 'QU unicast-response bit is set')
})

test('the unicast bit can be cleared for a multicast response', () => {
  const query = buildQuery(ServiceType.FCAST, false)
  const qclassAt = query.length - 2

  equal(query.readUInt16BE(qclassAt) & 0x8000, 0, 'QU bit clear')
  equal(query.readUInt16BE(qclassAt) & 0x7fff, 1, 'class is IN (1)')
})

test('parseResponse rejects a truncated packet instead of throwing', () => {
  const result = parseResponse(Buffer.alloc(2))
  assert(result === null || Array.isArray(result) || typeof result === 'object', 'returns, does not throw')
})

test('service types are the registered dns-sd names', () => {
  equal(ServiceType.FCAST.replace(/\.$/, ''), '_fcast._tcp.local')
  equal(ServiceType.CHROMECAST.replace(/\.$/, ''), '_googlecast._tcp.local')
})

// ---------------------------------------------------------------------------

console.log(`\n${passed} passed, ${failed} failed`)
if (failed > 0) throw new Error(`${failed} test(s) failed`)
