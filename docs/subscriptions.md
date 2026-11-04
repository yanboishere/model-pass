# 授权「模型厂商订阅」可行吗？（2026 年 11 月调研）

需求是：让用户把自己已经付费的订阅（ChatGPT Plus、Claude Max、Gemini Pro……）授权给第三方应用使用，就像授权 API Key 一样。结论是**只有少数官方开放的渠道可行**，ModelPass 只接入这些官方渠道。

| 厂商 / 订阅 | 结论 | 依据 | ModelPass 的做法 |
| --- | --- | --- | --- |
| **OpenAI · ChatGPT Plus / Pro / Go** | ✅ 官方支持（需注册） | OpenAI 于 2026 年推出「Sign in with ChatGPT」，DevDay（9/29）后开放 *ChatGPT plan usage*：用户授权 `chatgpt.tokens.use.direct` 后，应用可用其套餐额度调用 Responses API。开源项目与本地运行的个人项目可通过动态注册（`client_id=dynamic_agent_client`）直接使用；托管的商业应用需申请。 | 🧪 实验性连接器：钱包完成授权后把令牌用 VK 封存交给 Hub，Hub 以 `store:false`、`stream:true` 调用 Responses API 并自动刷新令牌。**提示**：把套餐额度经 Hub 转给第三方商业应用，可能不符合 OpenAI 对未获批托管应用的限制，建议仅自托管个人使用 |
| **OpenRouter 账户（充值额度）** | ✅ 官方支持 | OpenRouter 提供 OAuth PKCE：用户登录后为应用生成一个由用户控制、可随时删除的 Key，无需注册应用 | ✅ 钱包内「使用 OpenRouter 账户授权」，也支持无回调的手动授权码模式 |
| **Hugging Face（PRO 含每月推理额度）** | ✅ 官方支持（需注册 OAuth 应用） | 「Sign in with HF」提供 `inference-api` scope，代表用户调用 Inference Providers，费用计入用户账户 | 规划中（需要部署方注册 HF OAuth 应用） |
| **GitHub Models / Copilot** | ⚠️ 部分可行 | GitHub Models 提供 OpenAI 兼容接口，所有账户有免费限额，Copilot 套餐提高限额；第三方 OAuth 应用调用 Copilot API 属于受限通道 | 可作为「自定义 OpenAI 兼容」厂商手动接入（PAT），暂不做 OAuth |
| **Anthropic · Claude Pro / Max** | ❌ 明确禁止 | 2026 年 1 月起服务端拦截第三方工具使用订阅 OAuth；2 月写入条款：Free/Pro/Max 的 OAuth 令牌只能用于 Claude Code 与 Claude.ai，不得用于任何其他产品（包括 Agent SDK）；4 月 4 日起订阅不再覆盖第三方工具用量 | 不支持；请使用 Claude Console 的 API Key |
| **Google · Gemini / Google AI Pro / Ultra** | ❌ 没有官方途径 | Gemini API 没有把调用计入用户订阅的 OAuth；把 Gemini CLI 的 OAuth 令牌挪作他用已在 2026 年 2 月遭到封号处理 | 不支持；请使用 AI Studio 的 API Key |
| **国内 Coding Plan**（智谱 GLM、Kimi、MiniMax、百炼、火山方舟、千帆…） | ❌ 不适用 | 套餐额度仅限官方支持的编程工具使用，自建应用、网站、机器人等场景须调用标准 API；违规可能限流或封号 | 不作为预设；请使用各家开放平台的标准 API Key |

## 为什么协议层不直接「转授」订阅？

ModelPass 的核心价值是**用户自己掌控、应用拿不到 Key**。订阅类授权只有在厂商官方提供可委托的令牌（OAuth + 明确的使用条款）时才可行；任何「抽取官方客户端令牌」的做法都会违反条款并让用户账户面临封禁风险，因此 ModelPass 不会实现。

如果未来更多厂商提供类似 *Sign in with ChatGPT* 的官方委托能力，它们可以作为新的「厂商连接器」加入钱包，第三方应用一侧无需任何改动——这正是协议把「应用 ↔ 用户」与「用户 ↔ 厂商」解耦的意义。

## 参考资料

- OpenAI：[Sign in with ChatGPT · open-source token sharing](https://developers.openai.com/siwc/token-sharing-open-source)、[Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[Cookbook: Integrating Sign in with ChatGPT](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)、[Help: Using your ChatGPT plan in other apps](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites)、[The New Stack 报道](https://thenewstack.io/sign-in-with-chatgpt/)
- OpenRouter：[OAuth PKCE](https://openrouter.ai/docs/guides/overview/auth/oauth)
- Hugging Face：[Sign in with Hugging Face](https://huggingface.co/docs/hub/en/oauth)、[Inference Providers pricing](https://github.com/huggingface/hub-docs/blob/main/docs/inference-providers/pricing.md)
- Anthropic 订阅限制的报道：[WinBuzzer](https://winbuzzer.com/2026/02/19/anthropic-bans-claude-subscription-oauth-in-third-party-apps-xcxwbn/)、[AlternativeTo](https://alternativeto.net/news/2026/2/anthropic-officially-bans-using-subscription-authentication-for-third-party-claude-use)、[OpenClaw Report](https://openclaw.report/ecosystem/anthropic-bans-oauth-tokens-third-party-tools)
- Google：[Gemini CLI 认证说明](https://geminicli.com/docs/get-started/authentication/)、[GitHub issue #25685](https://github.com/google-gemini/gemini-cli/issues/25685)
- 智谱：[GLM Coding Plan 常见问题](https://docs.bigmodel.cn/cn/coding-plan/faq)
- GitHub：[GitHub Models 计费](https://docs.github.com/en/enterprise-cloud@latest/billing/concepts/product-billing/github-models)

> 以上信息来自 2026 年 11 月的公开资料，厂商政策变化频繁，接入前请以官方条款为准。
