# ModelPass Connect 协议 v0.1（草案）

> 让任何 iOS / Android / Web 应用通过「使用 ModelPass 继续」一键接入**用户自己的**大模型（BYOK 或可授权的厂商账户），
> 应用无需让用户填写 API Key，模型的选择与切换由用户在 ModelPass 钱包中统一掌控。

状态：Draft · 版本 `0.1` · 本文中的 **必须 / 应当 / 可以** 分别对应 RFC 2119 的 MUST / SHOULD / MAY。

---

## 1. 设计目标

| 目标 | 做法 |
| --- | --- |
| 第三方应用零配置 | 应用只拿到一个 OpenAI 兼容的 `api_base` + 一个授权令牌，不接触任何厂商 Key |
| 用户掌控模型 | 应用请求的是抽象的**模型槽位**（`default` / `fast` / `reasoning` / `vision`），由用户在钱包里把槽位映射到具体厂商与模型；一键切换，所有应用即时生效（移动端的 “CC Switch”） |
| 最小权限 | 授权按应用隔离，带能力范围（scope）、每日额度、有效期，可随时暂停 / 撤销 |
| 密钥不落地 | 厂商 Key 只以「钱包设备生成的 Vault Key」加密后的密文存在 Hub；Hub 数据库泄露无法还原明文；第三方应用永远拿不到 Key |
| 基于标准 | OAuth 2.0（RFC 6749）、PKCE（RFC 7636）、原生应用最佳实践（RFC 8252）、设备授权（RFC 8628）、令牌撤销（RFC 7009）、签发者标识（RFC 9207）、OpenAI Chat Completions 兼容接口 |
| 可自托管 | Hub 是一个开源的无状态服务 + SQLite，可部署在个人服务器 / NAS / 云函数 |

非目标（v0.1）：用户身份联合登录（不提供邮箱等身份信息，只给出按应用隔离的匿名 `sub`）、计费结算、Embeddings / 图像生成接口。

## 2. 角色

```
┌──────────────┐   ① 使用 ModelPass 继续    ┌───────────────────┐
│  第三方应用   │ ─────────────────────────▶ │  ModelPass 钱包 App │  持有 Vault Key 与厂商 Key
│  (Client)    │ ◀───────────────────────── │  (Wallet)          │  展示授权页 / 切换模型
└──────┬───────┘   ② code + iss 回跳         └─────────┬─────────┘
       │ ③ 换取令牌 / ④ 调用模型                        │ 管理 API（封存的凭据、路由、授权）
       ▼                                              ▼
┌─────────────────────────────────────────────────────────────┐
│ ModelPass Hub（Issuer）  授权服务器 + 模型中继（OpenAI 兼容）     │
└───────────────────────────────┬─────────────────────────────┘
                                │ ⑤ 使用用户自己的 Key 转发
                                ▼
                 OpenAI / Anthropic / Gemini / DeepSeek / OpenRouter / 自建 …
```

- **User**：拥有厂商 Key / 账户的用户。
- **Wallet**：ModelPass 钱包 App。生成并保管 **Vault Key（VK）** 与厂商凭据，展示授权同意页，管理模型路由。
- **Hub**：授权服务器 + 模型中继，以 `issuer` URL 标识（如 `https://hub.example.com`）。用户可使用官方 Hub 或自托管。
- **Client**：希望使用 AI 能力的第三方应用。
- **Provider**：上游模型厂商。

## 3. 约定

- `base64url` 指 RFC 4648 §5 的 URL 安全 Base64，**无填充**。
- 随机数必须来自密码学安全随机源（iOS `SecRandomCopyBytes`、Android `SecureRandom`、JS `crypto.getRandomValues`）。
- 文本一律 UTF-8；JSON 字段名使用 `snake_case`。
- 生产环境的 `issuer` 必须为 `https://`；`http://` 仅允许用于 `localhost`、`127.0.0.1` 和局域网开发。

## 4. 能力范围（scope）与模型槽位（slot）

### 4.1 Scope

| scope | 含义 |
| --- | --- |
| `chat` | 调用对话补全（必需） |
| `vision` | 允许请求中包含图片输入 |
| `tools` | 允许 function / tool calling |
| `model_choice` | 允许应用直接点名具体模型 ID（仍需用户在钱包中放行，否则回落到 `default`） |

### 4.2 Slot

| slot | 建议用途 |
| --- | --- |
| `default` | 通用对话（每个授权都包含） |
| `fast` | 低延迟 / 低成本任务：补全、分类、摘要 |
| `reasoning` | 复杂推理、代码 |
| `vision` | 需要看图的任务 |

应用在 `slots` 参数中声明它会用到的槽位；用户为每个槽位选择「跟随全局」或「为该应用单独指定 厂商 + 模型」。

## 5. 发现（Discovery）

`GET {issuer}/.well-known/modelpass-configuration`

```json
{
  "issuer": "https://hub.example.com",
  "protocol_version": "0.1",
  "wallet_authorization_endpoint": "modelpass://authorize",
  "token_endpoint": "https://hub.example.com/oauth/token",
  "device_authorization_endpoint": "https://hub.example.com/oauth/device_authorization",
  "link_endpoint": "https://hub.example.com/v1/link",
  "revocation_endpoint": "https://hub.example.com/oauth/revoke",
  "grant_info_endpoint": "https://hub.example.com/v1/modelpass/grant",
  "api_base": "https://hub.example.com/v1",
  "api_formats_supported": ["openai-chat-completions", "anthropic-messages"],
  "scopes_supported": ["chat", "vision", "tools", "model_choice"],
  "slots_supported": ["default", "fast", "reasoning", "vision"],
  "grant_types_supported": ["authorization_code", "urn:ietf:params:oauth:grant-type:device_code"],
  "code_challenge_methods_supported": ["S256"]
}
```

客户端应当（SHOULD）在换取令牌前读取该文档；也可以（MAY）直接使用约定路径 `{issuer}/oauth/token`。

## 6. 同设备授权（App 跳转，Authorization Code + PKCE）

适用于第三方应用与钱包安装在同一台手机上。整体是标准 OAuth 2.0 授权码流程，**唯一的差别是 Hub 不是预先已知的**：
用户可能使用任意（含自托管的）Hub，钱包在回调中通过 `iss` 参数（RFC 9207）告诉应用去哪个 Hub 换取令牌。

```
Client                                Wallet                                  Hub (iss)
  │ 生成 state、code_verifier             │                                        │
  │── modelpass://authorize?... ────────▶│                                        │
  │                                      │ 校验请求、展示授权页、生物识别确认         │
  │                                      │── 创建授权（封存凭据，见 §10）──────────▶│
  │◀── redirect_uri?code&state&iss ──────│                                        │
  │ 校验 state 与 iss                                                              │
  │── POST {iss}/oauth/token (code + code_verifier) ─────────────────────────────▶│
  │◀──────────────────────────────────── access_token + api_base + slots ─────────│
  │── POST {api_base}/chat/completions  Authorization: Bearer <token> ───────────▶│ ──▶ Provider
```

### 6.1 授权请求

应用打开钱包入口：

- 自定义 Scheme：`modelpass://authorize?<参数>`
- 通用链接（规划中）：`https://modelpass.app/authorize?<参数>`（钱包未安装时打开网页引导安装 / 扫码）

| 参数 | 必需 | 说明 |
| --- | --- | --- |
| `response_type` | 是 | 固定 `code` |
| `client_id` | 是 | 应用标识，推荐使用 iOS Bundle ID / Android 包名，如 `com.example.chat` |
| `redirect_uri` | 是 | 回调地址。推荐应用声明的 HTTPS 通用链接 / App Link；也可使用私有 scheme（RFC 8252 §7.1，如 `com.example.chat:/modelpass/callback`） |
| `scope` | 是 | 空格分隔，至少包含 `chat` |
| `state` | 是 | ≥128 bit 随机值（base64url） |
| `code_challenge` | 是 | `base64url(SHA256(ASCII(code_verifier)))`，`code_verifier` 为 43–128 个字符（推荐 32 字节随机数的 base64url） |
| `code_challenge_method` | 是 | 固定 `S256` |
| `slots` | 否 | 空格分隔的槽位，默认 `default` |
| `client_name` | 否 | 显示名称。未在 Hub 注册的应用会被标记为「未验证」 |
| `budget_hint` | 否 | 建议的每日 token 额度，如 `200000`，用户可修改 |

钱包必须：拒绝缺少 PKCE 或 `code_challenge_method` 不是 `S256` 的请求；对已注册应用校验 `redirect_uri` 与注册值一致；
对未注册应用醒目展示 `redirect_uri` 及「未验证」警告。

### 6.2 授权响应（钱包 → 应用）

成功：

```
{redirect_uri}?code=<code>&state=<state>&iss=<urlencoded issuer>
```

失败（参数同 RFC 6749 §4.1.2.1）：

```
{redirect_uri}?error=access_denied&error_description=...&state=<state>
```

`error` 取值：`access_denied`、`invalid_request`、`unsupported_response_type`、`invalid_scope`、`server_error`、`temporarily_unavailable`。

应用必须：校验 `state`；校验 `iss` 是合法 URL（生产环境须为 `https`）；**应当**向用户展示正在连接的 Hub（非默认 Hub 时尤其重要，见 §13）。

### 6.3 令牌请求

`POST {iss}/oauth/token`，`Content-Type: application/x-www-form-urlencoded`

| 参数 | 说明 |
| --- | --- |
| `grant_type` | `authorization_code` |
| `code` | 回调中的 `code` |
| `redirect_uri` | 与授权请求一致 |
| `client_id` | 与授权请求一致 |
| `code_verifier` | PKCE 原文 |

授权码有效期 120 秒，只能使用一次。

### 6.4 令牌响应（Token Response）

```json
{
  "access_token": "mpk_3wq6oX8d...",
  "token_type": "Bearer",
  "expires_in": 2592000,
  "scope": "chat tools",
  "grant_id": "g_9xKc2...",
  "sub": "u2b1c...",
  "issuer": "https://hub.example.com",
  "api_base": "https://hub.example.com/v1",
  "api_formats": ["openai-chat-completions", "anthropic-messages"],
  "slots": [
    { "id": "default", "label": "默认" },
    { "id": "fast", "label": "快速" }
  ]
}
```

- `access_token`：格式 `mpk_` + base64url(32 字节随机数)。应用应把它当作不透明字符串，并保存在 Keychain / Keystore。
- `expires_in`：仅当用户为该授权设置了有效期时出现；过期后需重新授权。v0.1 不签发 refresh token，授权的生命周期完全由用户在钱包中控制。
- `sub`：对 `(用户, client_id)` 稳定的匿名标识（不同应用拿到的值不同，无法跨应用关联）。
- `slots[].model` / `slots[].provider`：仅当用户允许「向应用展示模型名称」时出现。

错误响应遵循 RFC 6749 §5.2：`{"error":"invalid_grant","error_description":"..."}`。

## 7. 跨设备授权（扫码，Link Flow）

适用于电脑网页、平板、电视、桌面应用等，用手机上的钱包「扫码授权」。在 RFC 8628 设备授权的基础上，令牌通过二维码中的一次性密钥 **端到端加密** 传递——
发起方使用的 Hub（称为 rendezvous，汇合点）只转交密文，既读不到令牌，也无法伪造。

```
Client(电脑)                      Rendezvous Hub                  Wallet(手机)            用户的 Hub
 │ 生成 32B 随机数 s                 │                               │                        │
 │ link_verifier = b64u(HMAC(s,…))   │                               │                        │
 │── POST /oauth/device_authorization (link_challenge) ─────────────▶│                        │
 │◀── device_code, user_code ────────│                               │                        │
 │ 显示二维码: {rv}/link#v=1&uc=…&s=…│                               │                        │
 │                                   │◀── GET /v1/link/{uc} ─────────│ 扫码                    │
 │                                   │                               │── 创建授权 ───────────▶│
 │                                   │◀── POST complete(verifier, sealed) 用 s 加密的令牌响应    │
 │── POST /oauth/token (device_code) 轮询 ──────────────────────────▶│                        │
 │◀── modelpass_sealed ──────────────│                               │                        │
 │ 用 s 解密 → 得到 §6.4 的令牌响应，之后直接访问用户的 Hub                                        │
```

### 7.1 发起

客户端生成 `s`（32 字节随机数），并计算：

```
link_verifier  = base64url( HMAC-SHA256(key = s, msg = "modelpass/v1/link-verifier") )
link_challenge = base64url( SHA256( ASCII(link_verifier) ) )        // 与 PKCE S256 的变换相同
```

`POST {rendezvous}/oauth/device_authorization`（form 编码）：

| 参数 | 必需 | 说明 |
| --- | --- | --- |
| `client_id` | 是 | 同 §6.1 |
| `scope` | 是 | 同 §6.1 |
| `slots` | 否 | 同 §6.1 |
| `client_name` | 否 | 同 §6.1 |
| `link_challenge` | 是 | 见上 |
| `link_challenge_method` | 是 | `S256` |

响应：

```json
{
  "device_code": "dc_…",
  "user_code": "BCDF-GHJK",
  "verification_uri": "https://hub.example.com/link",
  "expires_in": 600,
  "interval": 2
}
```

### 7.2 二维码

```
{verification_uri}#v=1&uc={user_code}&s={base64url(s)}
```

`s` 放在 URL **片段（#）** 中，系统相机打开网页时片段不会发送给服务器。网页会引导打开钱包：
`modelpass://link?rv={urlencoded rendezvous}&uc={user_code}&s={base64url(s)}`。钱包内置扫码可直接解析这两种格式。
客户端应同时展示 `user_code`，供用户在钱包中核对。

### 7.3 钱包查询与同意

`GET {rendezvous}/v1/link/{user_code}` →

```json
{
  "user_code": "BCDF-GHJK",
  "client_id": "dev.modelpass.webdemo",
  "client_name": "ModelPass Web Demo",
  "client": { "verified": true, "name": "…", "icon": "…", "homepage": "…" },
  "scope": "chat",
  "slots": ["default"],
  "status": "pending",
  "expires_at": 1767225600
}
```

用户同意后，钱包在**自己的 Hub** 上创建授权（§10），得到令牌响应 `T`（与 §6.4 结构相同），然后：

```
K      = HKDF-SHA256(ikm = s, salt = "modelpass/v1", info = "link-seal", L = 32)
nonce  = 12 字节随机数
AAD    = "modelpass/v1/link/" + user_code（去掉连字符、转大写，如 BCDFGHJK）
sealed = base64url( nonce ‖ AES-256-GCM(K, nonce, UTF8(JSON(T)), AAD) )   // 密文末尾附 16 字节 tag
```

`POST {rendezvous}/v1/link/{user_code}/complete`（JSON）：`{"link_verifier": "...", "sealed": "..."}`。
Rendezvous 校验 `base64url(SHA256(ASCII(link_verifier))) == link_challenge` 后保存密文（只接受一次）。
用户拒绝时调用 `POST {rendezvous}/v1/link/{user_code}/deny`，body `{"link_verifier": "..."}`。

### 7.4 轮询

`POST {rendezvous}/oauth/token`（form 编码）：`grant_type=urn:ietf:params:oauth:grant-type:device_code&device_code=…&client_id=…`

- 等待中：HTTP 400 `{"error":"authorization_pending"}`；轮询过快：`{"error":"slow_down"}`
- 用户拒绝：`{"error":"access_denied"}`；过期：`{"error":"expired_token"}`
- 成功：HTTP 200 `{"modelpass_sealed": "<sealed>"}`，客户端用 `s` 解密得到 `T`。

安全性：rendezvous 只知道 `link_challenge` 与 `link_verifier`（HMAC 的单向结果），不知道 `s`，因此既无法解密令牌，也无法伪造一个客户端能接受的密文。

## 8. 调用模型

### 8.1 Base URL 与认证

- Base URL：令牌响应中的 `api_base`（例如 `https://hub.example.com/v1`）
- 认证：`Authorization: Bearer <access_token>`（为兼容 Anthropic SDK，也接受 `x-api-key: <access_token>`）

因此任何 OpenAI / Anthropic SDK 都可以直接使用：

```ts
const openai = new OpenAI({ baseURL: session.api_base, apiKey: session.access_token })
await openai.chat.completions.create({ model: 'default', messages: [{ role: 'user', content: '你好' }] })
```

### 8.2 `GET /v1/models`

返回该授权可用的槽位（以及用户放行的具体模型）：`{"object":"list","data":[{"id":"default","object":"model","owned_by":"modelpass"}, …]}`

### 8.3 `POST /v1/chat/completions`

OpenAI Chat Completions 兼容（含 `stream: true` 的 SSE、tools、图片输入）。`model` 字段解析规则：

1. 等于已授权的槽位 ID（或 `modelpass/<slot>`）→ 使用该槽位的路由；
2. 授权包含 `model_choice` 且用户放行了该模型 ID → 使用对应厂商的该模型；
3. 其他任何值（包括应用写死的 `gpt-4o-mini` 等）→ 回落到 `default` 槽位，并返回响应头 `x-modelpass-fallback: true`。

规则 3 保证「原本写死某个模型的应用」接入后也能工作，模型由用户决定。

Hub 会把请求转换为上游所需的格式（OpenAI 兼容、Anthropic Messages、OpenAI Responses），并把结果转换回 Chat Completions 格式。

### 8.4 `POST /v1/messages`

Anthropic Messages 兼容。当路由到的上游原生支持 Anthropic 协议时直接透传；否则返回 `400 unsupported_format`（v0.1）。

### 8.5 响应头

| Header | 说明 |
| --- | --- |
| `x-modelpass-slot` | 实际使用的槽位 |
| `x-modelpass-fallback` | `true` 表示请求的模型未匹配，已回落到 `default` |
| `x-modelpass-model` / `x-modelpass-provider` | 实际模型 / 厂商（仅当用户允许展示时）。厂商名可能含中文，HTTP 头只能是 ASCII，因此 `x-modelpass-provider` 使用 percent-encoding（UTF-8，等同 `encodeURIComponent`） |
| `x-modelpass-budget-remaining` | 今日剩余 token 额度（设置了额度时） |

### 8.6 `GET /v1/modelpass/grant`

返回当前授权的信息，便于应用展示「已连接」状态：

```json
{
  "grant_id": "g_…", "client_id": "com.example.chat", "scope": "chat tools", "status": "active",
  "slots": [{ "id": "default", "label": "默认", "model": "deepseek-flash", "provider": "DeepSeek" }],
  "budget": { "tokens_per_day": 200000, "requests_per_day": null, "tokens_used_today": 5120, "requests_today": 7 },
  "created_at": 1767225600, "expires_at": null
}
```

### 8.7 错误

与 OpenAI 错误格式一致：`{"error":{"message":"…","type":"modelpass_error","code":"<code>"}}`

| HTTP | code | 含义 / 应用应如何处理 |
| --- | --- | --- |
| 401 | `invalid_token` | 令牌无效：清除会话，重新授权 |
| 401 | `grant_revoked` / `grant_expired` | 用户已撤销 / 已过期：提示重新连接 |
| 403 | `grant_paused` | 用户暂停了该应用：提示到钱包中恢复 |
| 403 | `insufficient_scope` | 例如未授权 `vision` 却发送图片 |
| 429 | `budget_exceeded` | 超过用户设置的每日额度 |
| 503 | `no_route` | 用户尚未为该槽位配置模型：引导打开钱包 |
| 502 | `upstream_auth_failed` | 用户的厂商 Key 失效：引导到钱包检查 |
| 502 / 4xx | `upstream_error` | 上游错误（原始错误信息透传在 message 中） |

## 9. 撤销与生命周期

- 应用主动断开：`POST {issuer}/oauth/revoke`（form：`token=<access_token>`），始终返回 200（RFC 7009）。
- 用户在钱包中可以：暂停 / 恢复、修改槽位路由、修改额度与有效期、撤销。所有修改**即时生效**，应用无需任何操作。
- 钱包可通过 `modelpass://grants/{grant_id}` 深链打开某个授权的管理页；应用应当提供「在 ModelPass 中管理」入口。

## 10. 凭据封存（Hub 参考实现）

这一节描述钱包与 Hub 之间的私有 API 所使用的密钥设计；第三方应用无需实现。

```
VK (Vault Key)  = 钱包首次启动时生成的 32 字节随机数，只保存在设备 Keychain / Keystore
K_prov          = HKDF(VK, salt="modelpass/v1", info="provider-seal")
sealed_provider = nonce ‖ AES-256-GCM(K_prov, {base_url, api_key, headers…}, AAD="modelpass/v1/provider/{user_id}/{provider_id}")

token           = "mpk_" + base64url(secret)          // secret 为 32 字节随机数，交给第三方应用
token_hash      = base64url(SHA256(ASCII(token)))     // Hub 只保存哈希用于查找
K_wrap          = HKDF(secret, salt="modelpass/v1", info="wrap-vk|{grant_id}")
wrapped_vk      = nonce ‖ AES-256-GCM(K_wrap, VK, AAD="modelpass/v1/grant/{grant_id}")
```

Hub 收到请求时：用 `token_hash` 找到授权 → 用令牌中的 `secret` 解开 `wrapped_vk` 得到 VK → 解密路由命中的厂商凭据 → 转发。

由此得到的性质：

1. **数据库泄露不泄露 Key**：库中只有密文、令牌哈希与被包裹的 VK；
2. **偷到钱包会话也签发不了有效授权**：创建授权需要用 VK 生成 `wrapped_vk`，而 VK 只在手机上；
3. **切换模型 / 轮换 Key 无需应用参与**：钱包用 VK 重新封存厂商凭据，路由是明文配置；
4. **凭据完整性**：`base_url` 也在密文内并由 AEAD 认证，篡改数据库无法把请求重定向到攻击者的服务器。

同设备授权中，授权码同样参与封存：钱包生成 `code`，上传 `SHA256(code)` 与用 `HKDF(code)` 加密的令牌，Hub 只有在应用出示 `code`（并通过 PKCE 校验）时才能解出令牌并返回，之后立即删除。

Hub 在处理请求的那一刻必然能看到明文 Key（它要替用户调用上游），因此 **Hub 运营方需要被信任**；不愿意信任官方 Hub 的用户可以自托管。详见 [architecture.md](./architecture.md)。第三方接入示例见 [integration.md](./integration.md)。

## 11. 厂商连接器与订阅

钱包获取厂商凭据的方式（不影响第三方应用）：

| 连接器 | 状态 | 说明 |
| --- | --- | --- |
| API Key（BYOK） | ✅ | OpenAI、Anthropic、Gemini、DeepSeek、Kimi、智谱、通义、OpenRouter、SiliconFlow、xAI、Groq、Ollama 及任意 OpenAI / Anthropic 兼容服务 |
| OpenRouter 账户授权 | ✅ | OpenRouter 官方 OAuth PKCE，用户登录后自动生成一个由用户控制的 Key |
| ChatGPT 订阅（Plus / Pro / Go） | 🧪 实验 | OpenAI 官方 “Sign in with ChatGPT” 的 plan usage（`chatgpt.tokens.use.direct`），上游为 Responses API |
| Claude Pro / Max 订阅 | ❌ | Anthropic 条款明确禁止在第三方产品中使用订阅 OAuth 令牌 |
| Gemini / Google AI 订阅 | ❌ | 没有官方授权途径 |

详见 [subscriptions.md](./subscriptions.md)。

## 12. 导入链接

服务商可以提供「一键导入到 ModelPass」的链接（类似 CC Switch 的深链导入）：

```
modelpass://import/provider?name=My%20Relay&format=openai-chat&base_url=https%3A%2F%2Fapi.example.com%2Fv1&models=gpt-5.5,gpt-5.4-mini
```

钱包只预填表单，**绝不**在用户确认前保存。可选参数 `api_key` 方便但不推荐（URL 可能被记录）。

## 13. 安全考虑

1. **PKCE 必选**：防止授权码在 App 跳转中被截获后使用。
2. **`iss` 混淆攻击**：自定义 scheme 可能被恶意 App 抢注，伪装成钱包并返回指向恶意 Hub 的 `iss`。缓解措施：
   - 钱包入口优先使用经过域名校验的通用链接 / App Link；
   - 应用应展示「正在连接 {issuer}」，对非默认 Hub 做二次确认；可选地维护受信 Hub 白名单。
3. **应用身份**：iOS 跨开发者无法可靠获取调用方 Bundle ID，因此以 `redirect_uri` 的归属作为应用身份（通用链接 / App Link 由系统校验）。
   Hub 维护已注册应用（名称、图标、redirect_uri），未注册应用在授权页标注「未验证」。后续版本计划引入 App Attest / Play Integrity。
4. **最小权限**：按应用隔离的令牌、scope、槽位、每日额度、有效期；令牌泄露的影响范围被限定在单个授权内，且可即时撤销。
5. **令牌保存**：应用必须将令牌保存在 Keychain / Keystore，不得写入日志。
6. **隐私**：Hub 默认只记录元数据（时间、应用、槽位、模型、token 数、耗时、状态），不记录提示词与回复内容。
7. **扫码授权**：二维码等同于一次性凭证，客户端应在授权完成或超时后立即刷新 / 销毁二维码。

## 14. 按钮规范

- 文案：中文「使用 ModelPass 继续」，英文 “Continue with ModelPass”。
- 图标为 ModelPass 标志，主色 `#5B5BF7`，圆角 ≥ 10pt，高度 ≥ 44pt。
- 未安装钱包时：应用应引导安装，或改用扫码授权（§7）。

## 15. 版本与扩展

- 协议版本通过 discovery 的 `protocol_version` 声明；未知字段必须忽略。
- 规划中：通用链接入口、App Attest / Play Integrity、Embeddings 与图像接口、按金额计的额度、多钱包设备同步、TEE 中继。
