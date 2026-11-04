// Android library. AGP 9 compiles Kotlin with its built-in Kotlin support, so the
// org.jetbrains.kotlin.android plugin must NOT be applied; Kotlin's jvmTarget follows
// compileOptions.targetCompatibility.
plugins {
    alias(libs.plugins.android.library)
}

android {
    namespace = "dev.modelpass.sdk"
    compileSdk = 36

    defaultConfig {
        minSdk = 24
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    api(project(":modelpass-core"))
    implementation(libs.kotlinx.coroutines.android)
}
