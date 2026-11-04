// @modelpass/core uses crypto.getRandomValues; Hermes doesn't ship it, expo-crypto does.
import * as Crypto from 'expo-crypto'

const g = globalThis as unknown as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }
if (!g.crypto) g.crypto = {}
if (!g.crypto.getRandomValues) {
  g.crypto.getRandomValues = (array: Uint8Array) => Crypto.getRandomValues(array)
}
