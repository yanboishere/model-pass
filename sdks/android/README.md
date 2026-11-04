# ModelPass Android SDK

> **English summary.** Kotlin SDK for "Continue with ModelPass" (ModelPass Connect v0.1, see
> [`docs/protocol.md`](../../docs/protocol.md)). `modelpass-core` is a pure Kotlin/JVM library (PKCE,
> link-flow crypto, URL building/redirect validation, an `HttpURLConnection` + coroutines client for
> discovery, token exchange, link polling, grant info, revocation and OpenAI-compatible chat incl. SSE
> streaming). `modelpass-android` (minSdk 24) adds the `ModelPass` client (opens the wallet, survives
> process death), `ModelPassRedirectActivity`, and an Android-Keystore-encrypted session store.
> Add it as a composite build, set the `modelpassRedirectScheme` manifest placeholder, create one
> `ModelPass` in `Application.onCreate()`, call `authorize(activity)`, then use `chat()` /
> `streamChat()` or hand `session.apiBase` + `session.accessToken` to any OpenAI-compatible client.

用户在 ModelPass 钱包里管理自己的模型与 Key；你的应用只拿到一个 OpenAI 兼容的 `api_base` 和一个按应用隔离、可随时撤销的令牌。

| 模块 | 内容 |
| --- | --- |
| `modelpass-core` | 纯 Kotlin/JVM（不依赖 Android API）：`Pkce`、`LinkCrypto`（HMAC / HKDF / AES-GCM）、授权 URL 构建与回调校验（`state`、`iss`）、`ModelPassApi`（`HttpURLConnection` + 协程 + kotlinx-serialization）。可在任意 JVM 上单测，也可用于桌面应用 |
| `modelpass-android` | Android 库（`dev.modelpass.sdk`，minSdk 24）：`ModelPass` 客户端、`ModelPassRedirectActivity`、`KeystoreSessionStore` |

版本：Kotlin 2.4.21 · AGP 9.5.0（内置 Kotlin，无需 `kotlin-android` 插件）· Gradle 9.8.2 · kotlinx-coroutines 1.11.0 · kotlinx-serialization 1.12.0 · JUnit 6.1.3 · compileSdk 36 · minSdk 24 · 字节码 Java 17（构建需要 JDK 17+，CI 用 21）。

## 1. 引入依赖

SDK 尚未发布到 Maven 仓库，推荐以**复合构建**方式引入（Gradle 会按 `group:name` 自动替换为源码模块）：

```kotlin
// 应用的 settings.gradle.kts
includeBuild("../modelpass/sdks/android")

// app/build.gradle.kts
dependencies {
    implementation("dev.modelpass:modelpass-android:0.1.0") // 已包含 modelpass-core
}
```

注意：

- 复合构建中的 Android 模块同样需要找到 Android SDK：设置 `ANDROID_HOME`，或在 `sdks/android/local.properties` 写入 `sdk.dir=…`。
- AGP 不允许同一次构建里出现不同版本的 AGP（报错 `Using different versions of the Android Gradle plugin … is not allowed`），因此主工程需要使用同一个 AGP 版本。主工程使用其它 AGP 9.x 版本时，把 `gradle/libs.versions.toml` 里的 `agp` 改成相同版本即可（SDK 只用到稳定的 DSL，依赖 AGP 9 的内置 Kotlin）。

在本仓库内写 demo 时，也可以把两个模块作为**源码模块**引入，并复用本目录的 version catalog：

```kotlin
// demo/settings.gradle.kts（demo 自己没有 libs.versions.toml 时）
dependencyResolutionManagement {
    versionCatalogs { create("libs") { from(files("../../sdks/android/gradle/libs.versions.toml")) } }
}
include(":modelpass-core", ":modelpass-android")
project(":modelpass-core").projectDir = file("../../sdks/android/modelpass-core")
project(":modelpass-android").projectDir = file("../../sdks/android/modelpass-android")

// demo/build.gradle.kts：与 sdks/android/build.gradle.kts 一样以 apply false 声明三个插件
// app/build.gradle.kts：implementation(project(":modelpass-android"))
```

纯 JVM 项目（桌面端、服务端测试）只需 `dev.modelpass:modelpass-core:0.1.0`。

## 2. Manifest 配置

### 2.1 回调 scheme（必需）

库的 manifest 已经声明了 `ModelPassRedirectActivity`（无界面，收到回调后转交 SDK 并立即关闭），它的 intent-filter 使用占位符 `modelpassRedirectScheme`，由应用提供：

```kotlin
// app/build.gradle.kts
android {
    defaultConfig {
        manifestPlaceholders["modelpassRedirectScheme"] = "com.example.chat"
    }
}
```

对应的 `redirectUri` 为 `com.example.chat:/modelpass/callback`（RFC 8252 私有 scheme，全小写）。该 Activity 会接收这个 scheme 下的**所有** URI，如果应用的其它深链也用同一个 scheme，请为 ModelPass 单独起一个，例如 `com.example.chat.modelpass`。

未设置占位符时应用构建会报错：`Attribute data@scheme at AndroidManifest.xml requires a placeholder substitution but no value for <modelpassRedirectScheme> is provided.`

合并后等价于：

```xml
<activity
    android:name="dev.modelpass.sdk.ModelPassRedirectActivity"
    android:exported="true"
    android:excludeFromRecents="true"
    android:noHistory="true"
    android:theme="@android:style/Theme.Translucent.NoTitleBar">
    <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="com.example.chat" />
    </intent-filter>
</activity>
```

### 2.2 `<queries>`（已自动合并）

Android 11+ 的包可见性要求声明要查询的 scheme，`ModelPass.isWalletInstalled()` 依赖它。库的 manifest 已包含以下内容并会自动合并；若你把 `walletAuthorizeUrl` 换成别的 scheme 或域名，请在应用里补充对应条目：

```xml
<queries>
    <intent>
        <action android:name="android.intent.action.VIEW" />
        <data android:scheme="modelpass" />
    </intent>
</queries>
```

### 2.3 可选：HTTPS App Link 回调

如果 `redirectUri` 使用经过验证的 App Link（更难被其它应用抢注），在应用 manifest 里给同一个 Activity 追加 intent-filter（仍需设置 2.1 的占位符，取值随意但要唯一）：

```xml
<activity android:name="dev.modelpass.sdk.ModelPassRedirectActivity" android:exported="true">
    <intent-filter android:autoVerify="true">
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />
        <data android:scheme="https" android:host="app.example.com" android:path="/modelpass/callback" />
    </intent-filter>
</activity>
```

### 2.4 开发环境：局域网 http Hub

协议允许 `http://` 仅用于 `localhost`、`127.0.0.1`、`10.x`、`192.168.x`、`172.16–31.x`、`*.local`。Android 9+ 默认禁止明文流量，调试版需要在 `src/debug` 中通过 `networkSecurityConfig` 放行对应主机，或设置 `android:usesCleartextTraffic="true"`。发布版建议 `allowLocalHttpIssuers = BuildConfig.DEBUG`。

## 3. 初始化

在 `Application.onCreate()` 中创建**唯一**实例：用户在钱包里授权时你的进程可能被系统回收，回调到达后需要立即有实例来完成换取令牌。

```kotlin
class App : Application() {
    lateinit var modelPass: ModelPass
        private set

    override fun onCreate() {
        super.onCreate()
        modelPass = ModelPass(
            this,
            ModelPassConfig(
                clientId = "com.example.chat",                      // 推荐使用包名
                redirectUri = "com.example.chat:/modelpass/callback",
                clientName = "Example Chat",
                scopes = listOf(Scopes.CHAT, Scopes.TOOLS),
                slots = listOf(Slots.DEFAULT, Slots.FAST),
                linkRendezvous = "https://hub.example.com",        // 扫码授权使用的 Hub
                // trustedIssuers = setOf("https://hub.example.com"), // 可选：只接受这些 Hub
                allowLocalHttpIssuers = BuildConfig.DEBUG,
            ),
        )
    }
}
```

构造时会同步读取一次已保存的会话（一个很小的加密文件）。会话默认由 `KeystoreSessionStore` 保存；也可以传入 `InMemorySessionStore()` 或自定义的 `SessionStore`。

## 4. 「使用 ModelPass 继续」

```kotlin
lifecycleScope.launch {
    try {
        val session = modelPass.authorize(this@MainActivity) // 打开钱包，等待用户确认
        toast("已连接 ${session.issuer}")                     // 应展示正在连接的 Hub（协议 §13）
    } catch (e: ModelPassException.WalletNotInstalled) {
        showQrLogin()                                         // 改用扫码授权，见第 7 节
    } catch (e: ModelPassException.AccessDenied) {
        // 用户拒绝
    } catch (e: ModelPassException.Cancelled) {
        // 用户没有授权就返回了
    } catch (e: ModelPassException) {
        showError(e.message)
    }
}
```

`authorize()` 会生成 `state` 与 PKCE（S256）、把待完成的请求持久化、通过 `ACTION_VIEW` 打开 `modelpass://authorize?…`，并在回调中校验 `state` 和 `iss`（RFC 9207）后到 `{iss}/oauth/token` 换取令牌。连接状态请以 `session` 为准——即使 `authorize()` 所在的协程已被取消（旋转屏幕、进程被回收），回调到达后会话仍会被保存并发布：

```kotlin
lifecycleScope.launch {
    repeatOnLifecycle(Lifecycle.State.STARTED) {
        modelPass.session.collect { session -> render(session) }
    }
}
```

如果回调由你自己的 Activity 接收（例如 App Link），调用 `modelPass.handleRedirect(intent)` 即可。

### Compose 示例

SDK 本身不依赖 Compose，可以这样写一个按钮（需要 `androidx.activity:activity-compose` 1.10+ 与 `lifecycle-runtime-compose`）：

```kotlin
@Composable
fun ModelPassButton(modelPass: ModelPass, onError: (ModelPassException) -> Unit) {
    val activity = LocalActivity.current ?: return
    val scope = rememberCoroutineScope()
    val session by modelPass.session.collectAsStateWithLifecycle()
    Button(
        onClick = {
            scope.launch {
                try { modelPass.authorize(activity) } catch (e: ModelPassException) { onError(e) }
            }
        },
        enabled = session == null,
        shape = RoundedCornerShape(12.dp),
        colors = ButtonDefaults.buttonColors(containerColor = Color(0xFF5B5BF7)),
        modifier = Modifier.heightIn(min = 48.dp),
    ) {
        Text(if (session == null) "使用 ModelPass 继续" else "已连接 ModelPass")
    }
}
```

## 5. 调用模型

`model` 传槽位 ID（`default` / `fast` / `reasoning` / `vision`），具体厂商和模型由用户在钱包中决定；其它模型名会回落到 `default`（`completion.routing.fallback == true`）。

```kotlin
val reply = modelPass.chat(
    listOf(ChatMessage.system("回答尽量简短"), ChatMessage.user("你好")),
    model = Slots.FAST,
)
println(reply.text)
println(reply.routing.slot)            // x-modelpass-* 响应头
println(reply.usage?.totalTokens)

// 流式（SSE）：取消收集协程即可中断生成
modelPass.streamChat(listOf(ChatMessage.user("写一首关于秋天的诗"))).collect { event ->
    when (event) {
        is ChatStreamEvent.Delta -> textView.append(event.text)
        is ChatStreamEvent.Finish -> Log.d("chat", "finish: ${event.reason}")
        is ChatStreamEvent.Usage -> Log.d("chat", "tokens: ${event.usage.totalTokens}")
        else -> Unit // Routing / ReasoningDelta / ToolCallDelta
    }
}
```

图片输入用 `ChatMessage.userWithImages(text, urls)`（需要 `vision` scope），工具调用通过 `ChatRequest(tools = …)`（需要 `tools` scope）。

### 搭配任意 OpenAI 兼容客户端

会话就是一个 base URL 加一个 Bearer 令牌：

```kotlin
val s = modelPass.currentSession ?: return
s.apiBase              // 例如 https://hub.example.com/v1
s.accessToken          // 作为 API Key：Authorization: Bearer <token>

// 例：openai-kotlin
val openai = OpenAI(token = s.accessToken, host = OpenAIHost(baseUrl = s.apiBase + "/"))

// 例：OkHttp / Retrofit
val client = OkHttpClient.Builder()
    .addInterceptor { chain ->
        chain.proceed(chain.request().newBuilder().header("Authorization", s.authorizationHeader).build())
    }
    .build()
```

使用第三方客户端时，收到 401（`invalid_token` / `grant_revoked` / `grant_expired`）请调用 `modelPass.signOut(revoke = false)` 并引导重新连接。

## 6. 授权管理

```kotlin
val info = modelPass.grantInfo()           // 状态、槽位、今日用量与额度
modelPass.openWalletManagement(activity)   // 打开 modelpass://grants/{grant_id}（应用应提供「在 ModelPass 中管理」入口）
modelPass.signOut(revoke = true)           // 清除本地会话并撤销令牌（尽力而为）
```

## 7. 扫码授权（跨设备，Link Flow）

适用于平板、电视等未安装钱包的设备。二维码中携带一次性密钥 `s`，令牌经端到端加密后才通过汇合 Hub 传递。

```kotlin
val link = modelPass.startLink()            // 默认使用 config.linkRendezvous
showQrCode(link.qrUrl)                      // 例如用 ZXing 渲染；SDK 不包含二维码库
showUserCode(link.userCode)                 // BCDF-GHJK，便于用户在钱包里核对
try {
    val session = link.awaitSession()       // 轮询直到用户在手机上确认；会话自动保存
} catch (e: ModelPassException.LinkExpired) {
    // 二维码过期（link.expiresAt，Unix 秒），重新 startLink()
} catch (e: ModelPassException.LinkDenied) {
    // 用户拒绝
} finally {
    hideQrCode()                            // 二维码是一次性凭证，完成或失败后立即销毁
}
// 关闭对话框时调用 link.cancel()；本机装了钱包时也可以 link.openInWallet(activity)
```

## 8. 错误处理

所有错误都是 `ModelPassException` 的子类：

| 异常 | 场景 | 建议处理 |
| --- | --- | --- |
| `WalletNotInstalled` | 没有应用能处理 `modelpass://authorize` | 引导安装钱包或改用扫码授权 |
| `AccessDenied` | 用户在钱包中拒绝（`access_denied`） | 静默或提示 |
| `AuthorizationFailed(error)` | 钱包返回其它 OAuth 错误（`invalid_scope`、`server_error`…） | 提示后重试 |
| `Cancelled` | 用户未授权就返回应用、调用了 `link.cancel()`、或被新的 `authorize()` 取代 | 静默 |
| `InvalidState` | 回调 `state` 不匹配（过期或伪造的回调） | 重新发起授权 |
| `UntrustedIssuer` | `iss` 不是 https（本地开发地址除外）或不在 `trustedIssuers` 中 | 拒绝连接并提示 |
| `TokenExchangeFailed(error)` | 令牌端点拒绝（如授权码过期 `invalid_grant`） | 重新授权 |
| `LinkExpired` / `LinkDenied` | 二维码过期 / 用户拒绝扫码请求 | 刷新二维码 |
| `Api(status, code)` | 模型接口错误（协议 §8.7），见下表 | |
| `Network` | 离线、DNS、TLS、超时 | 稍后重试 |
| `InvalidResponse` | 响应格式错误或解密失败 | 记录并重试 |
| `NotAuthorized` | 尚未连接、已登出或会话过期 | 显示连接按钮 |

| HTTP | `Api.code` | 含义 / 处理 |
| --- | --- | --- |
| 401 | `invalid_token`、`grant_revoked`、`grant_expired` | SDK 已自动清除会话（`requiresReauthorization == true`），提示重新连接 |
| 403 | `grant_paused` | 用户暂停了该应用：`openWalletManagement()` 引导恢复 |
| 403 | `insufficient_scope` | 例如未授权 `vision` 却发送了图片 |
| 429 | `budget_exceeded` | 超过用户设置的每日额度 |
| 503 | `no_route` | 用户尚未为该槽位配置模型：引导打开钱包 |
| 502 | `upstream_auth_failed` | 用户的厂商 Key 失效：引导到钱包检查 |
| 502 / 4xx | `upstream_error` | 上游错误，原始信息在 `message` 中 |

## 9. 安全说明

- 令牌只保存在 `KeystoreSessionStore`：会话 JSON 用 Android Keystore 中不可导出的 AES-256-GCM 密钥加密后存入私有 SharedPreferences（未使用已废弃的 `androidx.security:security-crypto`）。备份恢复到其它设备后无法解密，会被丢弃并要求重新授权。
- `ModelPassSession.toString()` 等不会输出令牌；SDK 日志中不包含令牌、授权码或 PKCE 原文。
- 回调必须携带匹配的 `state`，`iss` 必须为 https（或本地开发地址）且可选地限制在 `trustedIssuers` 内；令牌响应中的 `issuer` 必须与 `iss` 一致。
- HTTP 层不跟随重定向，避免把 Bearer 令牌转发到其它主机。
- 待完成的授权（`state` + PKCE verifier）以明文保存在应用私有存储 `dev.modelpass.sdk.pending.xml` 中，单次使用、15 分钟过期。

## 10. 构建与测试

```bash
cd sdks/android
./gradlew :modelpass-core:test                                    # 不需要 Android SDK
./gradlew :modelpass-core:test :modelpass-android:assembleRelease  # 需要 ANDROID_HOME 或 local.properties
```

- 找不到 Android SDK 时 `:modelpass-android` 会被自动跳过（构建日志会提示）；`-Pmodelpass.android=true` 强制包含（找不到 SDK 时直接失败），`=false` 强制跳过。
- 仓库包含 Gradle Wrapper（9.8.2，校验了分发包 SHA-256）。如需重新生成：`gradle wrapper --gradle-version 9.8.2`。
- `modelpass-core` 的测试逐字节校验 [`docs/test-vectors.json`](../../docs/test-vectors.json)（PKCE、link_verifier / link_challenge、HKDF 密钥、AES-GCM 密文、二维码 URL），并用 JDK 内置的 `com.sun.net.httpserver.HttpServer` 模拟 Hub 跑通换取令牌、扫码轮询（`authorization_pending` / `slow_down` / 拒绝 / 过期）、流式与非流式对话、错误映射和取消。
