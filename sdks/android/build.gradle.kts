// Plugins are declared once here (apply false) so that AGP's built-in Kotlin support and the
// Kotlin/JVM plugin share one Kotlin Gradle Plugin version and class loader.
plugins {
    alias(libs.plugins.android.library) apply false
    alias(libs.plugins.kotlin.jvm) apply false
    alias(libs.plugins.kotlin.serialization) apply false
}
