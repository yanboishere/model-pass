import * as LocalAuthentication from 'expo-local-authentication'

/** Face ID / fingerprint confirmation. Devices without biometrics (e.g. simulators) are not blocked. */
export async function confirmWithBiometrics(reason: string): Promise<boolean> {
  try {
    const [hasHardware, enrolled] = await Promise.all([LocalAuthentication.hasHardwareAsync(), LocalAuthentication.isEnrolledAsync()])
    if (!hasHardware || !enrolled) return true
    const r = await LocalAuthentication.authenticateAsync({ promptMessage: reason, cancelLabel: '取消', fallbackLabel: '使用密码' })
    return r.success
  } catch {
    return true
  }
}
