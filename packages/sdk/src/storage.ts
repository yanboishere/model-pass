/** Minimal async key-value store. Use secure storage (Keychain / Keystore) in production. */
export interface ModelPassStorage {
  getItem(key: string): Promise<string | null>
  setItem(key: string, value: string): Promise<void>
  removeItem(key: string): Promise<void>
}

export class MemoryStorage implements ModelPassStorage {
  private map = new Map<string, string>()
  async getItem(key: string) {
    return this.map.get(key) ?? null
  }
  async setItem(key: string, value: string) {
    this.map.set(key, value)
  }
  async removeItem(key: string) {
    this.map.delete(key)
  }
}
