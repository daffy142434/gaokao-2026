# 第2轮审查修复报告：gaokao-2026

**修复时间**: 2026-06-25
**修复文件**: `/opt/hot-site-factory/sites/gaokao/index.html`
**修复方式**: 精准 patch 编辑，单文件 Vue 3 + Tailwind CDN 结构不变

---

## 修复清单

### ✅ 修复1：sendMessage 添加 AbortController 超时 + HTTP 状态检查（问题5 + N1 + 问题7）

**位置**: `sendMessage()` 函数（第269-280行）

**修复内容**:
1. **第269行**：在 `try` 前添加 `const controller=new AbortController();const chatTimer=setTimeout(()=>controller.abort(),120000);`
   - 120秒超时，适配 SSE 长连接场景
2. **第275行**：fetch 添加 `signal:controller.signal` + HTTP 状态检查 `if(!resp.ok)throw new Error(...)`
3. **第280行**：finally 块首行添加 `clearTimeout(chatTimer);` 确保 timer 必定清除

**修复前**（裸 fetch，无超时，无状态检查）:
```javascript
const resp=await fetch(API+'/chat',{
  method:'POST',headers:{'Content-Type':'application/json'},
  body:JSON.stringify({...})
});
```

**修复后**（AbortController + 120s超时 + HTTP状态检查）:
```javascript
const controller=new AbortController();
const chatTimer=setTimeout(()=>controller.abort(),120000);
try{
  const resp=await fetch(API+'/chat',{
    method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({...}),
    signal:controller.signal
  });
  if(!resp.ok)throw new Error(`HTTP ${resp.status}: ${resp.statusText}`);
  // ... SSE processing ...
}finally{clearTimeout(chatTimer);}
```

**影响**:
- 网络中断时 loading 不再永久锁死（120秒后 abort）
- 服务端返回 4xx/5xx 时抛出明确错误，不再出现空白助手消息
- timer 在正常完成/异常时均被清除，无泄漏

---

### ✅ 修复2：saveLocalData 裁剪 orphaned messages（N2）

**位置**: `saveLocalData()` 函数（第237行）

**修复内容**: 在 `const trimmedSessions=sessions.value.slice(0,30);` 之后，写入 localStorage 之前，添加 orphaned messages 清理逻辑：

```javascript
const validIds=new Set(trimmedSessions.map(s=>s.id));
for(const k of Object.keys(am)){
  if(!validIds.has(k))delete am[k];
}
```

**修复前**:
- sessions 数组裁剪到30个 ✅
- messages map 保留所有历史会话的消息 ❌（永不清除）
- 长期使用后 messages map 撑爆 5MB localStorage 限额

**修复后**:
- sessions 裁剪到30个 ✅
- messages map 同步裁剪，只保留活跃30个会话的消息 ✅
- 旧会话消息在下次 saveLocalData 时自动清除

---

### ✅ 修复3：XSS 消毒正则补充（问题2）

**位置**: `renderMd()` 函数（第299行）

**修复内容**: 在现有5层正则消毒基础上新增3条正则：

1. **无引号事件处理器移除**:
   ```javascript
   h=h.replace(/\bon\w+\s*=\s*[^"'\s][^>\s]*/gi,'');
   ```
   防御：`onerror=alert(1)`、`onload=evil()` 等无引号事件处理器

2. **SVG 标签移除**:
   ```javascript
   h=h.replace(/<svg[\s>][\s\S]*?<\/svg>/gi,'');
   ```
   防御：`<svg/onload=alert(1)>` 等 SVG 命名空间注入

3. **Math 标签移除**:
   ```javascript
   h=h.replace(/<math[\s>][\s\S]*?<\/math>/gi,'');
   ```
   防御：`<math><mtext><table><mglyph>` 等 MathML 绕过

**消毒顺序**（共8层正则）:
```
<script>...</script> → iframe → on*="..." → on*='...' → on*=无引号
→ javascript: → <svg>...</svg> → <math>...</math> → school-link 替换
```

**已知残留风险（明确接受）**:
- HTML实体编码绕过（`java&#x73;cript:`）
- 嵌套标签绕过（`<scr<script>ipt>`）
- data: 协议
- 这些是已知的 WAF 级别绕过，手写正则无法100%防御。如需完全消除风险，建议后续引入 DOMPurify CDN（~25KB gzipped）。

---

## 语法验证

```bash
$ node --check <extracted-js>
SYNTAX OK
```

无语法错误。

---

## 改动统计

| 文件 | 修改行 | 改动类型 |
|------|--------|----------|
| index.html 第269行 | +1行 | 添加 AbortController + timer |
| index.html 第275行 | 修改 | fetch 添加 signal + HTTP 检查 |
| index.html 第280行 | 修改 | finally 添加 clearTimeout |
| index.html 第237行 | +2行 | 添加 orphaned messages 清理 |
| index.html 第299行 | +3条正则 | 添加无引号事件 + svg + math 消毒 |

**总计**: 5处精准 patch，无重写，无外部依赖引入。

---

## 第2轮审查问题修复状态

| 编号 | 问题 | 修复前状态 | 修复后状态 |
|------|------|-----------|-----------|
| 问题5 | fetch 无超时 | ❌ 未修复 | ✅ 已修复 |
| N1 | sendMessage 裸 fetch | 🔴 严重 | ✅ 已修复 |
| 问题7 | HTTP 错误无处理 | ⚠️ 部分修复 | ✅ 已修复 |
| N2 | orphaned messages 泄漏 | 🟡 一般 | ✅ 已修复 |
| 问题2 | XSS 正则绕过 | ⚠️ 部分修复 | ✅ 已加固（已知残留风险已记录） |

**遗留建议**（非阻塞）:
- 引入 DOMPurify CDN 替代手写 XSS 正则（改进建议 N3）
- 补充 data: 协议过滤
