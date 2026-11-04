package dev.modelpass.sdk

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Log
import dev.modelpass.core.Base64Url
import dev.modelpass.core.ModelPassException
import dev.modelpass.core.ModelPassSession
import java.security.GeneralSecurityException
import java.security.KeyStore
import java.security.UnrecoverableKeyException
import javax.crypto.AEADBadTagException
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/**
 * Default [SessionStore]: the session JSON is encrypted with AES-256-GCM under a non-exportable key
 * held in the Android Keystore, and the ciphertext is kept in private SharedPreferences
 * (`dev.modelpass.sdk.session.xml`). It does not use the deprecated `androidx.security:security-crypto`.
 *
 * If the key is gone (e.g. app data restored from a backup onto another device) the stored session
 * cannot be decrypted; it is discarded and the user simply authorizes again.
 *
 * @param name Lets one app keep several independent sessions.
 */
public class KeystoreSessionStore @JvmOverloads constructor(
    context: Context,
    private val name: String = DEFAULT_NAME,
) : SessionStore {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)
    private val keyAlias = KEY_ALIAS_PREFIX + name
    private val prefKey = "session.$name"
    private val aad = "dev.modelpass.sdk/session/v1/$name".toByteArray(Charsets.UTF_8)

    @Synchronized
    override fun load(): ModelPassSession? {
        val blob = prefs.getString(prefKey, null) ?: return null
        return try {
            ModelPassSession.fromJson(decrypt(blob).toString(Charsets.UTF_8))
        } catch (e: Exception) {
            val permanent = e is AEADBadTagException || e is KeyMissingException || e is UnrecoverableKeyException ||
                e is KeyPermanentlyInvalidatedException || e is IllegalArgumentException || e is ModelPassException
            Log.w(TAG, "Cannot read the stored ModelPass session (${e.javaClass.simpleName})" + if (permanent) "; discarding it" else "")
            if (permanent) prefs.edit().remove(prefKey).apply()
            null
        }
    }

    @Synchronized
    override fun save(session: ModelPassSession) {
        val plaintext = session.toJson().toByteArray(Charsets.UTF_8)
        val blob = try {
            encrypt(plaintext)
        } catch (e: GeneralSecurityException) {
            // Broken or invalidated key: replace it once and retry.
            Log.w(TAG, "Recreating the ModelPass session key (${e.javaClass.simpleName})")
            deleteKey()
            encrypt(plaintext)
        }
        check(prefs.edit().putString(prefKey, blob).commit()) { "Failed to persist the ModelPass session" }
    }

    @Synchronized
    override fun clear() {
        prefs.edit().remove(prefKey).commit()
    }

    private fun encrypt(plaintext: ByteArray): String {
        val cipher = Cipher.getInstance(TRANSFORMATION)
        // The Keystore generates a fresh random 12-byte IV (randomized encryption is required).
        cipher.init(Cipher.ENCRYPT_MODE, existingKey() ?: generateKey())
        cipher.updateAAD(aad)
        val ciphertext = cipher.doFinal(plaintext)
        return FORMAT_PREFIX + Base64Url.encode(cipher.iv) + "." + Base64Url.encode(ciphertext)
    }

    private fun decrypt(blob: String): ByteArray {
        require(blob.startsWith(FORMAT_PREFIX)) { "Unknown session format" }
        val parts = blob.substring(FORMAT_PREFIX.length).split('.')
        require(parts.size == 2) { "Malformed session blob" }
        val key = existingKey() ?: throw KeyMissingException()
        val cipher = Cipher.getInstance(TRANSFORMATION)
        cipher.init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(GCM_TAG_BITS, Base64Url.decode(parts[0])))
        cipher.updateAAD(aad)
        return cipher.doFinal(Base64Url.decode(parts[1]))
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun existingKey(): SecretKey? = keyStore().getKey(keyAlias, null) as? SecretKey

    private fun deleteKey() {
        try {
            keyStore().deleteEntry(keyAlias)
        } catch (e: Exception) {
            Log.w(TAG, "Could not delete the ModelPass session key (${e.javaClass.simpleName})")
        }
    }

    private fun generateKey(): SecretKey {
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        generator.init(
            KeyGenParameterSpec.Builder(keyAlias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
                .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
                .setKeySize(256)
                .setRandomizedEncryptionRequired(true)
                .build(),
        )
        return generator.generateKey()
    }

    private class KeyMissingException : GeneralSecurityException("ModelPass session key not found")

    public companion object {
        public const val DEFAULT_NAME: String = "default"
        private const val TAG = "ModelPass"
        private const val PREFS_FILE = "dev.modelpass.sdk.session"
        private const val KEY_ALIAS_PREFIX = "dev.modelpass.sdk.session."
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val GCM_TAG_BITS = 128
        private const val FORMAT_PREFIX = "v1:"
    }
}
