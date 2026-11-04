package dev.modelpass.sdk

import android.app.Activity
import android.app.Application
import android.os.Bundle

/**
 * Detects the user coming back to the activity that opened the wallet (paused, then resumed again),
 * which is how [ModelPass.authorize] notices "returned without approving". Matches by class and task
 * so it keeps working if the activity is recreated (e.g. rotation) while the wallet is open.
 * Callbacks arrive on the main thread.
 */
internal class ReturnWatcher(activity: Activity, private val onReturn: () -> Unit) : Application.ActivityLifecycleCallbacks {
    private val application: Application = activity.application
    private val activityClass: Class<out Activity> = activity.javaClass
    private val taskId: Int = activity.taskId
    private var left = false

    init {
        application.registerActivityLifecycleCallbacks(this)
    }

    fun dispose() {
        application.unregisterActivityLifecycleCallbacks(this)
    }

    private fun isTarget(activity: Activity): Boolean = activity.javaClass == activityClass && activity.taskId == taskId

    override fun onActivityPaused(activity: Activity) {
        if (isTarget(activity)) left = true
    }

    override fun onActivityStopped(activity: Activity) {
        if (isTarget(activity)) left = true
    }

    override fun onActivityResumed(activity: Activity) {
        if (left && isTarget(activity)) {
            left = false
            onReturn()
        }
    }

    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit

    override fun onActivityStarted(activity: Activity) = Unit

    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit

    override fun onActivityDestroyed(activity: Activity) = Unit
}
