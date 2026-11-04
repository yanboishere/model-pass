pluginManagement {
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
        gradlePluginPortal()
    }
}

dependencyResolutionManagement {
    repositoriesMode.set(RepositoriesMode.FAIL_ON_PROJECT_REPOS)
    repositories {
        google {
            content {
                includeGroupByRegex("com\\.android.*")
                includeGroupByRegex("com\\.google.*")
                includeGroupByRegex("androidx.*")
            }
        }
        mavenCentral()
    }
}

rootProject.name = "modelpass-android-sdk"

// Pure Kotlin/JVM: protocol, crypto, HTTP client. Builds and tests without an Android SDK.
include(":modelpass-core")

// The Android library needs an Android SDK (ANDROID_HOME / ANDROID_SDK_ROOT or sdk.dir in
// local.properties). On machines without one, only :modelpass-core is configured so that
// `gradle :modelpass-core:test` still works. `-Pmodelpass.android=true|false` forces the choice
// (CI passes `true` so a missing SDK fails loudly instead of silently skipping the module).
fun localSdkDir(): String? {
    val file = settingsDir.resolve("local.properties")
    if (!file.isFile) return null
    val props = java.util.Properties()
    file.inputStream().use { props.load(it) }
    return props.getProperty("sdk.dir")
}

val androidOverride = providers.gradleProperty("modelpass.android").orNull?.toBooleanStrictOrNull()
val androidSdkFound = listOfNotNull(
    providers.environmentVariable("ANDROID_HOME").orNull,
    providers.environmentVariable("ANDROID_SDK_ROOT").orNull,
    localSdkDir(),
).any { File(it).isDirectory }

// When this build is consumed as an included (composite) build, always include the Android module.
if (androidOverride ?: (androidSdkFound || gradle.parent != null)) {
    include(":modelpass-android")
} else {
    logger.lifecycle("ModelPass: no Android SDK found, skipping :modelpass-android (set ANDROID_HOME or sdk.dir).")
}
