#!/usr/bin/env node
/**
 * 高考志愿填报 AI 助手 — v1.1 SSE流式
 * 端口: 3002
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '../../.env') });
require('dotenv').config({ path: require('path').resolve(__dirname, '.env') });

const express = require('express');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const mysql = require('mysql2/promise');
const { v4: uuidv4 } = require('uuid');
const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3002;

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));
app.disable('x-powered-by');

const chatLimiter = rateLimit({ windowMs: 60000, max: 20, standardHeaders: true });

// ── 数据库 ──
const MYSQL_HOST = process.env.MYSQL_HOST || 'localhost';
const MYSQL_USER = process.env.MYSQL_USER || 'root';
const MYSQL_PASSWORD = process.env.MYSQL_PASSWORD || '';
const MYSQL_DATABASE = process.env.MYSQL_DATABASE || 'gaokao_chat';
let pool = null, dbConnected = false;

async function initDB() {
  try {
    pool = mysql.createPool({ host: MYSQL_HOST, user: MYSQL_USER, password: MYSQL_PASSWORD, database: MYSQL_DATABASE, waitForConnections: true, connectionLimit: 5, charset: 'utf8mb4' });
    const c = await pool.getConnection(); await c.ping(); c.release();
    dbConnected = true; console.log('OK MySQL');
  } catch (e) { console.error('MySQL degraded:', e.message); dbConnected = false; pool = null; }
}

// ── SKILL ──
const SKILL_ENDPOINT = process.env.SKILL_ENDPOINT || 'https://api.deepseek.com/v1/chat/completions';
const SKILL_API_KEY = process.env.SKILL_API_KEY || process.env.DEEPSEEK_API_KEY || '';
const SKILL_MODEL = process.env.SKILL_MODEL || 'deepseek-chat';
const SKILL_TIMEOUT = parseInt(process.env.SKILL_TIMEOUT) || 60000;

// ── 分数线 ──
let scoreData = [];
try { scoreData = JSON.parse(fs.readFileSync(path.join(__dirname, 'scores.json'), 'utf8')); } catch(e) {}

function getScoreSummary() {
  const byProvince = {};
  for (const s of scoreData) {
    if (!s.score) continue;
    const key = s.province;
    if (!byProvince[key]) byProvince[key] = {};
    byProvince[key][s.type + s.batch] = s.score;
  }
  return Object.entries(byProvince).map(([p, batches]) =>
    p + ': ' + Object.entries(batches).map(([k, v]) => k + ':' + v + '分').join(' ')
  ).join('\n');
}

const SPROMPT = `你是高考志愿填报专家，模仿张雪峰老师风格。用第一人称「我」，直白犀利幽默。反问句加压迫感，每答以金句收尾(≤25字加粗)。禁用「或许」「可能」「建议您」。分数不够直说。未提供省份/分数/选科先追问。

**冲稳保推荐格式要求：** 在回复末尾，用以下格式列出推荐院校（每行一个）：
冲：
- 院校名（+分数差 录取概率%）
稳：
- 院校名（-分数差 录取概率%）
保：
- 院校名（-分数差 录取概率%）
分数差：冲=该院校去年录取分比你高多少，稳=你比该院校高多少，保=你比该院校高多少。
未知具体分数差异可标注大致概率。

核心：看中间50%普通毕业生去哪，不是前3%天才。`;

function buildSystemPrompt(ctxNote) {
  let prompt = SPROMPT;
  if (ctxNote) {
    prompt += '\n\n**当前考生信息（已确认）：**' + ctxNote + '\n基于以上信息回答，无需再追问省份/分数/选科。';
  }
  const s = getScoreSummary();
  if (s) prompt += '\n\n**2026年已确认部分省份高考分数线（教育部阳光高考平台）：**\n```\n' + s + '\n```\n基于以上真实数据分析，未列出省份的数据待更新，如实告知。';
  return prompt;
}

// ── 内存降级 ──
const memSessions = new Map(), memMessages = new Map();

// DB helpers
async function saveMsg(sid, role, content) {
  if (dbConnected && pool) {
    try { const [r] = await pool.execute('INSERT INTO chat_messages (session_id,role,content) VALUES (?,?,?)',[sid,role,content]); return r.insertId; } catch(e) {}
  }
  if (!memMessages.has(sid)) memMessages.set(sid, []);
  const msgs = memMessages.get(sid), id = msgs.length + 1;
  msgs.push({ id, session_id: sid, role, content, created_at: new Date().toISOString() });
  return id;
}
async function getMsgs(sid) {
  if (dbConnected && pool) {
    try { const [r] = await pool.execute('SELECT id,role,content,created_at AS createdAt FROM chat_messages WHERE session_id=? ORDER BY id ASC',[sid]); return r; } catch(e) {}
  }
  return (memMessages.get(sid)||[]).map(m => ({ id: m.id, role: m.role, content: m.content, createdAt: m.created_at }));
}
async function createSess(title) {
  const id = uuidv4();
  if (dbConnected && pool) { try { await pool.execute('INSERT INTO chat_sessions (id,title) VALUES (?,?)',[id,title]); } catch(e) {} }
  memSessions.set(id, { id, title, created_at: new Date().toISOString(), updated_at: new Date().toISOString() });
  return id;
}
async function getSess(limit=50) {
  if (dbConnected && pool) {
    try { const [r] = await pool.execute('SELECT id,title,created_at AS createdAt,updated_at AS updatedAt FROM chat_sessions ORDER BY updated_at DESC LIMIT ?',[limit]); return r; } catch(e) {}
  }
  return [...memSessions.values()].sort((a,b)=>new Date(b.updated_at)-new Date(a.updated_at)).slice(0,limit).map(s=>({id:s.id,title:s.title,createdAt:s.created_at,updatedAt:s.updated_at}));
}
async function updateTitle(sid, title) {
  if (dbConnected && pool) { try { await pool.execute('UPDATE chat_sessions SET title=?,updated_at=NOW() WHERE id=?',[title,sid]); } catch(e) {} }
  if (memSessions.has(sid)) { memSessions.get(sid).title = title; memSessions.get(sid).updated_at = new Date().toISOString(); }
}
async function delSess(sid) {
  if (dbConnected && pool) { try { await pool.execute('DELETE FROM chat_sessions WHERE id=?',[sid]); } catch(e) {} }
  memSessions.delete(sid); memMessages.delete(sid);
}

function extractUserInfo(messages) {
  const combined = messages.map(m => m.content).join('\n');
  const info = {};
  const pm = combined.match(/(北京|天津|上海|重庆|河北|山西|辽宁|吉林|黑龙江|江苏|浙江|安徽|福建|江西|山东|河南|湖北|湖南|广东|海南|四川|贵州|云南|陕西|甘肃|青海|台湾|内蒙古|广西|西藏|宁夏|新疆|香港|澳门)(?:省|市|自治区|特别行政区)?/);
  if (pm) info.province = pm[1];
  const sm = combined.match(/(\d{3})\s*分/);
  if (sm) info.score = parseInt(sm[1]);
  const tm = combined.match(/(物理|历史)(?:类|科|组)/);
  if (tm) info.subjectType = tm[1];
  return info;
}

// ── API ──

app.post('/api/gaokao/sessions', async (req, res) => {
  try { res.json({ code: 0, data: { sessionId: await createSess('') } }); }
  catch(e) { res.status(500).json({ code: 500, error: e.message }); }
});

app.get('/api/gaokao/sessions', async (req, res) => {
  try { res.json({ code: 0, data: await getSess(Math.min(parseInt(req.query.limit)||50, 100)) }); }
  catch(e) { res.status(500).json({ code: 500, error: e.message }); }
});

app.get('/api/gaokao/sessions/:sid/messages', async (req, res) => {
  try { res.json({ code: 0, data: await getMsgs(req.params.sid) }); }
  catch(e) { res.status(500).json({ code: 500, error: e.message }); }
});

app.post('/api/gaokao/chat', chatLimiter, async (req, res) => {
  const { sessionId, message, profile } = req.body;
  if (!message || typeof message !== 'string') return res.status(400).json({ code: 400, error: '消息不能为空' });
  if (message.length > 2000) return res.status(400).json({ code: 400, error: '消息过长' });
  const safeMsg = message.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  if (!sessionId) return res.status(400).json({ code: 400, error: '缺少sessionId' });
  if (!SKILL_API_KEY) return res.status(503).json({ code: 503, error: 'AI未配置' });

  try {
    await saveMsg(sessionId, 'user', safeMsg);
    const history = await getMsgs(sessionId);
    const recent = history.slice(-20);
    if (history.length === 1) await updateTitle(sessionId, safeMsg.replace(/\n/g,' ').slice(0,20));

    // 优先用客户端传的profile，其次从消息中提取
    const extractedInfo = extractUserInfo(recent);
    const ctxParts = [];
    if (profile && profile.province) ctxParts.push('省份:' + profile.province);
    else if (extractedInfo.province) ctxParts.push('省份:' + extractedInfo.province);
    if (profile && profile.score) ctxParts.push('分数:' + profile.score + '分');
    else if (extractedInfo.score) ctxParts.push('分数:' + extractedInfo.score + '分');
    if (profile && profile.type) ctxParts.push('选科:' + profile.type);
    else if (extractedInfo.subjectType) ctxParts.push('选科:' + extractedInfo.subjectType + '类');
    const ctxNote = ctxParts.join('，');
    const ctxMsgs = recent.map(m => ({ role: m.role, content: m.content }));

    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });
    res.write('data: ' + JSON.stringify({ type: 'thinking', message: '正在分析…' }) + '\n\n');

    const systemPrompt = buildSystemPrompt(ctxNote);
    const allMessages = [{ role: 'system', content: systemPrompt }, ...ctxMsgs];
    const payload = JSON.stringify({ model: SKILL_MODEL, messages: allMessages, temperature: 0.8, max_tokens: 2048, stream: true });
    const url = new URL(SKILL_ENDPOINT);
    const transport = url.protocol === 'https:' ? https : http;
    const startedAt = Date.now();

    const apiReq = transport.request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + SKILL_API_KEY, 'Accept': 'text/event-stream' },
      timeout: SKILL_TIMEOUT,
    }, (apiRes) => {
      let fullContent = '', buffer = '';
      apiRes.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const data = line.slice(6).trim();
            if (data === '[DONE]') continue;
            try {
              const parsed = JSON.parse(data);
              const delta = parsed.choices?.[0]?.delta;
              if (delta?.content) { fullContent += delta.content; res.write('data: ' + JSON.stringify({ type: 'chunk', content: delta.content }) + '\n\n'); }
            } catch(e) {}
          }
        }
      });
      apiRes.on('end', async () => {
        const elapsed = Date.now() - startedAt;
        try { await saveMsg(sessionId, 'assistant', fullContent); } catch(e) {}
        res.write('data: ' + JSON.stringify({ type: 'done', model: SKILL_MODEL, latency: elapsed }) + '\n\n');
        res.end();
      });
      apiRes.on('error', (err) => { res.write('data: ' + JSON.stringify({ type: 'error', error: 'AI中断: ' + err.message }) + '\n\n'); res.end(); });
    });
    apiReq.on('error', (err) => { res.write('data: ' + JSON.stringify({ type: 'error', error: '连接失败: ' + err.message }) + '\n\n'); res.end(); });
    apiReq.on('timeout', () => { apiReq.abort(); res.write('data: ' + JSON.stringify({ type: 'error', error: '超时(60s)' }) + '\n\n'); res.end(); });
    apiReq.write(payload);
    apiReq.end();
  } catch (e) {
    console.error('Chat error:', e);
    if (!res.headersSent) res.status(500).json({ code: 500, error: e.message });
    else { res.write('data: ' + JSON.stringify({ type: 'error', error: e.message }) + '\n\n'); res.end(); }
  }
});

app.delete('/api/gaokao/sessions/:sid', async (req, res) => {
  try { await delSess(req.params.sid); res.json({ code: 0, message: 'deleted' }); }
  catch(e) { res.status(500).json({ code: 500, error: e.message }); }
});

app.get('/api/gaokao/health', (req, res) => {
  res.json({ code: 0, status: 'ok', mysql: dbConnected ? 'connected' : 'degraded', skill: SKILL_API_KEY ? 'available' : 'degraded', scores: scoreData.filter(s=>s.score).length + '条分数线', uptime: Math.floor(process.uptime()) });
});

// ── 分数线API ──
app.get('/api/gaokao/cutoffs', (req, res) => {
  const province = req.query.province;
  let data = scoreData;
  if (province) data = data.filter(s => s.province === province);
  const available = data.filter(s => s.score !== null && s.score !== undefined);
  const pending = data.filter(s => s.score === null || s.score === undefined);
  res.json({ code: 0, data: { available, pendingProvinces: [...new Set(pending.map(s => s.province))], totalProvinces: [...new Set(scoreData.map(s => s.province))].length, source: '教育部阳光高考平台' } });
});

app.get('/api/gaokao/score-links', (req, res) => {
  try {
    const links = JSON.parse(fs.readFileSync(path.join(__dirname, 'score_links.json'), 'utf8'));
    const province = req.query.province;
    let data = links;
    if (province) data = data.filter(l => l.province === province);
    res.json({ code: 0, data, provinces: [...new Set(links.map(l => l.province))].sort((a,b) => a.localeCompare(b,'zh')) });
  } catch(e) {
    res.json({ code: 0, data: [
      { province: '通用', name: '阳光高考查分', url: 'https://gaokao.chsi.com.cn/z/gkbmfslq/cx.jsp', desc: '教育部官方' },
    ], provinces: ['通用'] });
  }
});

// ── v2.0 新增 API ──

// 一分一段表
let rankData = [];
try { rankData = JSON.parse(fs.readFileSync(path.join(__dirname, 'rank_data.json'), 'utf8')); } catch(e) {}

app.get('/api/gaokao/rank', (req, res) => {
  const { province, type, score } = req.query;
  if (!province || !type) return res.json({ code: 0, data: { provinces: [...new Set(rankData.map(r=>r.province))] } });
  const s = parseInt(score);
  if (isNaN(s)) return res.json({ code: 0, data: [] });
  const matches = rankData.filter(r => r.province===province && r.type===type && r.score===s);
  // 如果精确匹配没有，返回最近的
  if (matches.length > 0) return res.json({ code: 0, data: matches[0] });
  const nearest = rankData.filter(r => r.province===province && r.type===type).sort((a,b)=>Math.abs(a.score-s)-Math.abs(b.score-s))[0];
  res.json({ code: 0, data: nearest || null, note: nearest ? '最近匹配' : '无数据' });
});

// 院校详情
let uniData = [];
try { uniData = JSON.parse(fs.readFileSync(path.join(__dirname, 'university_data.json'), 'utf8')); } catch(e) {}

app.get('/api/gaokao/universities', (req, res) => {
  const { name } = req.query;
  if (!name) return res.json({ code: 0, data: uniData.map(u=>({name:u.name,city:u.city,tags:u.tags})) });
  const match = uniData.filter(u => u.name.includes(name));
  res.json({ code: 0, data: match });
});

// 专业词典
let majorData = [];
try { majorData = JSON.parse(fs.readFileSync(path.join(__dirname, 'major_dict.json'), 'utf8')); } catch(e) {}

app.get('/api/gaokao/majors', (req, res) => {
  const { name, category } = req.query;
  let data = majorData;
  if (name) data = data.filter(m => m.name.includes(name));
  if (category) data = data.filter(m => m.category.includes(category));
  res.json({ code: 0, data, categories: [...new Set(majorData.map(m=>m.category))] });
});

// AI 回复反馈
let feedbackLog = [];
app.post('/api/gaokao/feedback', (req, res) => {
  const { rating, message } = req.body; // rating: "up" | "down"
  const ts = new Date().toISOString();
  feedbackLog.push({ ts, rating, message: (message||'').slice(0, 100) });
  if (feedbackLog.length > 500) feedbackLog = feedbackLog.slice(-500);
  console.log(`[Feedback] ${rating}: ${(message||'').slice(0, 50)}`);
  res.json({ code: 0 });
});

// ── 启动 ──
async function start() {
  await initDB();
  console.log('Scores loaded:', scoreData.filter(s=>s.score).length, 'records');
  app.listen(PORT, () => console.log('gaokao-2026 v1.1 on http://localhost:' + PORT));
}
start().catch(err => { console.error(err); process.exit(1); });
