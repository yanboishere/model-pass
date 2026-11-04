import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { Hono } from 'hono'
import qrcode from 'qrcode-generator'
import { PROTOCOL_VERSION } from '@modelpass/core'
import { issuerOf, type HubDeps } from '../util'

const require = createRequire(import.meta.url)
const QR_JS = readFileSync(require.resolve('qrcode-generator'), 'utf8')

function qrSvg(text: string, cell = 5): string {
  const qr = qrcode(0, 'M')
  qr.addData(text)
  qr.make()
  return qr.createSvgTag({ cellSize: cell, margin: 2, scalable: true })
}

const esc = (s: string) => s.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]!)

const BASE_CSS = `
:root { --brand:#5B5BF7; --brand2:#8B5CF6; --ink:#0F172A; --muted:#64748B; --line:#E2E8F0; --bg:#F6F7FB; }
* { box-sizing:border-box; }
body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Helvetica Neue",Arial,sans-serif; color:var(--ink); background:var(--bg); }
a { color:var(--brand); text-decoration:none; }
.wrap { max-width:980px; margin:0 auto; padding:32px 20px 64px; }
.hero { background:linear-gradient(135deg,var(--brand),var(--brand2)); color:#fff; border-radius:24px; padding:32px; }
.hero h1 { margin:0 0 8px; font-size:30px; letter-spacing:-0.02em; }
.hero p { margin:0; opacity:.9; line-height:1.6; }
.grid { display:grid; grid-template-columns:repeat(auto-fit,minmax(280px,1fr)); gap:16px; margin-top:20px; }
.card { background:#fff; border:1px solid var(--line); border-radius:18px; padding:20px; }
.card h3 { margin:0 0 8px; font-size:16px; }
.muted { color:var(--muted); font-size:14px; line-height:1.6; }
code, .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; font-size:13px; background:#F1F5F9; padding:2px 6px; border-radius:6px; word-break:break-all; }
.btn { display:inline-flex; align-items:center; justify-content:center; gap:8px; background:var(--brand); color:#fff; border:0; border-radius:12px; padding:12px 18px; font-size:15px; font-weight:600; cursor:pointer; white-space:nowrap; }
.btn.secondary { background:#fff; color:var(--ink); border:1px solid var(--line); }
.btn:disabled { opacity:.5; cursor:default; }
.logo { width:22px; height:22px; border-radius:7px; background:rgba(255,255,255,.22); display:inline-grid; place-items:center; font-weight:800; font-size:12px; }
.qr svg { width:220px; height:220px; display:block; }
.pill { display:inline-block; padding:3px 10px; border-radius:999px; background:#EEF2FF; color:var(--brand); font-size:12px; font-weight:600; }
`

const LOGO_SVG = `<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><rect x="2" y="2" width="20" height="20" rx="6" fill="white" fill-opacity=".25"/><path d="M7 16V8l5 4 5-4v8" stroke="white" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`

export function pageRoutes(deps: HubDeps) {
  const app = new Hono()

  app.get('/vendor/qrcode.js', (c) => c.body(QR_JS, 200, { 'content-type': 'application/javascript; charset=utf-8', 'cache-control': 'public, max-age=86400' }))

  app.get('/', (c) => {
    const issuer = issuerOf(c, deps.config)
    const setup = `modelpass://setup?hub=${encodeURIComponent(issuer)}`
    return c.html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ModelPass Hub</title><style>${BASE_CSS}</style></head><body><div class="wrap">
<div class="hero"><h1>ModelPass Hub</h1><p>用你自己的模型登录任何应用 —— 授权服务器 + BYOK 模型中继（OpenAI / Anthropic 兼容）。<br>协议版本 v${PROTOCOL_VERSION} · Issuer <span class="mono" style="background:rgba(255,255,255,.18);color:#fff">${esc(issuer)}</span></p></div>
<div class="grid">
  <div class="card"><h3>📱 连接钱包</h3><p class="muted">在 ModelPass 钱包 App 的「设置 → Hub 地址」中填写：</p><p><code>${esc(issuer)}</code></p><p class="muted">或在钱包中扫描下方二维码：</p><div class="qr">${qrSvg(setup, 4)}</div></div>
  <div class="card"><h3>🌐 网页扫码授权示例</h3><p class="muted">一个不需要任何 API Key 的网页聊天应用：用手机上的 ModelPass 扫码授权后，即可使用你在钱包里配置的模型。</p><p><a class="btn" href="/demo">打开 Web Demo →</a></p><p class="muted">提示：WebCrypto 需要安全上下文，请通过 <code>http://localhost</code> 访问。</p></div>
  <div class="card"><h3>🔌 接入端点</h3><p class="muted">发现文档：<a href="/.well-known/modelpass-configuration">/.well-known/modelpass-configuration</a></p><p class="muted">OpenAI 兼容：<code>${esc(issuer)}/v1/chat/completions</code></p><p class="muted">Anthropic 兼容：<code>${esc(issuer)}/v1/messages</code></p><p class="muted">令牌：<code>/oauth/token</code> · 扫码：<code>/oauth/device_authorization</code></p></div>
</div></div></body></html>`)
  })

  // Landing page for QR codes scanned with the system camera. The secret lives in the URL fragment,
  // which browsers never send to the server; this page only rewrites it into a wallet deep link.
  app.get('/link', (c) => {
    return c.html(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>使用 ModelPass 授权</title><style>${BASE_CSS} .center{max-width:440px;margin:48px auto;text-align:center}</style></head><body>
<div class="wrap center"><div class="card"><div class="hero" style="padding:20px;border-radius:16px">${LOGO_SVG}<h1 style="font-size:22px;margin-top:8px">使用 ModelPass 授权</h1></div>
<p class="muted" style="margin-top:18px">一个应用正在请求使用你在 ModelPass 中配置的模型。</p>
<p>确认码 <span class="pill" id="uc">—</span></p>
<p><a class="btn" id="open" href="#">在 ModelPass 中打开</a></p>
<p class="muted">没有自动跳转？请确认已安装 ModelPass 钱包，或在钱包中点击「扫码授权」直接扫描电脑上的二维码。</p></div></div>
<script>
  var q = new URLSearchParams(location.hash.slice(1));
  var uc = q.get('uc'), s = q.get('s');
  var wallet = new URLSearchParams(location.search).get('wallet') || 'modelpass://link';
  if (uc && s) {
    document.getElementById('uc').textContent = uc;
    var url = wallet + (wallet.indexOf('?') >= 0 ? '&' : '?') + 'rv=' + encodeURIComponent(location.origin) + '&uc=' + encodeURIComponent(uc) + '&s=' + encodeURIComponent(s);
    document.getElementById('open').href = url;
    setTimeout(function () { location.href = url; }, 300);
  }
</script></body></html>`)
  })

  app.get('/demo', (c) => c.html(DEMO_HTML.replace('__PORT__', String(deps.config.port))))

  return app
}

// A complete third-party web client: link flow (QR) with WebCrypto + streaming chat.
const DEMO_HTML = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ModelPass Web Demo</title><style>${BASE_CSS}
.app { max-width:760px; margin:0 auto; padding:24px 16px 40px; }
.top { display:flex; align-items:center; justify-content:space-between; gap:12px; }
.brand { display:flex; align-items:center; gap:10px; font-weight:700; }
.brand .mark { width:34px; height:34px; border-radius:10px; background:linear-gradient(135deg,var(--brand),var(--brand2)); display:grid; place-items:center; }
.login { text-align:center; padding:36px 24px; }
.login h2 { margin:6px 0 6px; font-size:24px; }
.mp-btn { background:#111; color:#fff; border-radius:12px; padding:13px 20px; font-size:16px; font-weight:600; border:0; display:inline-flex; align-items:center; gap:10px; cursor:pointer; }
.mp-btn .mark { width:22px; height:22px; border-radius:7px; background:linear-gradient(135deg,var(--brand),var(--brand2)); display:grid; place-items:center; }
.qrbox { display:none; margin:22px auto 0; }
.qrbox .qr { display:inline-block; padding:14px; background:#fff; border-radius:16px; border:1px solid var(--line); }
.status { margin-top:10px; font-size:14px; color:var(--muted); }
.chat { display:none; }
.bar { display:flex; gap:8px; align-items:center; flex-wrap:wrap; margin:14px 0; }
select, textarea { font:inherit; border:1px solid var(--line); border-radius:12px; padding:10px 12px; background:#fff; }
textarea { width:100%; resize:none; height:52px; }
.msgs { background:#fff; border:1px solid var(--line); border-radius:18px; padding:16px; min-height:320px; max-height:58vh; overflow:auto; }
.msg { margin:10px 0; display:flex; }
.msg .b { padding:10px 14px; border-radius:16px; max-width:85%; white-space:pre-wrap; line-height:1.55; font-size:15px; }
.msg.user { justify-content:flex-end; } .msg.user .b { background:var(--brand); color:#fff; border-bottom-right-radius:6px; }
.msg.ai .b { background:#F1F5F9; border-bottom-left-radius:6px; }
.meta { font-size:12px; color:var(--muted); margin:2px 6px 0; }
.send { display:flex; gap:8px; margin-top:12px; }
.warn { display:none; background:#FEF3C7; color:#92400E; border-radius:12px; padding:10px 14px; font-size:14px; margin-top:14px; }
.links { display:flex; gap:10px; justify-content:center; flex-wrap:wrap; margin-top:12px; }
@media (max-width: 520px) { .app { padding:12px 12px 28px; } .login { padding:22px 14px; } .login h2 { font-size:20px; } .qrbox { margin-top:14px; } }
</style></head><body><div class="app">
<div class="top"><div class="brand"><div class="mark">${LOGO_SVG}</div><div>Web Demo<div class="meta" style="margin:0">一个不需要 API Key 的第三方网页应用</div></div></div><button class="btn secondary" id="logout" style="display:none">断开连接</button></div>
<div class="warn" id="warn">当前页面不是安全上下文（WebCrypto 不可用）。请通过 <b>http://localhost:__PORT__/demo</b> 打开。</div>
<div class="card login" id="login">
  <div class="pill">零配置接入</div>
  <h2>用你自己的模型开始聊天</h2>
  <p class="muted">本应用不会向你索要任何 API Key。<br>点击下方按钮，用手机上的 ModelPass 扫码授权，模型由你在钱包中决定。</p>
  <button class="mp-btn" id="start"><span class="mark">${LOGO_SVG}</span>使用 ModelPass 继续</button>
  <div class="qrbox" id="qrbox"><div class="qr" id="qr"></div>
    <div class="status">打开 ModelPass → 扫码授权，确认码 <span class="pill" id="uc"></span></div>
    <div class="status" id="st">等待扫码…</div>
    <div class="links"><button class="btn secondary" id="copy">复制授权链接</button><a class="btn" id="openWallet" href="#">在本机 ModelPass 中打开</a></div></div>
</div>
<div class="chat" id="chat">
  <div class="bar"><span class="pill" id="conn">已连接</span><label class="muted">槽位 <select id="slot"></select></label><span class="meta" id="model"></span></div>
  <div class="msgs" id="msgs"></div>
  <div class="send"><textarea id="input" placeholder="输入消息，Enter 发送"></textarea><button class="btn" id="sendBtn">发送</button></div>
</div></div>
<script src="/vendor/qrcode.js"></script>
<script>
const CLIENT_ID = 'dev.modelpass.webdemo';
const $ = (id) => document.getElementById(id);
const enc = new TextEncoder();
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
const unb64u = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
let session = JSON.parse(localStorage.getItem('mp.session') || 'null');
let history = [];
let linkUrl = '';
if (!window.isSecureContext || !crypto.subtle) $('warn').style.display = 'block';

async function hmac(keyBytes, msg) {
  const k = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', k, enc.encode(msg));
}
async function openSealed(s, userCode, sealed) {
  const ikm = await crypto.subtle.importKey('raw', s, 'HKDF', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: enc.encode('modelpass/v1'), info: enc.encode('link-seal') }, ikm, { name: 'AES-GCM', length: 256 }, false, ['decrypt']);
  const data = unb64u(sealed);
  const aad = enc.encode('modelpass/v1/link/' + userCode.replace(/[^A-Za-z]/g, '').toUpperCase());
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: data.slice(0, 12), additionalData: aad }, key, data.slice(12));
  return JSON.parse(new TextDecoder().decode(plain));
}

$('start').onclick = async () => {
  $('start').disabled = true;
  const s = crypto.getRandomValues(new Uint8Array(32));
  const verifier = b64u(await hmac(s, 'modelpass/v1/link-verifier'));
  const challenge = b64u(await crypto.subtle.digest('SHA-256', enc.encode(verifier)));
  const form = new URLSearchParams({ client_id: CLIENT_ID, client_name: 'ModelPass Web Demo', scope: 'chat', slots: 'default fast reasoning', link_challenge: challenge, link_challenge_method: 'S256' });
  const res = await fetch('/oauth/device_authorization', { method: 'POST', body: form });
  const da = await res.json();
  if (!res.ok) { $('st').textContent = '发起失败：' + (da.error_description || da.error); $('start').disabled = false; return; }
  linkUrl = da.verification_uri + '#v=1&uc=' + encodeURIComponent(da.user_code) + '&s=' + b64u(s);
  const qr = qrcode(0, 'M'); qr.addData(linkUrl); qr.make();
  $('qr').innerHTML = qr.createSvgTag({ cellSize: 5, margin: 1, scalable: true });
  const qrSize = Math.min(230, window.innerWidth - 120);
  $('qr').querySelector('svg').setAttribute('style', 'width:' + qrSize + 'px;height:' + qrSize + 'px');
  // Same payload as a wallet deep link, for when the wallet is on this very device.
  const walletBase = new URLSearchParams(location.search).get('wallet') || 'modelpass://link';
  $('openWallet').href = walletBase + (walletBase.indexOf('?') >= 0 ? '&' : '?') + 'rv=' + encodeURIComponent(location.origin) + '&uc=' + encodeURIComponent(da.user_code) + '&s=' + b64u(s);
  $('uc').textContent = da.user_code;
  $('qrbox').style.display = 'block';
  let interval = da.interval || 2;
  const deadline = Date.now() + da.expires_in * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, interval * 1000));
    const t = await fetch('/oauth/token', { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:device_code', device_code: da.device_code, client_id: CLIENT_ID }) });
    const body = await t.json();
    if (t.ok && body.modelpass_sealed) {
      session = await openSealed(s, da.user_code, body.modelpass_sealed);
      localStorage.setItem('mp.session', JSON.stringify(session));
      return showChat();
    }
    if (body.error === 'slow_down') interval += 5;
    else if (body.error === 'authorization_pending') $('st').textContent = '等待你在手机上确认…';
    else { $('st').textContent = body.error === 'access_denied' ? '你在 ModelPass 中拒绝了授权' : '二维码已失效，请重试'; $('start').disabled = false; return; }
  }
  $('st').textContent = '二维码已过期，请重试'; $('start').disabled = false;
};
$('copy').onclick = () => { navigator.clipboard.writeText(linkUrl); $('copy').textContent = '已复制 ✓'; };

function showChat() {
  $('login').style.display = 'none'; $('chat').style.display = 'block'; $('logout').style.display = 'inline-flex';
  $('conn').textContent = '已连接 · ' + new URL(session.issuer).host;
  $('slot').innerHTML = session.slots.map((s) => '<option value="' + s.id + '">' + s.label + (s.model ? ' · ' + s.model : '') + '</option>').join('');
  if (!history.length) add('ai', '已通过 ModelPass 连接 🎉 发条消息试试吧。你可以随时在手机上的 ModelPass 里切换这个应用使用的模型。');
}
function add(role, text) {
  const div = document.createElement('div'); div.className = 'msg ' + role;
  const b = document.createElement('div'); b.className = 'b'; b.textContent = text; div.appendChild(b);
  $('msgs').appendChild(div); $('msgs').scrollTop = 1e9; return b;
}
async function send() {
  const text = $('input').value.trim(); if (!text) return;
  $('input').value = ''; add('user', text); history.push({ role: 'user', content: text });
  const bubble = add('ai', '…'); let acc = '';
  try {
    const res = await fetch(session.api_base + '/chat/completions', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + session.access_token },
      body: JSON.stringify({ model: $('slot').value, stream: true, messages: history }) });
    const shown = res.headers.get('x-modelpass-model');
    $('model').textContent = shown ? '模型：' + shown : (res.headers.get('x-modelpass-fallback') ? '已回落到默认槽位' : '');
    if (!res.ok) { const e = await res.json(); bubble.textContent = '⚠️ ' + (e.error && e.error.message || res.status); if (res.status === 401) logout(false); return; }
    const reader = res.body.getReader(); const dec = new TextDecoder(); let buf = '';
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      buf += dec.decode(value, { stream: true });
      let i; while ((i = buf.indexOf('\\n\\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of block.split('\\n')) {
          if (!line.startsWith('data:')) continue; const data = line.slice(5).trim(); if (data === '[DONE]') continue;
          const j = JSON.parse(data); if (j.error) { acc += '\\n⚠️ ' + j.error.message; continue; }
          const d = j.choices && j.choices[0] && j.choices[0].delta; if (d && d.content) { acc += d.content; bubble.textContent = acc; $('msgs').scrollTop = 1e9; }
        }
      }
    }
    history.push({ role: 'assistant', content: acc });
  } catch (e) { bubble.textContent = '⚠️ ' + e.message; }
}
async function logout(revoke = true) {
  if (revoke && session) { try { await fetch(session.issuer + '/oauth/revoke', { method: 'POST', body: new URLSearchParams({ token: session.access_token }) }); } catch {} }
  localStorage.removeItem('mp.session'); location.reload();
}
$('sendBtn').onclick = send;
$('input').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); } };
$('logout').onclick = () => logout(true);
if (session) showChat();
</script></body></html>`
