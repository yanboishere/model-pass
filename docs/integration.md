# 第三方应用接入指南

接入后，你的应用：

- 不需要让用户填写 API Key，也不需要维护模型列表；
- 得到一个 **OpenAI 兼容** 的 `api_base` 和访问令牌，任何 OpenAI / Anthropic SDK 都能直接用；
- 请求的是**槽位**（`default` / `fast` / `reasoning` / `vision`），具体模型由用户在 ModelPass 中决定、随时切换。

协议细节见 [protocol.md](./protocol.md)。下面按平台给出最小接入代码。

## 0. 准备

1. **选择 `client_id`**：推荐使用 iOS Bundle ID / Android 包名，例如 `com.example.chat`。
2. **选择回调地址**：推荐使用经过验证的通用链接 / App Link；也可以用私有 scheme，如 `com.example.chat:/modelpass/callback`。
3. **（可选）在 Hub 登记**：把应用加入 Hub 的 `clients.json`（名称、图标、回调地址）。登记后授权页显示「已验证应用」，Hub 只会把授权码发往登记过的回调地址。
4. **本地联调**：`npm run hub` 启动 Hub（自带模拟上游），`npm run dev-token` 可以直接拿到一个可用的令牌。

## 1. React Native / Expo（`@modelpass/sdk`）

```ts
import * as Linking from 'expo-linking'
import * as SecureStore from 'expo-secure-store'
import { fetch as expoFetch } from 'expo/fetch'
import { ModelPassClient } from '@modelpass/sdk'

export const modelpass = new ModelPassClient({
  clientId: 'com.example.chat',
  clientName: 'Example Chat',
  redirectUri: Linking.createURL('modelpass-callback'), // 生产构建：com.example.chat://modelpass-callback
  scopes: ['chat', 'vision'],
  slots: ['default', 'fast'],
  storage: {
    getItem: (k) => SecureStore.getItemAsync(k),
    setItem: (k, v) => SecureStore.setItemAsync(k, v),
    removeItem: (k) => SecureStore.deleteItemAsync(k),
  },
  fetch: expoFetch as unknown as typeof fetch, // 支持流式响应体
  openUrl: (url) => Linking.openURL(url),
})

// 把回调交给 SDK（冷启动 + 运行中两种情况）
Linking.getInitialURL().then((url) => url && modelpass.handleRedirect(url))
Linking.addEventListener('url', ({ url }) => modelpass.handleRedirect(url))

// 「使用 ModelPass 继续」
const session = await modelpass.authorize()

// 对话（流式）
for await (const text of modelpass.chat.streamText({ model: 'default', messages: [{ role: 'user', content: '你好' }] })) {
  process(text)
}
```

完整示例：[`apps/demo-chat`](../apps/demo-chat)。

## 2. iOS（Swift，`ModelPassSDK`）

```swift
// Package: .package(url: "https://github.com/yanboishere/modelpass", branch: "main")
@StateObject private var modelPass = ModelPass(configuration: .init(
    clientId: "com.example.chat",
    redirectURI: URL(string: "com.example.chat:/modelpass/callback")!,
    clientName: "Example Chat",
    scopes: ["chat"], slots: ["default", "fast"]))

// WindowGroup { ContentView().onOpenURL { modelPass.handleRedirect($0) } }

try await modelPass.authorize()
for try await event in modelPass.streamChat([.user("你好")], model: "default") {
    if case .content(let delta) = event { text += delta }
}
```

Info.plist 需要声明回调 scheme（`CFBundleURLTypes`）以及 `LSApplicationQueriesSchemes = [modelpass]`。详见 [`sdks/ios/README.md`](../sdks/ios/README.md)。

## 3. Android（Kotlin，`modelpass-android`）

```kotlin
val modelPass = ModelPass(context, ModelPassConfig(
    clientId = "com.example.chat",
    redirectUri = "com.example.chat:/modelpass/callback",
    clientName = "Example Chat",
    scopes = listOf(Scopes.CHAT),
    slots = listOf(Slots.DEFAULT, Slots.FAST),
))

lifecycleScope.launch {
    val session = modelPass.authorize(this@MainActivity)
    modelPass.streamChat(listOf(ChatMessage.user("你好"))).collect { event ->
        if (event is ChatStreamEvent.Delta) textView.append(event.text)
    }
}
```

清单中需要 `manifestPlaceholders["modelpassRedirectScheme"]` 与 `<queries>`（scheme `modelpass`）。详见 [`sdks/android/README.md`](../sdks/android/README.md)。

## 4. 网页 / 桌面 / 电视：扫码授权

```ts
const client = new ModelPassClient({ clientId: 'com.example.web', redirectUri: 'https://example.com/unused', clientName: 'Example Web' })
const link = await client.startLink('https://hub.example.com')   // 作为汇合点的 Hub
showQrCode(link.qrUrl)                                           // 同时显示 link.userCode
const session = await link.waitForSession()                       // 用户在手机上的 ModelPass 中扫码确认
```

浏览器中不想引入 SDK 时，可以参考 Hub 的 `/demo` 页面：只用 WebCrypto（HMAC、SHA-256、HKDF、AES-GCM）就实现了整个流程。

## 5. 直接用 OpenAI / Anthropic SDK

拿到会话后，`api_base` + `access_token` 就是一组普通的 OpenAI 兼容凭据：

```python
from openai import OpenAI
client = OpenAI(base_url=session["api_base"], api_key=session["access_token"])
client.chat.completions.create(model="default", messages=[{"role": "user", "content": "你好"}])
```

```ts
import Anthropic from '@anthropic-ai/sdk'
// /v1/messages 只在用户把槽位路由到 Anthropic 协议的厂商时可用
const anthropic = new Anthropic({ baseURL: session.issuer, apiKey: session.access_token })
```

## 6. 错误处理建议

| 错误码 | 建议的界面 |
| --- | --- |
| `invalid_token` / `grant_revoked` / `grant_expired` | 清除会话，显示「重新连接 ModelPass」 |
| `grant_paused` / `no_route` / `upstream_auth_failed` / `budget_exceeded` | 显示原因，并提供「在 ModelPass 中处理」按钮（打开 `modelpass://grants/{grant_id}`） |
| `insufficient_scope` | 重新发起授权并申请缺少的 scope（如 `vision`） |

## 7. 按钮规范

文案「使用 ModelPass 继续」/“Continue with ModelPass”，主色 `#5B5BF7`，圆角 ≥ 10pt，高度 ≥ 44pt。三个 SDK 都内置了按钮组件（React Native 示例见 `apps/demo-chat/src/ModelPassButton.tsx`）。
