# ModelPassSDK for iOS

「使用 ModelPass 继续」的 iOS SDK：让你的 App 一键接入**用户自己的**大模型（BYOK）。授权完成后你拿到的是一个 OpenAI 兼容的
`api_base` 和一个 Bearer 令牌，用户在 ModelPass 钱包里决定背后用哪家厂商、哪个模型，你的 App 不接触任何厂商 Key。

协议细节见 [`docs/protocol.md`](../../docs/protocol.md)（ModelPass Connect v0.1）。

> **English summary.** `ModelPassSDK` is a dependency-free Swift package (iOS 15+, macOS 12+) implementing ModelPass
> Connect v0.1: the same-device flow (OAuth 2.0 authorization code + PKCE with the wallet app, RFC 9207 `iss`
> validation, discovery with fallback), the cross-device QR "link" flow (HKDF + AES-256-GCM end-to-end encrypted token
> hand-off), Keychain session storage, grant info, revocation, and chat helpers for the OpenAI-compatible endpoint
> (including SSE streaming). Forward incoming URLs with `.onOpenURL { modelPass.handleRedirect($0) }`, call
> `try await modelPass.authorize()`, then use `session.apiBase` + `session.accessToken` with any OpenAI-compatible
> client, or `modelPass.chat(…)` / `modelPass.streamChat(…)`. A SwiftUI `ModelPassButton` is included.

---

## 目录

1. [安装](#1-安装)
2. [配置 Info.plist](#2-配置-infoplist)
3. [快速开始（SwiftUI）](#3-快速开始swiftui)
4. [调用模型](#4-调用模型)
5. [扫码授权（Link Flow）](#5-扫码授权link-flow)
6. [授权信息、管理与断开](#6-授权信息管理与断开)
7. [错误处理](#7-错误处理)
8. [安全说明](#8-安全说明)
9. [API 一览](#9-api-一览)
10. [开发与测试](#10-开发与测试)

## 1. 安装

要求：Xcode 15+（Swift 5.9+），iOS 15+ / Mac Catalyst 15+ / macOS 12+。无第三方依赖（Foundation、CryptoKit、Security、
Combine，以及可选的 UIKit / SwiftUI）。

**本地路径（monorepo 内开发推荐）**：Xcode → File → Add Package Dependencies… → Add Local… → 选择 `sdks/ios`；
或在你自己的 `Package.swift` 中：

```swift
dependencies: [
    .package(path: "../modelpass/sdks/ios"),
],
targets: [
    .target(name: "MyApp", dependencies: [.product(name: "ModelPassSDK", package: "ios")]),
]
```

**Git URL**：仓库根目录已提供指向本目录的 `Package.swift`，可以直接添加整个仓库：

```swift
.package(url: "https://github.com/yanboishere/modelpass", branch: "main")
// target 依赖：.product(name: "ModelPassSDK", package: "modelpass")
```

（在 Xcode 中：File → Add Package Dependencies… → 输入仓库地址。）

然后 `import ModelPassSDK`。

## 2. 配置 Info.plist

```xml
<!-- 1) 回调 scheme：与 redirectURI 的 scheme 一致（推荐用 Bundle ID，RFC 8252 §7.1） -->
<key>CFBundleURLTypes</key>
<array>
  <dict>
    <key>CFBundleURLName</key>
    <string>com.example.chat.modelpass</string>
    <key>CFBundleURLSchemes</key>
    <array>
      <string>com.example.chat</string>
    </array>
  </dict>
</array>

<!-- 2) 允许检测钱包是否已安装（canOpenURL） -->
<key>LSApplicationQueriesSchemes</key>
<array>
  <string>modelpass</string>
</array>
```

- `redirectURI` 推荐 `com.example.chat:/modelpass/callback`（私有 scheme），也可以使用你已配置好的 HTTPS 通用链接。
- 如果没有声明 `LSApplicationQueriesSchemes`，iOS 的 `canOpenURL` 永远返回 false。SDK 会跳过这个预检查直接尝试打开钱包
  （打不开时依然抛出 `.walletNotInstalled`），并在控制台打印提示；但 `isWalletInstalled` 将无法给出准确结果。

## 3. 快速开始（SwiftUI）

```swift
import ModelPassSDK
import SwiftUI

@main
struct ChatApp: App {
    @StateObject private var modelPass = ModelPass(configuration: .init(
        clientId: "com.example.chat",                                   // 推荐使用 Bundle ID
        redirectURI: URL(string: "com.example.chat:/modelpass/callback")!,
        clientName: "Example Chat",                                     // 钱包授权页显示的名称
        scopes: ["chat"],                                               // chat / vision / tools / model_choice
        slots: ["default", "fast"]                                      // default / fast / reasoning / vision
    ))

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(modelPass)
                .onOpenURL { modelPass.handleRedirect($0) }             // 把钱包的回跳交给 SDK
        }
    }
}

struct ContentView: View {
    @EnvironmentObject private var modelPass: ModelPass
    @State private var showQRCode = false
    @State private var errorMessage: String?

    var body: some View {
        if let session = modelPass.session {
            Text("已连接：\(session.issuer.host ?? "")")
        } else {
            ModelPassButton(isLoading: modelPass.isAuthorizing) {
                Task {
                    do {
                        try await modelPass.authorize(budgetHint: 200_000)
                    } catch ModelPassError.walletNotInstalled {
                        showQRCode = true                               // 未安装钱包：改用扫码授权（§5）
                    } catch ModelPassError.accessDenied {
                        // 用户在钱包中点了拒绝，无需提示
                    } catch {
                        errorMessage = error.localizedDescription
                    }
                }
            }
            .padding()
        }
    }
}
```

- `authorize()` 会打开钱包并**等待回跳**；回跳 URL 必须通过 `handleRedirect(_:)` 交给 SDK。
- 如果用户没在钱包里完成操作就手动切回你的 App（回到前台约 2 秒内没有收到回跳），`authorize()` 会以 `.cancelled` 结束，
  按钮不会一直转圈；该请求仍然有效，之后若钱包再回跳，依然会完成授权并更新 `session`。
- 待处理的请求（state + PKCE verifier）保存在 Keychain 中：即使 App 在钱包前台期间被系统杀掉，冷启动后收到回跳也能完成授权。
  这种情况下没有正在等待的 `authorize()`，请通过 `modelPass.session`（`@Published`）、`onSessionChange` 或
  `onAuthorizationResult` 获取结果。
- UIKit：在 `scene(_:openURLContexts:)` 中调用 `modelPass.handleRedirect(context.url)`；
  若想直接 `await` 结果，可用 `try await modelPass.completeAuthorization(redirectURL: url)`。
- 观察会话：`modelPass.$session`（Combine）、`for await s in modelPass.$session.values { … }`、`modelPass.onSessionChange = { … }`。
- `ModelPass` 运行在主 actor 上（`@MainActor`），网络请求不会阻塞主线程。

## 4. 调用模型

### 内置 helper

```swift
// 非流式
let reply = try await modelPass.chat([.system("简短回答"), .user("你好")], model: "default")
print(reply.text ?? "", reply.routing.slot ?? "", reply.usage?.totalTokens ?? 0)

// 流式（SSE）
var text = ""
for try await event in modelPass.streamChat([.user("写一首关于秋天的诗")], model: "fast") {
    switch event {
    case .content(let delta): text += delta
    case .reasoning(let delta): print("思考：", delta)
    case .finish(let reason): print("结束：", reason)
    case .usage(let usage): print("tokens：", usage.totalTokens)
    case .routing(let routing): print("槽位：", routing.slot ?? "-", "回落：", routing.fallback)
    case .toolCall: break
    }
}
```

- `model` 传槽位 ID（`default` / `fast` / `reasoning` / `vision`）；其他值会被 Hub 回落到 `default`（`routing.fallback == true`）。
- `ChatOptions` 支持 `temperature`、`maxTokens`、`tools`（需 `tools` scope）、`responseFormat`、`extraBody`、`extraHeaders` 等；
  图片输入用 `.user([.text("这是什么？"), .image(data: jpeg)])`（需 `vision` scope）。
- 退出 `for try await` 循环或取消任务会中断请求。

### 任意 OpenAI 兼容客户端

会话就是一个标准的 OpenAI 兼容端点：`baseURL = session.apiBase`，`apiKey = session.accessToken`。

```swift
guard let session = modelPass.session else { return }

// 直接用 URLSession
var request = URLRequest(url: session.apiBase.appendingPathComponent("chat/completions"))
request.httpMethod = "POST"
request.setValue("Bearer \(session.accessToken)", forHTTPHeaderField: "Authorization")
request.setValue("application/json", forHTTPHeaderField: "Content-Type")
request.httpBody = try JSONSerialization.data(withJSONObject: [
    "model": "default",
    "messages": [["role": "user", "content": "你好"]],
])
let (data, _) = try await URLSession.shared.data(for: request)

// 或者第三方 SDK，例如 MacPaw/OpenAI（参数名以所用版本为准）：
// let client = OpenAI(configuration: .init(token: session.accessToken, host: session.apiBase.host!,
//                                          scheme: session.apiBase.scheme!, basePath: session.apiBase.path))
```

自行调用时，遇到 401 `invalid_token` / `grant_revoked` / `grant_expired` 请调用 `await modelPass.signOut(revoke: false)` 清除会话；
内置 helper 会自动处理。

## 5. 扫码授权（Link Flow）

适用于钱包不在本机（iPad、Mac、电视等）或未安装钱包的情况。二维码里携带一次性密钥 `s`，令牌经端到端加密传递，汇合点
（rendezvous）既读不到也伪造不了。

```swift
struct LinkView: View {
    @EnvironmentObject private var modelPass: ModelPass
    @State private var link: ModelPassLink?
    @State private var message: String?

    var body: some View {
        VStack(spacing: 16) {
            if let link {
                ModelPassQRCodeView(link: link).frame(width: 240, height: 240)
                Text(link.userCode).font(.title.monospaced())              // 供用户在钱包中核对
                Text("请用 ModelPass 钱包扫码").foregroundStyle(.secondary)
            }
            if let message { Text(message) }
        }
        .task {
            do {
                let link = try await modelPass.startLink(rendezvous: URL(string: "https://hub.example.com")!)
                self.link = link
                let session = try await link.waitForSession()            // 轮询直到用户在钱包中同意
                message = "已连接 \(session.issuer.host ?? "")"
            } catch {
                message = error.localizedDescription                       // .linkExpired / .linkDenied / .cancelled …
            }
            link = nil                                                     // 完成或失败后立即销毁二维码（§13.7）
        }
    }
}
```

- 视图消失时 `.task` 会被取消，轮询随之停止；也可以手动调用 `link.cancel()`。
- 轮询遵守 `interval`，收到 `slow_down` 时间隔 +5 秒；网络抖动和 5xx 会继续重试直到过期。
- 如果钱包就装在本机，可以 `UIApplication.shared.open(link.walletURL)` 直接拉起钱包。
- 也可以用 `link.qrCodeImage()`（`CGImage`）/ `link.qrCodeUIImage()`（`UIImage`）自行渲染二维码。

## 6. 授权信息、管理与断开

```swift
let info = try await modelPass.grantInfo()          // GET {api_base}/modelpass/grant
print(info.status, info.slots.map(\.label), info.budget?.tokensRemainingToday ?? -1)

if let url = modelPass.manageURL {                  // modelpass://grants/{grant_id}
    Link("在 ModelPass 中管理", destination: url)
}

await modelPass.signOut()                           // POST {issuer}/oauth/revoke，并清除 Keychain
```

## 7. 错误处理

所有错误都是 `ModelPassError`（实现了 `LocalizedError`，`localizedDescription` 会根据系统语言给出中文或英文提示）。
辅助属性：`error.code`（协议错误码）、`error.requiresReauthorization`（需要重新连接时为 true，SDK 已清除会话）。

| 错误 | 含义 | 建议处理 |
| --- | --- | --- |
| `.walletNotInstalled` | 未安装 ModelPass 钱包 | 引导安装，或改用扫码授权 `startLink` |
| `.accessDenied(description)` | 用户在钱包中拒绝 | 通常无需提示 |
| `.authorizationFailed(code:description:)` | 钱包 / rendezvous 返回其他 OAuth 错误（`invalid_scope` 等） | 检查参数后重试 |
| `.invalidState` | `state` 不匹配、没有待处理的请求或请求已过期（30 分钟） | 重新发起授权 |
| `.untrustedIssuer(issuer)` | `iss` 不是 https（本地开发除外）、不在 `trustedIssuers` 中，或被 `issuerConfirmation` 拒绝 | 视为安全风险，不要继续 |
| `.tokenExchangeFailed(error, description)` | 换取令牌失败，如 `invalid_grant`（授权码 120 秒过期） | 重新授权 |
| `.notSignedIn` | 当前没有会话 | 显示「使用 ModelPass 继续」 |
| `.api(401, "invalid_token" / "grant_revoked" / "grant_expired", _)` | 授权失效 / 被撤销 / 已过期（SDK 已清除会话） | 提示重新连接 |
| `.api(403, "grant_paused", _)` | 用户在钱包中暂停了该应用 | 引导打开 `manageURL` 恢复 |
| `.api(403, "insufficient_scope", _)` | 例如未授权 `vision` 却发送图片 | 用所需 scope 重新授权 |
| `.api(429, "budget_exceeded", _)` | 超过用户设置的每日额度 | 提示稍后再试 / 去钱包调整 |
| `.api(503, "no_route", _)` | 该槽位尚未配置模型 | 引导打开钱包 |
| `.api(502, "upstream_auth_failed", _)` | 用户的厂商 Key 失效 | 引导到钱包检查 |
| `.api(_, "upstream_error", message)` | 上游模型服务出错 | 展示 `message` |
| `.linkExpired` / `.linkDenied` | 二维码过期 / 用户拒绝 | 刷新二维码 |
| `.invalidResponse(detail)` | 响应无法解析、密文无法解密等 | 重试；检查 Hub 版本 |
| `.network(URLError)` | 网络错误（按 `URLError.Code` 比较相等） | 提示网络问题并重试 |
| `.cancelled` | 任务被取消、被新的 `authorize()` 取代，或 `link.cancel()` | 忽略 |

## 8. 安全说明

- **PKCE（S256）必选**，`state` 为 128 bit 随机数并做常量时间比较；授权请求一次性使用。
- **`iss` 校验（RFC 9207）**：必须是 https；`http` 只允许 `localhost`、`127.0.0.1`、`*.local`、局域网私有地址
  （10/8、172.16/12、192.168/16、169.254/16、fc00::/7、fe80::/10）。`api_base` 也按同样规则校验，防止令牌明文外泄。
- 可以用 `trustedIssuers` 设置受信 Hub 白名单，或用 `issuerConfirmation` 在换取令牌前向用户展示「正在连接 {issuer}」（§13.2）：

  ```swift
  modelPass.issuerConfirmation = { issuer in
      await confirmWithUser("正在连接 \(issuer.host ?? "")，是否继续？")
  }
  ```

- **令牌只存 Keychain**（`KeychainSessionStore`：`kSecClassGenericPassword`，service `dev.modelpass.sdk`，默认
  `afterFirstUnlockThisDeviceOnly`，可配置 `accessGroup` 与其他 accessibility）。打印 / `dump` 会话时令牌会被隐藏。
- 扫码授权中 `s` 只存在于二维码片段（`#`）里，不会发送给任何服务器；rendezvous 返回的密文用 HKDF-SHA256 + AES-256-GCM
  解密，AAD 绑定 user code，被篡改或伪造的密文会被拒绝。

## 9. API 一览

| 类型 / 成员 | 说明 |
| --- | --- |
| `ModelPassConfiguration(clientId:redirectURI:clientName:scopes:slots:walletAuthorizeURL:trustedIssuers:)` | 静态配置 |
| `ModelPass(configuration:sessionStore:urlSession:urlOpener:)` | 主入口（`@MainActor`、`ObservableObject`） |
| `session`、`isAuthorizing`、`onSessionChange`、`onAuthorizationResult`、`issuerConfirmation` | 状态与回调 |
| `authorize(scopes:slots:budgetHint:)` | 同设备授权（§6） |
| `handleRedirect(_:) -> Bool`、`completeAuthorization(redirectURL:)`、`isRedirectURL(_:)` | 处理钱包回跳 |
| `startLink(rendezvous:scopes:slots:) -> ModelPassLink` | 扫码授权（§7） |
| `ModelPassLink`：`userCode`、`qrURL`、`walletURL`、`expiresAt`、`waitForSession()`、`cancel()`、`qrCodeImage()` | 扫码授权会话 |
| `chat(_:model:options:)`、`streamChat(_:model:options:)` | 调用模型（§8） |
| `grantInfo()`、`signOut(revoke:)`、`manageURL`、`isWalletInstalled`、`reloadSession()` | 授权管理（§8.6、§9） |
| `ModelPassSession`、`ModelPassSlot`、`ModelPassGrantInfo` | 数据模型 |
| `ModelPassSessionStore`、`KeychainSessionStore`、`InMemorySessionStore` | 存储（测试 / Preview 用 `InMemorySessionStore(session:)`） |
| `ModelPassButton`、`ModelPassLogo`、`ModelPassQRCodeView`、`ModelPassQRCode` | UI（SwiftUI / CoreImage） |
| `ModelPassURLOpener` | 自定义打开钱包的方式（App Extension、测试等） |

## 10. 开发与测试

```bash
cd sdks/ios
swift build
swift test                                     # macOS 上运行全部单元测试
MODELPASS_KEYCHAIN_TESTS=1 swift test          # 额外运行真实 Keychain 读写测试

# 验证 iOS 编译
xcodebuild -scheme ModelPassSDK -destination 'generic/platform=iOS Simulator' \
  -derivedDataPath /tmp/modelpass-ios-dd build
```

测试覆盖：

- `docs/test-vectors.json` 中的全部向量逐字节校验（PKCE、RFC 7636 附录 B、link_verifier / link_challenge、HKDF 密钥、
  AES-GCM 密文的解密与按固定 nonce 重新加密、二维码 URL），以及 RFC 5869 HKDF 测试用例；
- 授权 URL 构造、回跳匹配、`state` / `error` / `iss` 校验规则、发现文档回退、冷启动恢复、重复回跳去重；
- 通过 `URLProtocol` 桩端到端测试令牌交换、扫码轮询（`authorization_pending` / `slow_down` / `access_denied` / `expired_token`）、
  对话、SSE 流式解析、错误映射与 401 清除会话、授权信息与撤销。
