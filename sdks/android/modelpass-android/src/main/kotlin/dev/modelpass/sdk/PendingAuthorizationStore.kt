package dev.modelpass.sdk

import android.content.Context
import android.content.SharedPreferences
import android.net.Uri
import dev.modelpass.core.ModelPassException
import dev.modelpass.core.PendingAuthorization

/**
 * Persists the in-flight authorization (state + PKCE verifier, single use, short-lived) so the flow
 * survives process death while the user is in the wallet, plus a redirect that arrived before any
 * [ModelPass] instance existed in the (restarted) process.
 */
internal class PendingAuthorizationStore(context: Context) {
    private val prefs: SharedPreferences =
        context.applicationContext.getSharedPreferences(PREFS_FILE, Context.MODE_PRIVATE)

    @Synchronized
    fun save(pending: PendingAuthorization) {
        // commit(): the wallet is opened right after this and our process may be killed meanwhile.
        prefs.edit().putString(KEY_PENDING, pending.toJson()).commit()
    }

    @Synchronized
    fun load(): PendingAuthorization? {
        val json = prefs.getString(KEY_PENDING, null) ?: return null
        val pending = try {
            PendingAuthorization.fromJson(json)
        } catch (e: ModelPassException) {
            null
        }
        if (pending == null || pending.isExpired()) {
            clear()
            return null
        }
        return pending
    }

    /** Removes the pending authorization, but only if it is still the one with [state] (when given). */
    @Synchronized
    fun clear(state: String? = null) {
        if (state != null) {
            val current = prefs.getString(KEY_PENDING, null)?.let { runCatching { PendingAuthorization.fromJson(it) }.getOrNull() }
            if (current != null && current.state != state) return
        }
        prefs.edit().remove(KEY_PENDING).commit()
    }

    @Synchronized
    fun stashRedirect(uri: Uri) {
        prefs.edit()
            .putString(KEY_STASHED_URI, uri.toString())
            .putLong(KEY_STASHED_AT, System.currentTimeMillis())
            .commit()
    }

    /** Returns and removes a recently stashed redirect accepted by [matches]. */
    @Synchronized
    fun takeStashedRedirect(matches: (String) -> Boolean): String? {
        val uri = prefs.getString(KEY_STASHED_URI, null) ?: return null
        val age = System.currentTimeMillis() - prefs.getLong(KEY_STASHED_AT, 0L)
        if (age !in 0..STASH_MAX_AGE_MILLIS) {
            prefs.edit().remove(KEY_STASHED_URI).remove(KEY_STASHED_AT).apply()
            return null
        }
        if (!matches(uri)) return null
        prefs.edit().remove(KEY_STASHED_URI).remove(KEY_STASHED_AT).commit()
        return uri
    }

    private companion object {
        const val PREFS_FILE = "dev.modelpass.sdk.pending"
        const val KEY_PENDING = "pending_authorization"
        const val KEY_STASHED_URI = "stashed_redirect"
        const val KEY_STASHED_AT = "stashed_redirect_at"

        /** Authorization codes live 120 s (§6.3). */
        const val STASH_MAX_AGE_MILLIS = 120_000L
    }
}
