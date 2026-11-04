package dev.modelpass.sdk

import android.app.Activity
import android.os.Bundle

/**
 * Invisible activity that receives the wallet's redirect (`{redirect_uri}?code=…&state=…&iss=…`),
 * hands it to the SDK and finishes immediately (like AppAuth's `RedirectUriReceiverActivity`).
 *
 * It is declared in the library manifest with an intent filter for the scheme given by the
 * `modelpassRedirectScheme` manifest placeholder, which the host app must define:
 *
 * ```kotlin
 * android { defaultConfig { manifestPlaceholders["modelpassRedirectScheme"] = "com.example.chat" } }
 * ```
 *
 * To receive an https App Link instead, add your own `<intent-filter android:autoVerify="true">`
 * for this activity in the app manifest.
 */
public class ModelPassRedirectActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val uri = intent?.data
        if (savedInstanceState == null && uri != null) {
            ModelPass.dispatchRedirect(applicationContext, uri)
        }
        // Started as the root of a new task (the app's task no longer existed): bring the app up so
        // the user does not land on the home screen.
        if (isTaskRoot) {
            packageManager.getLaunchIntentForPackage(packageName)?.let { launch ->
                try {
                    startActivity(launch)
                } catch (e: RuntimeException) {
                    // Nothing sensible to do; the session is still delivered through ModelPass.session.
                }
            }
        }
        finish()
    }
}
