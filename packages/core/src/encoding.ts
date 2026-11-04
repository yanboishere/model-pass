// Platform-neutral byte/string helpers. Implemented by hand so the same code runs
// unchanged on Node, browsers and Hermes (React Native), where TextDecoder may be missing.

const B64URL = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_'
const B64_LOOKUP: Record<string, number> = {}
for (let i = 0; i < B64URL.length; i++) B64_LOOKUP[B64URL[i]] = i
// Also accept the standard alphabet when decoding.
B64_LOOKUP['+'] = 62
B64_LOOKUP['/'] = 63

/** RFC 4648 §5 base64url, without padding. */
export function base64urlEncode(bytes: Uint8Array): string {
  let out = ''
  let i = 0
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2]
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63] + B64URL[n & 63]
  }
  const rest = bytes.length - i
  if (rest === 1) {
    const n = bytes[i] << 16
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63]
  } else if (rest === 2) {
    const n = (bytes[i] << 16) | (bytes[i + 1] << 8)
    out += B64URL[(n >> 18) & 63] + B64URL[(n >> 12) & 63] + B64URL[(n >> 6) & 63]
  }
  return out
}

/** Decodes base64url (or standard base64), with or without padding. Throws on invalid input. */
export function base64urlDecode(input: string): Uint8Array {
  const str = input.replace(/=+$/, '')
  if (str.length % 4 === 1) throw new Error('invalid base64url length')
  const out = new Uint8Array(Math.floor((str.length * 3) / 4))
  let o = 0
  let buf = 0
  let bits = 0
  for (let i = 0; i < str.length; i++) {
    const v = B64_LOOKUP[str[i]]
    if (v === undefined) throw new Error('invalid base64url character')
    buf = (buf << 6) | v
    bits += 6
    if (bits >= 8) {
      bits -= 8
      out[o++] = (buf >> bits) & 0xff
    }
  }
  return out.subarray(0, o)
}

export function utf8Encode(str: string): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < str.length; i++) {
    let code = str.charCodeAt(i)
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < str.length) {
      const next = str.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00)
        i++
      }
    }
    if (code < 0x80) out.push(code)
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63))
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
    else
      out.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 63), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63))
  }
  return Uint8Array.from(out)
}

export function utf8Decode(bytes: Uint8Array): string {
  let out = ''
  for (let i = 0; i < bytes.length; ) {
    const b = bytes[i]
    let code: number
    if (b < 0x80) {
      code = b
      i += 1
    } else if (b >= 0xc0 && b < 0xe0) {
      code = ((b & 31) << 6) | (bytes[i + 1] & 63)
      i += 2
    } else if (b >= 0xe0 && b < 0xf0) {
      code = ((b & 15) << 12) | ((bytes[i + 1] & 63) << 6) | (bytes[i + 2] & 63)
      i += 3
    } else {
      code = ((b & 7) << 18) | ((bytes[i + 1] & 63) << 12) | ((bytes[i + 2] & 63) << 6) | (bytes[i + 3] & 63)
      i += 4
    }
    if (code >= 0x10000) {
      code -= 0x10000
      out += String.fromCharCode(0xd800 + (code >> 10), 0xdc00 + (code & 1023))
    } else {
      out += String.fromCharCode(code)
    }
  }
  return out
}

export function concatBytes(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let o = 0
  for (const p of parts) {
    out.set(p, o)
    o += p.length
  }
  return out
}

/** Length-independent comparison for secrets of equal expected length. */
export function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return diff === 0
}
