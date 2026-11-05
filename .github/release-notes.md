## ModelPass Android 安装包（演示版）

| 文件 | 说明 |
| --- | --- |
| `ModelPass-Wallet-*.apk` | **ModelPass 钱包**：保管你的模型 Key、为各槽位选择模型并一键切换、给应用授权、查看用量与撤销 |
| `ModelPass-DemoChat-*.apk` | **第三方示例应用**：没有任何 API Key，通过「使用 ModelPass 继续」接入你的模型 |
| `SHA256SUMS.txt` | 校验和 |

每个应用提供两种安装包：**`-arm64-v8a.apk`**（体积小，适用于几乎所有在用的手机和 Apple 芯片电脑上的模拟器，推荐）和 **`-universal.apk`**（额外包含 armeabi-v7a / x86_64，适合老旧 32 位手机或 x86 模拟器）。

### 开始使用

1. 在电脑上启动 Hub（手机与电脑连同一个 Wi-Fi）：
   ```bash
   git clone https://github.com/yanboishere/model-pass && cd model-pass
   npm install && npm run hub
   ```
2. 安装并打开 **ModelPass**，填写 Hub 地址 `http://<电脑的局域网 IP>:8787`，创建钱包后点「体验演示模型」（无需真实 Key），或在「模型 → 添加」中填入 DeepSeek / OpenAI / Claude / Gemini 等厂商的 Key。
3. 安装并打开 **Demo Chat** → 「使用 ModelPass 继续」→ 在钱包里允许 → 回到 Demo Chat 开始对话。之后在钱包里切换模型，Demo Chat 立即生效。
4. 也可以在电脑浏览器打开 `http://localhost:8787/demo`，用 ModelPass 右上角「扫码」完成网页授权。

### 说明

- 支持 Android 7.0 及以上。安装时需要允许「安装未知来源的应用」。
- 这是演示版本：APK 使用 Expo 模板自带的调试密钥签名，仅供体验。正式发布请换成自己的签名密钥；更换签名后需要先卸载旧版本再安装。
- Hub 使用 HTTP 局域网地址仅适合本地体验，公开部署请通过 HTTPS（见 README「自托管 Hub」）。
- 协议与架构说明见仓库 `docs/` 目录。
