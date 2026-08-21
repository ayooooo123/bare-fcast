# bare-fcast

Cast video to FCast receivers and Chromecast devices from the [Bare](https://github.com/holepunchto/bare)
and Pear runtimes.

No SDK underneath. All three protocols are implemented directly from their wire specifications, because
Bare has no Node ecosystem to borrow a cast library from:

- **FCast v3** over TCP — `[size:uint32_le][opcode:uint8][body:json]`
- **Chromecast CASTV2** over TLS — protobuf `CastMessage` framing, with the protobuf encoder written here
- **mDNS / DNS-SD** over UDP multicast — DNS name encoding and response parsing, including compression pointers

Not on npm. Install from the repository:

```
npm install github:ayooooo123/bare-fcast
```

Requires Bare >= 2.0.0.

## Quick start

```js
import CastContext from 'bare-fcast'

const cast = new CastContext()

cast.on('deviceFound', (device) => {
  console.log(device.protocol, device.name, device.host)
})

await cast.startDiscovery()

const device = await cast.connect(someDevice)

await device.play({
  url: 'http://192.168.1.10:8080/video.mp4',
  contentType: 'video/mp4'
})

device.on('playbackStateChanged', (state) => console.log(state))
device.on('progress', ({ time, duration }) => console.log(time, '/', duration))
```

`CastContext` hides the protocol difference. If you want one directly:

```js
import { FCastDevice, ChromecastDevice, DeviceDiscoverer } from 'bare-fcast'
```

## Discovery

`DeviceDiscoverer` sends mDNS PTR queries to `224.0.0.251:5353` for
`_fcast._tcp.local` and `_googlecast._tcp.local`, with the QU unicast-response bit set, and parses
answers and additional records to recover name, address and port.

```js
const discoverer = new DeviceDiscoverer()

discoverer.on('deviceFound', (device) => { /* ... */ })
discoverer.on('deviceLost', (device) => { /* ... */ })

await discoverer.start()
```

DNS names in a response are usually written once and then referenced by a two-byte compression
pointer. `decodeName` follows those pointers, which is the case naive parsers get wrong.

## Protocol details

### FCast

TCP port 46899. Every frame is a little-endian 32-bit length, then a one-byte opcode, then a JSON body.
The length covers the opcode and the body, not itself.

```js
import { encodeFrame, decodeFrames, Opcode, MAX_FRAME_BYTES } from 'bare-fcast/lib/fcast.js'

const frame = encodeFrame(Opcode.SEEK, { time: 42 })
const rest = decodeFrames(buffer, (opcode, body) => { /* ... */ })
```

`decodeFrames` returns the unconsumed remainder, so a frame split across two reads is buffered rather
than misparsed. The declared length is a peer-controlled 32-bit number, so it is checked against
`MAX_FRAME_BYTES` (1 MiB) **before** anything is read or retained — otherwise a receiver announcing
4 GiB makes the sender buffer until it dies. An out-of-range length throws; the caller drops the
connection.

### Chromecast

TLS port 8009, `CastMessage` protobuf across four namespaces: connection, heartbeat, receiver and
media. The wire format is a 32-bit big-endian body length followed by the protobuf body.

```js
import {
  encodeCastMessage, decodeCastMessage,   // length-prefixed frame
  encodeCastBody, decodeCastBody,         // bare protobuf body
  encodeVarint, decodeVarint
} from 'bare-fcast/lib/chromecast.js'
```

The two pairs are separate on purpose: a socket read loop that already stripped the 4-byte header wants
`decodeCastBody`, and everything else wants `decodeCastMessage`. Mixing them is silently wrong for
bodies under 128 bytes and visibly wrong above, which is a bug this library shipped once already.

`decodeCastMessage` returns `null` when the buffer does not yet hold a complete frame, and throws when
the declared length exceeds `MAX_BUFFER_SIZE`.

Chromecast connections pass `rejectUnauthorized: false` explicitly, because receivers present a
self-signed certificate and `bare-tls` 3.x verifies against a CA bundle by default. This is a
deliberate opt-out, not an oversight: with it, the handshake completes; without it you get
`CERTIFICATE_VERIFY_FAILED`. It also means the cast target is authenticated by nothing. Discovery is
unauthenticated mDNS on the local network either way — treat a receiver as untrusted and do not send
it a URL you would not put in a log.

## Tests

```
npm test
```

28 tests over the three codecs. No sockets, no receiver, no network: the codecs are the part a remote
peer controls, so they are tested offline and deterministically — round trips, frames split across
reads, non-JSON bodies, compression pointers, and oversized declared lengths.

## Notes

- Requires `bare-tls` >= 3.1.8. 2.x did not implement peer verification at all (its `binding.init`
  took no `rejectUnauthorized` argument and the native layer never called `SSL_set_verify`), so on 2.x
  nothing was ever checked. 3.x added verification and defaults it on, which is why the opt-out above
  is now written down instead of implied.
- Extracted from [PearTube](https://github.com/ayooooo123/peartube), where it drives casting from a
  peer-to-peer video app.

## License

Apache-2.0
