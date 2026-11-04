import org.jetbrains.kotlin.gradle.dsl.JvmTarget

// Pure Kotlin/JVM module (no Android APIs) so the protocol, crypto and HTTP layers can be
// unit-tested on any JVM. Everything here also runs on Android API 24+.
plugins {
    `java-library`
    alias(libs.plugins.kotlin.jvm)
    alias(libs.plugins.kotlin.serialization)
}

java {
    sourceCompatibility = JavaVersion.VERSION_17
    targetCompatibility = JavaVersion.VERSION_17
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    api(libs.kotlinx.coroutines.core)
    api(libs.kotlinx.serialization.json)

    testImplementation(platform(libs.junit.bom))
    testImplementation(libs.junit.jupiter)
    testImplementation(libs.kotlin.test)
    testImplementation(libs.kotlinx.coroutines.test)
    testRuntimeOnly(libs.junit.platform.launcher)
}

tasks.test {
    useJUnitPlatform()
    // Cross-language test vectors shared with the TypeScript reference implementation.
    val vectors = layout.projectDirectory.file("../../../docs/test-vectors.json").asFile
    if (vectors.isFile) inputs.file(vectors).withPropertyName("testVectors").withPathSensitivity(PathSensitivity.NONE)
    systemProperty("modelpass.testVectors", vectors.absolutePath)
}
