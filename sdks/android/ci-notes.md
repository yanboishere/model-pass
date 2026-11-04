# CI notes: `sdks/android`

What CI should run for the Android/Kotlin SDK.

## Environment

- Runner: `ubuntu-latest`. The Android SDK is preinstalled and `ANDROID_HOME` is set. AGP 9.5 downloads a
  missing `platforms;android-36` / build-tools package by itself; the licenses are already accepted on GitHub runners.
- JDK: Temurin 21 (`actions/setup-java`, `distribution: temurin`, `java-version: 21`). AGP 9 needs JDK 17 or newer.
- Gradle: 9.8.2 via `gradle/actions/setup-gradle` with `gradle-version: 9.8.2`. This action also caches dependencies.
  Alternatively run `sdks/android/gradlew`: the wrapper is pinned to 9.8.2 with a distribution SHA-256, and its jar
  matches Gradle's published wrapper checksum.
- Checkout: the full repository is needed, because the core tests read `docs/test-vectors.json` (via `../../../docs`).

## Command

From the repository root:

```bash
gradle -p sdks/android -Pmodelpass.android=true :modelpass-core:test :modelpass-android:assembleRelease
```

- `-Pmodelpass.android=true` makes the build fail if no Android SDK is found. Without it, `settings.gradle.kts`
  skips `:modelpass-android` on machines that have no SDK.
- `:modelpass-core:test` runs the JUnit 6 suite (53 tests at the time of writing). Some of them start a local HTTP server on `127.0.0.1` (JDK
  `com.sun.net.httpserver`). Apart from the Maven Central and Google Maven repositories, no network access is needed.
- Outputs:
  - Test reports: `sdks/android/modelpass-core/build/reports/tests/test/`
  - JUnit XML: `sdks/android/modelpass-core/build/test-results/test/`
  - AAR: `sdks/android/modelpass-android/build/outputs/aar/modelpass-android-release.aar`

Suggested path filter: `sdks/android/**`, `docs/test-vectors.json`.

## Example job

Action versions are the latest majors as of 2026-11:

```yaml
android-sdk:
  runs-on: ubuntu-latest
  steps:
    - uses: actions/checkout@v7
    - uses: actions/setup-java@v6
      with:
        distribution: temurin
        java-version: '21'
    - uses: gradle/actions/setup-gradle@v6
      with:
        gradle-version: '9.8.2'
    - run: gradle -p sdks/android -Pmodelpass.android=true :modelpass-core:test :modelpass-android:assembleRelease
    - if: failure()
      uses: actions/upload-artifact@v7
      with:
        name: android-sdk-test-reports
        path: sdks/android/modelpass-core/build/reports/tests/test/
```

## Local verification without an Android SDK

`gradle -p sdks/android :modelpass-core:test` works with only a JDK 17+. The Android module is skipped and the build
log says so.
