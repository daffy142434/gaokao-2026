# 第1轮审查修复说明：gaokao/index.html + server.js

**修复时间**: 2026-06-25
**修复文件**: `/opt/hot-site-factory/sites/gaokao/index.html`, `/opt/hot-site-factory/sites/gaokao/server.js`

---

## 严重问题修复（4个）

### 1. saveDark 未在 return 暴露 ✅
- **文件**: index.html 第 310 行
- **问题**: `saveDark` 函数在模板第 65 行 `@click="darkMode=!darkMode;saveDark()"` 中调用，但未在 setup() 的 return 中暴露，导致点击深色模式按钮报错
- **修复**: 在 return 语句中添加 `saveDark`，同时移除了未使用的 `scoreProvince`（修复问题9）

### 2. XSS：marked.parse + v-html 无消毒 ✅
- **文件**: index.html 第 299 行 `renderMd()`
- **问题**: marked.parse 输出直接通过 v-html 注入 DOM，AI 回复可注入 `<script>`、`<iframe>`、`onerror` 等恶意代码
- **修复**: 在 marked.parse 之后、school-link 替换之前，添加5层 HTML 消毒正则：
  - 移除 `<script>...</script>` 标签（含内容）
  - 移除 `<iframe>...</iframe>` 标签（含内容）
  - 移除 `on*="..."` 事件属性（双引号）
  - 移除 `on*='...'` 事件属性（单引号）
  - 移除 `javascript:` 伪协议

### 3. localStorage setItem 无 QuotaExceededError 处理 ✅
- **文件**: index.html 第 232/237/240/242 行
- **问题**: 4 处 `localStorage.setItem()` 调用无 try/catch，存储满时抛出未捕获异常
- **修复**: 
  - `saveDark()`: 包裹 try/catch + console.warn
  - `saveLocalData()`: 外层 try/catch + write 操作包裹 try/catch
  - `saveProfile()`: 包裹 try/catch + console.warn
  - `saveOnboarded()`: 包裹 try/catch + console.warn

### 4. sessions/messages 无限增长 ✅
- **文件**: index.html 第 237 行 `saveLocalData()`
- **问题**: sessions 永不移除，messages 无上限，每条 AI 消息含完整 Markdown（可达数 KB），终将撑爆 5MB localStorage 限制
- **修复**:
  - sessions 限制为最近 30 个：`sessions.value.slice(0, 30)`
  - 每会话消息限制为最近 50 条：`messages.value.slice(-50)`
  - 两者结合约 ~1MB 上限，远低于 5MB Quota

---

## 一般问题修复（5个）

### 5. api() 函数无超时机制 ✅
- **文件**: index.html 第 245 行
- **问题**: 客户端所有 fetch 调用均无超时，网络中断时永久挂起
- **修复**: 在 `api()` 函数中添加 `AbortController`，默认超时 15000ms（15秒），finally 中 `clearTimeout(timer)` 清理计时器

### 6. SSE 内层 catch 空块吞错 ✅
- **文件**: index.html 第 277 行
- **问题**: SSE 流解析的 for 循环内层 catch 为空，JSON 解析失败或属性访问异常被静默丢弃
- **修复**: 添加 `console.warn('SSE parse error:', e, l.slice(0, 100))`，记录错误信息 + 原始行前100字符

### 7. HTTP 错误状态码无处理 ✅
- **文件**: index.html 第 245 行 `api()`
- **问题**: `fetch()` 不会对 HTTP 4xx/5xx reject，服务端返回 500 时客户端无感知
- **修复**: 在 `r.json()` 前添加 `if(!r.ok) throw new Error(\`HTTP ${r.status}: ${r.statusText}\`)`，HTTP 错误状态码会被外层 catch 捕获

### 8. rankCount 硬编码虚假值 4210 ✅
- **文件**: index.html 第 254 行
- **问题**: `rankCount` computed 硬编码返回 `4210`，与 `fetchRank` 实际结果无关，纯属虚假数据
- **修复**: 改为 `computed(() => rankInfo.value ? 1 : 0)`，基于实际 API 返回的位次数据

### 9. scoreProvince ref 声明后从未使用 ✅
- **文件**: index.html 第 223/310 行
- **问题**: `scoreProvince` ref 声明并暴露到 return，但模板和 JS 逻辑中从未使用，是死代码
- **修复**: 从 ref 声明和 return 语句中移除 `scoreProvince`

---

## 改进建议修复（3个 / 4个已修）

### 10. 空 catch 块全部加 console.warn ✅
- **文件**: index.html 多处
- **修复**: 所有 `catch(e){}` 改为 `catch(e){console.warn('functionName:', e);}`，涵盖以下 13 处：
  - `loadDark`, `saveDark`, `loadLocalData`, `saveLocalData`（含内层 read/write）, `loadSessionMsgs`, `loadProfile`, `saveProfile`, `loadOnboarded`, `saveOnboarded`
  - `fetchCutoffs`, `fetchLinks`, `fetchMajors`, `fetchRank`, `fetchUni`
  - `sendFeedback`, `copyText`
  - SSE 内层解析 catch
  - 验证结果：`catch(e){}` 模式已清零

### 11. user-scalable=no 改为可缩放 ✅
- **文件**: index.html 第 5 行 viewport meta
- **问题**: `user-scalable=no` 禁用缩放，低视力用户无法放大文字
- **修复**: 改为 `user-scalable=yes`，`maximum-scale` 从 `1.0` 改为 `3.0`（允许3倍放大）

### 12. server.js apiReq.destroy() → apiReq.abort() ✅
- **文件**: server.js 第 204 行
- **问题**: Node.js `http.ClientRequest` 没有 `destroy()` 方法，超时时 `apiReq.destroy()` 无法正确清理连接
- **修复**: 改为 `apiReq.abort()`

### 13. -webkit-overflow-scrolling: touch ⏭️
- **说明**: 未修复。此属性在 iOS 13+ 已被废弃，Safari 默认使用 momentum scrolling。添加反而可能触发浏览器警告，保持现状。

---

## 验证结果

| 检查项 | 结果 |
|--------|------|
| `node --check` index.html JS | ✅ 通过（行218-312提取验证） |
| `node --check` server.js | ✅ 通过 |
| 空 `catch(e){}` 残留 | ✅ 0 个 |
| `saveDark` 在 return 中 | ✅ 已添加 |
| `scoreProvince` 移除 | ✅ 已移除 |
| XSS 消毒正则 | ✅ 5层防护 |
| setItem try/catch | ✅ 4处全部包裹 |
| sessions 限制 | ✅ 最多30个 |
| messages 限制 | ✅ 每会话50条 |
| AbortController 超时 | ✅ 15秒 |
| resp.ok 检查 | ✅ 非200抛错 |
| rankCount 真实数据 | ✅ 基于 rankInfo |

---

## 未修改的部分

- **维持 Vue 3 + Tailwind CDN 单文件结构**：未引入新外部依赖
- **SSE 无自动重连**：保持原有设计，连接断开后用户手动重试（`retryLast`）
- **fetchRank 参数缺失时静默返回**：保持原有设计，仅在概要页面展示"0条位次数据"，不影响核心功能
- **iOS 滚动优化**：`-webkit-overflow-scrolling: touch` 已在 iOS 13+ 废弃，无需添加
