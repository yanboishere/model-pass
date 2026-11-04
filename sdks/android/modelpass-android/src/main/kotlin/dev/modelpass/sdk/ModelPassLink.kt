package dev.modelpass.sdk

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import dev.modelpass.core.ModelPassSession
import dev.modelpass.core.PendingLink

/**
 * A started cross-device link (protocol §7), returned by [ModelPass.startLink].
 *
 * Render [qrUrl] as a QR code (e.g. with ZXing) next to [userCode]; the user scans it with the
 * ModelPass wallet on their phone. The QR code is a one-time credential: hide it once
 * [awaitSession] returns or fails, or when [expiresAt] passes.
 */
public class ModelPassLink internal constructor(
    private val pending: PendingLink,
    private val onSession: suspend (ModelPassSession) -> Unit,
) {
    /** Code to show next to the QR code so the user can compare it in the wallet, e.g. `BCDF-GHJK`. */
    public val userCode: String get() = pending.userCode

    /** QR code content: `{verification_uri}#v=1&uc=…&s=…`. */
    public val qrUrl: String get() = pending.qrUrl

    public val verificationUri: String get() = pending.verificationUri

    /** `modelpass://link?…`: opens the wallet directly if it is installed on this device. */
    public val walletUri: Uri get() = Uri.parse(pending.walletUrl)

    /** Unix epoch seconds after which the code is no longer valid. */
    public val expiresAt: Long get() = pending.expiresAt

    public val isCancelled: Boolean get() = pending.isCancelled

    /**
     * Polls until the user approves in the wallet, then stores the session (also published on
     * [ModelPass.session]) and returns it.
     *
     * @throws dev.modelpass.core.ModelPassException.LinkDenied the user declined.
     * @throws dev.modelpass.core.ModelPassException.LinkExpired the code expired.
     * @throws dev.modelpass.core.ModelPassException.Cancelled [cancel] was called.
     */
    public suspend fun awaitSession(): ModelPassSession {
        val session = pending.awaitSession()
        onSession(session)
        return session
    }

    /** Stops polling (e.g. when the QR dialog is closed). */
    public fun cancel() {
        pending.cancel()
    }

    /** Hands the link to a wallet installed on this device. Returns false if none is installed. */
    public fun openInWallet(activity: Activity): Boolean = try {
        activity.startActivity(Intent(Intent.ACTION_VIEW, walletUri))
        true
    } catch (e: ActivityNotFoundException) {
        false
    }
}
