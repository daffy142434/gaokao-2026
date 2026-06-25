# 第2轮代码审查报告：gaokao-2026

**审查时间**: 2026-06-25
**审查范围**: `/opt/hot-site-factory/sites/gaokao/index.html` + `server.js`
**审查依据**: 第1轮审查报告（review-round1.md）+ 修复说明（review-round1-fixes.md）
**审查方法**: 逐条对照第1轮报告的4个严重+5个一般问题，验证修复是否正确实施

---

## 第1轮问题逐条验证

### 严重问题（4个）

---

## 问题1：saveDark 未在 return 暴露 → 修复状态：✅ 通过

**第1轮描述**：`saveDark` 函数在模板第65行 `@click="darkMode=!darkMode;saveDark()"` 中调用，但未在 setup() 的 return 中暴露。

**验证详情**：
- index.html 第310行 return 语句已包含 `saveDark`：
  ```
  return{...,saveDark,saveProfile,saveOnboarded}
  ```
- 同时确认未使用的 `scoreProvince` 已从声明（第222-223行）和 return（第310行）中移除。
- `node --check` 语法验证通过。

**结论**：修复完整正确。

---

## 问题2：marked.parse + v-html 无 XSS 消毒 → 修复状态：⚠️ 部分修复

**第1轮描述**：`renderMd()` 中 `marked.parse()` 输出直接通过 `v-html` 注入 DOM，AI 回复可注入恶意脚本。

**验证详情**：
- index.html 第299行 `renderMd()` 函数已添加5层正则消毒：
  ```javascript
  h=h.replace(/<script[\s\S]*?<\/script>/gi,'');
  h=h.replace(/<iframe[\s\S]*?<\/iframe>/gi,'');
  h=h.replace(/\bon\w+\s*=\s*"[^"]*"/gi,'');
  h=h.replace(/\bon\w+\s*=\s*'[^']*'/gi,'');
  h=h.replace(/javascript\s*:/gi,'');
  ```
- 消毒顺序正确：在 `marked.parse()` 之后、`school-link` 正则替换之前执行。

**残留风险（已知绕过）**：
1. **无引号事件处理器绕过**：`onerror=alert(1)`（无引号）不会被第3/4条正则匹配，因为正则要求 `="..."` 或 `='...'` 格式。
2. **HTML实体编码绕过**：`java&#x73;cript:` 可绕过第5条正则。
3. **嵌套标签绕过**：`<scr<script>ipt>` 可绕过第1条正则（正则匹配第一个 `</script>`）。
4. **其他危险协议**：`data:text/html,<script>...</script>` 未被过滤。

**修复建议**：引入 DOMPurify CDN 替代手写正则消毒：
```html
<script src="https://cdn.jsdelivr.net/npm/dompurify@3/dist/purify.min.js"></script>
```
```javascript
function renderMd(t){
  if(!t)return'';
  try{
    marked.setOptions({breaks:true,gfm:true});
    let h = marked.parse(t);
    h = DOMPurify.sanitize(h, {ALLOWED_TAGS: ['h1','h2','h3','h4','h5','h6','p','br','ul','ol','li','strong','em','code','pre','blockquote','table','thead','tbody','tr','th','td','a','span','hr','img'], ALLOWED_ATTR: ['href','title','class','target']});
    h = h.replace(/(\S{2,6}(大学|学院))/g, '<span class="school-link" title="点击查看院校详情">$1</span>');
    return h;
  }catch(e){return t.replace(/</g,'&lt;');}
}
```

**结论**：常见攻击向量已覆盖，但仍存在绕过路径。建议引入专业消毒库。

---

## 问题3：localStorage setItem 无 QuotaExceededError 处理 → 修复状态：✅ 通过

**第1轮描述**：4处 `localStorage.setItem()` 调用无 try/catch，存储满时抛出未捕获异常。

**验证详情**（逐处核实）：

| 行号 | 函数 | 修复前 | 修复后 |
|------|------|--------|--------|
| 232 | `saveDark()` | 无保护 | `try{...setItem...}catch(e){console.warn(...)}` ✅ |
| 237 | `saveLocalData()` | 无保护 | 外层 try/catch + 内层 read/write 分别 try/catch ✅ |
| 240 | `saveProfile()` | 无保护 | `try{...setItem...}catch(e){console.warn(...)}` ✅ |
| 242 | `saveOnboarded()` | 无保护 | `try{...setItem...}catch(e){console.warn(...)}` ✅ |

**结论**：4处全部正确包裹，修复完整。

---

## 问题4：sessions/messages 无限增长无上限 → 修复状态：⚠️ 部分修复

**第1轮描述**：sessions 永不移除，messages 无上限，终将撑爆 5MB localStorage。

**验证详情**：
- index.html 第237行 `saveLocalData()`：
  - 会话限制：`const trimmedSessions=sessions.value.slice(0,30)` ✅ 最近30个
  - 消息限制：`am[currentSessionId.value]=messages.value.slice(-50)` ✅ 每会话最近50条

**新发现问题 — Orphaned Messages 泄漏**：

`saveLocalData()` 的工作流程：
```javascript
// 第237行
const am={};
// 读出现有全部 messages map（含已删除会话的消息）
Object.assign(am, JSON.parse(r).messages||{});
// 只更新当前会话的消息
am[currentSessionId.value] = messages.value.slice(-50);
// sessions 数组被裁剪到30个
const trimmedSessions = sessions.value.slice(0,30);
// 但 am 中保留了所有历史会话的 messages，永不清除！
localStorage.setItem(LS_KEY, JSON.stringify({
  sessions: trimmedSessions,      // ← 只有30个
  currentSessionId: ...,
  messages: am                    // ← 可能几百个旧会话的消息
}));
```

**影响**：用户每创建一个新会话，即使旧会话从 sessions 列表中移除，其消息数据仍永久保留在 `messages` map 中。假设每会话平均20KB消息数据，300个会话后 messages map 独占 ~6MB，仅 messages 一项就撑爆 5MB 限额。会话限制形同虚设。

**修复建议**：
```javascript
function saveLocalData(){
  try{
    const am={};
    try{
      const r=localStorage.getItem(LS_KEY);
      if(r)Object.assign(am, JSON.parse(r).messages||{});
    }catch(e){console.warn('saveLocalData read:',e);}
    am[currentSessionId.value]=messages.value.slice(-50);
    const trimmedSessions=sessions.value.slice(0,30);
    // ★ 裁剪 messages map，只保留 trimmedSessions 中的会话
    const validIds=new Set(trimmedSessions.map(s=>s.id));
    for(const k of Object.keys(am)){
      if(!validIds.has(k)) delete am[k];
    }
    try{
      localStorage.setItem(LS_KEY, JSON.stringify({...}));
    }catch(e){console.warn('saveLocalData write:',e);}
  }catch(e){console.warn('saveLocalData:',e);}
}
```

**结论**：会话数量限制正确实施，但 orphaned messages 永久泄漏，长期使用后仍会撑爆 localStorage。

---

### 一般问题（5个）

---

## 问题5：客户端 fetch 无超时机制 → 修复状态：❌ 未修复（关键路径）

**第1轮描述**：客户端所有 fetch 调用均无 AbortController 超时，网络异常时永久挂起。

**验证详情**：

1. **`api()` 通用函数**（第245行）：✅ 已添加 AbortController
   ```javascript
   async function api(path,body,timeoutMs=15000){
     const controller=new AbortController();
     const timer=setTimeout(()=>controller.abort(),timeoutMs);
     try{
       const r=await fetch(API+path,{...,signal:controller.signal});
       ...
     }finally{clearTimeout(timer);}
   }
   ```
   覆盖：`fetchCutoffs`、`fetchLinks`、`fetchMajors`、`fetchRank`、`fetchUni`、`sendFeedback`。

2. **`sendMessage()` 中的 chat fetch**（第275行）：❌ **未使用 `api()` 包装，直接裸调 fetch**
   ```javascript
   // 第275行 — 直接 fetch，无 AbortController，无 timeout！
   const resp=await fetch(API+'/chat',{
     method:'POST',
     headers:{'Content-Type':'application/json'},
     body:JSON.stringify({sessionId:...,message:...,history:...})
   });
   ```

**这是最关键的遗漏**：`sendMessage` 是用户最频繁使用的功能，其 fetch 是 SSE 长连接，如果网络中断或服务端无响应，loading 状态将永久锁死（`loading.value=true`），用户只能刷新页面。其他 API 调用（分数线、专业等）可能几秒完成，chat 连接反而最需要超时保护，却没有。

**修复建议**：
```javascript
// 第275行改为
const controller = new AbortController();
const chatTimer = setTimeout(() => controller.abort(), 90000); // 90s for SSE
try {
  const resp = await fetch(API+'/chat', {
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...}),
    signal: controller.signal
  });
  // ...rest of SSE processing...
} finally {
  clearTimeout(chatTimer);
}
```

**结论**：`api()` 函数修复正确，但核心 SSE chat 路径被遗漏——这是用户交互的核心链路，严重程度等同第1轮的问题5。

---

## 问题6：SSE 内层 catch 空块吞错 → 修复状态：✅ 通过

**第1轮描述**：SSE 流解析 for 循环内层 catch 为空，JSON 解析失败被静默丢弃。

**验证详情**：
- index.html 第277行内层 catch：
  ```javascript
  }catch(e){console.warn('SSE parse error:',e,l.slice(0,100));}
  ```
- 记录了错误对象 + 原始行前100字符，便于调试。
- 全文件扫描 `catch(e){}` 空块：**0个残留** ✅

**结论**：修复完整正确。

---

## 问题7：HTTP 错误状态码无处理 → 修复状态：⚠️ 部分修复

**第1轮描述**：`fetch()` 不对 4xx/5xx reject，服务端报错前端无感知。

**验证详情**：

1. **`api()` 函数**（第245行）：✅ 已添加 HTTP 状态检查
   ```javascript
   if(!r.ok)throw new Error(`HTTP ${r.status}: ${r.statusText}`);
   ```
   覆盖：所有通过 `api()` 的调用。

2. **`sendMessage()` chat fetch**（第275行）：❌ **裸调 fetch，无 `r.ok` 检查**
   - 服务端返回 500 等错误时，`fetch` 正常返回 response 对象
   - `resp.body.getReader()` 读到 JSON 错误文本（如 `{"code":500,"error":"..."}`）
   - SSE 解析循环中 `!l.startsWith('data: ')` 跳过所有行
   - 结果：AI 消息内容为空 + `streaming` 在 while 循环结束后被设为 false
   - 用户看到**空白助手气泡**，无任何错误提示

**结论**：`api()` 路径修复正确，但 chat 接口遗漏——影响虽小于问题5（至少不会永久挂起），但仍导致用户得不到任何错误反馈。

---

## 问题8：rankCount 硬编码虚假值 4210 → 修复状态：✅ 通过

**第1轮描述**：`rankCount` computed 硬编码返回 `4210`，与 `fetchRank` 实际结果无关。

**验证详情**：
- index.html 第254行：
  ```javascript
  const rankCount=computed(()=>rankInfo.value?1:0);
  ```
- 基于 `rankInfo` ref（由 `fetchRank` 填充），逻辑正确：有位次数据时显示1条，否则0条。
- 模板第173行正确引用：`{{rankCount}}条位次数据`

**结论**：修复完整正确。

---

## 问题9：scoreProvince ref 声明后从未使用 → 修复状态：✅ 通过

**第1轮描述**：`scoreProvince` ref 声明并暴露到 return，但模板和JS逻辑中从未使用。

**验证详情**：
- 第222-223行 ref 声明中无 `scoreProvince` ✅
- 第310行 return 中无 `scoreProvince` ✅

**结论**：修复完整正确。

---

## 第2轮新发现问题

### 新问题 N1（严重）：sendMessage 裸 fetch 无超时 + 无HTTP状态检查

- **位置**：index.html 第275行
- **描述**：`sendMessage()` 中的 `fetch(API+'/chat',...)` 是裸调，既没有 AbortController 超时，也没有 `r.ok` 检查。
- **与问题5/7的关系**：第1轮的问题5和问题7的修复仅覆盖了 `api()` 函数，但 `sendMessage` 没有复用 `api()`（因为 SSE 流式响应无法简单地用 `api()` 的 `r.json()` 模式处理）。
- **影响**：
  - 网络中断时 loading 永久锁死
  - 服务端返回 500 时用户看到空白助手消息
- **严重程度**：严重。这是用户最核心的交互路径。

### 新问题 N2（一般）：saveLocalData 中 orphaned messages 永久泄漏

- **位置**：index.html 第237行
- **描述**：`saveLocalData()` 限制 sessions 数组为30个，但 `messages` map 中属于已裁剪会话的消息永不清除。
- **影响**：长期使用后 messages map 独占存储空间，5MB 限额仍会被撑爆。
- **建议**：写入前裁剪 messages map，只保留 `trimmedSessions` 中存在的会话ID对应的消息。

### 新问题 N3（改进建议）：XSS 消毒正则存在已知绕过

- **位置**：index.html 第299行
- **描述**：手写正则无法防御无引号事件处理器（`onerror=alert(1)`）、HTML实体编码、嵌套标签等高级绕过。
- **建议**：引入 DOMPurify CDN（仅 ~25KB gzipped），替换手写正则。

---

## 第2轮审查汇总

### 第1轮遗留问题修复率

| 编号 | 问题 | 状态 |
|------|------|------|
| 1 | saveDark 未暴露 | ✅ 通过 |
| 2 | XSS 无消毒 | ⚠️ 部分修复（正则可绕过） |
| 3 | localStorage 无异常处理 | ✅ 通过 |
| 4 | 数据无限增长 | ⚠️ 部分修复（orphaned messages 泄漏） |
| 5 | fetch 无超时 | ❌ 未修复（chat 路径遗漏） |
| 6 | SSE 内层空 catch | ✅ 通过 |
| 7 | HTTP 错误无处理 | ⚠️ 部分修复（chat 路径遗漏） |
| 8 | rankCount 虚假值 | ✅ 通过 |
| 9 | scoreProvince 死代码 | ✅ 通过 |

- **完全修复**：5/9（问题1、3、6、8、9）
- **部分修复**：3/9（问题2、4、7）
- **未修复**：1/9（问题5 — 核心路径遗漏）

### 新发现问题

| 编号 | 问题 | 严重程度 |
|------|------|---------|
| N1 | sendMessage 裸 fetch 无超时+无HTTP检查 | 🔴 严重 |
| N2 | saveLocalData orphaned messages 泄漏 | 🟡 一般 |
| N3 | XSS 正则绕过风险 | 🟢 改进建议 |

**新发现问题**：3 个（1严重 + 1一般 + 1改进）

### 是否建议打回

**是，建议打回**。

**理由**：
1. **问题5（chat fetch 无超时）是第1轮标记的5个"强烈建议修复"问题之一**，修复说明声称已修复但实际只修了 `api()` 函数，遗漏了核心的 `sendMessage` 路径。这是用户最频繁交互的功能，loading 永久锁死会直接导致用户流失。
2. 问题 N1 与问题5同源，但额外暴露了 HTTP 错误静默吞掉的路径。
3. 问题 N2 意味着第1轮最关注的"localStorage 无限增长"问题并未真正解决，只是延缓了爆发时间。

**打回范围**：仅需修复以下3项即可重新提交：
1. **必须**：`sendMessage` 第275行添加 AbortController 超时（建议90s）+ 状态码检查
2. **必须**：`saveLocalData` 中裁剪 orphaned messages
3. **建议**：引入 DOMPurify 替代手写 XSS 正则

---

## 附录：代码一致性检查

- ✅ 命名风格一致（camelCase for JS, kebab-case for HTML attributes）
- ✅ 缩进风格一致
- ✅ try/catch 模式一致（全部使用 `console.warn` 记录）
- ✅ `api()` 函数签名变更（新增 `timeoutMs` 参数）与所有调用点兼容
- ✅ server.js 第204行 `apiReq.destroy()` → `apiReq.abort()` 正确修复
- ✅ viewport meta 第5行 `user-scalable=yes, maximum-scale=3.0` 正确
