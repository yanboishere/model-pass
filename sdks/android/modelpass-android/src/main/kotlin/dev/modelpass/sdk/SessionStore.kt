package dev.modelpass.sdk

import dev.modelpass.core.ModelPassSession

/**
 * Persists the [ModelPassSession]. Implementations must keep the access token confidential
 * (protocol §13.5); the default is [KeystoreSessionStore]. Calls may happen on any thread.
 */
public interface SessionStore {
    /** Returns the stored session, or null. Must not throw for unreadable data; return null instead. */
    public fun load(): ModelPassSession?

    public fun save(session: ModelPassSession)

    public fun clear()
}

/** Keeps the session in memory only (tests, or apps that re-authorize on every launch). */
public class InMemorySessionStore @JvmOverloads constructor(initial: ModelPassSession? = null) : SessionStore {
    @Volatile
    private var session: ModelPassSession? = initial

    override fun load(): ModelPassSession? = session

    override fun save(session: ModelPassSession) {
        this.session = session
    }

    override fun clear() {
        session = null
    }
}
