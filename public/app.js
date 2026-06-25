const { createApp, ref, nextTick, computed, onMounted, watch } = Vue;

createApp({
  setup() {
    const API = '/api/gaokao';
    const LS_KEY = 'gaokao_2026_data';
    const LS_DARK = 'gaokao_dark';

    const currentSessionId = ref(null);
    const sessions = ref([]);
    const messages = ref([]);
    const inputText = ref('');
    const loading = ref(false);
    const error = ref('');
    const showSidebar = ref(false);
    const showCutoffs = ref(false);
    const showMajors = ref(false);
    const showScoreLinks = ref(false);
    const showProvincePopup = ref(false);
    const showTypePopup = ref(false);
    const showOnboarding = ref(false);
    const showUniDetail = ref(null);
    const showShare = ref(false);
    const onboardProvince = ref('');
    const onboardScore = ref('');
    const onboardType = ref('');
    const darkMode = ref(false);
    const cutoffFilter = ref('');
    const majorSearch = ref('');
    const cutoffData = ref({ available: [], pendingProvinces: [], totalProvinces: 0 });
    const scoreLinks = ref({ data: [], provinces: [] });
    const majorData = ref([]);
    const rankInfo = ref(null);
    const profile = ref({ province: '', score: '', type: '' });
    const msgContainer = ref(null);
    const inputEl = ref(null);
    const shareCanvas = ref(null);
    let lastUserMsg = '';
    const examples = [
      '我想学计算机，600分左右能去哪些学校？',
      '想学医的话，5+3和八年制怎么选？',
      '留在省内还是出省？对本省院校比较纠结'
    ];
    const allProvinces = [
      '广东', '江苏', '河北', '重庆', '福建', '天津', '北京', '辽宁',
      '四川', '山东', '河南', '湖南', '湖北', '浙江', '安徽', '上海',
      '江西', '山西', '陕西', '吉林', '黑龙江', '云南', '贵州', '广西',
      '海南', '甘肃', '宁夏', '青海', '西藏', '新疆', '内蒙古'
    ];
    const subjectTypes = ['物理类', '历史类'];

    // ========== 深色模式 ==========
    function loadDark() {
      try {
        const v = localStorage.getItem(LS_DARK);
        darkMode.value = v === 'true';
      } catch (e) { /* ignore */ }
    }
    function saveDark() {
      try { localStorage.setItem(LS_DARK, darkMode.value); } catch (e) { /* ignore */ }
    }
    function toggleDark() { darkMode.value = !darkMode.value; }
    watch(darkMode, (v) => {
      document.documentElement.className = v ? 'dark' : '';
      saveDark();
    }, { immediate: true });

    // ========== localStorage 持久化 ==========
    function loadLocalData() {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (!raw) return;
        const d = JSON.parse(raw);
        sessions.value = d.sessions || [];
        currentSessionId.value = d.currentSessionId || null;
        if (currentSessionId.value) {
          loadSessionMsgs(currentSessionId.value);
          loadSessionProfile(currentSessionId.value);
        }
      } catch (e) { /* ignore */ }
    }
    function saveLocalData() {
      try {
        const allMessages = {};
        const allProfiles = {};
        try {
          const raw = localStorage.getItem(LS_KEY);
          if (raw) {
            const d = JSON.parse(raw);
            Object.assign(allMessages, d.messages || {});
            Object.assign(allProfiles, d.profiles || {});
          }
        } catch (e) { /* ignore */ }
        allMessages[currentSessionId.value] = messages.value.slice(-50);
        if (currentSessionId.value && profile.value.province) {
          allProfiles[currentSessionId.value] = { ...profile.value };
        }

        const trimmedSessions = sessions.value.slice(0, 30);
        const validIds = new Set(trimmedSessions.map(s => s.id));
        Object.keys(allMessages).forEach(k => {
          if (!validIds.has(k)) delete allMessages[k];
        });
        Object.keys(allProfiles).forEach(k => {
          if (!validIds.has(k)) delete allProfiles[k];
        });

        localStorage.setItem(LS_KEY, JSON.stringify({
          sessions: trimmedSessions,
          currentSessionId: currentSessionId.value,
          messages: allMessages,
          profiles: allProfiles
        }));
      } catch (e) { /* ignore */ }
    }
    function loadSessionMsgs(sid) {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) {
          const allMessages = JSON.parse(raw).messages || {};
          messages.value = allMessages[sid] || [];
        }
      } catch (e) { /* ignore */ }
    }
    function removeSessionMsgs(sid) {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) {
          const d = JSON.parse(raw);
          if (d.messages) { delete d.messages[sid]; }
          localStorage.setItem(LS_KEY, JSON.stringify(d));
        }
      } catch (e) { /* ignore */ }
    }
    function loadSessionProfile(sid) {
      try {
        const raw = localStorage.getItem(LS_KEY);
        if (raw) {
          const profiles = JSON.parse(raw).profiles || {};
          if (profiles[sid]) profile.value = profiles[sid];
        }
      } catch (e) { /* ignore */ }
    }
    function saveProfile() {
      // 有会话时关联到会话，无会话时暂存内存
      saveLocalData();
    }

    // ========== 新用户引导 (每次新会话触发) ==========
    function checkShowOnboarding() {
      showOnboarding.value = !currentSessionId.value && messages.value.length === 0;
      // 初始化引导表单
      onboardProvince.value = profile.value.province || '';
      onboardScore.value = profile.value.score || '';
      onboardType.value = profile.value.type || '';
    }
    function setOnboardProvince(p) {
      onboardProvince.value = (onboardProvince.value === p ? '' : p);
    }
    function dismissOnboarding() {
      showOnboarding.value = false;
    }
    function finishOnboarding() {
      if (onboardProvince.value) profile.value.province = onboardProvince.value;
      if (onboardScore.value) profile.value.score = String(onboardScore.value);
      if (onboardType.value) profile.value.type = onboardType.value;
      saveProfile();
      if (profile.value.province && profile.value.score) {
        setTimeout(() => fetchRank(), 0);
      }
      showOnboarding.value = false;
    }

    // ========== UI 交互 ==========
    function onProfileChange() {
      saveProfile();
      showProvincePopup.value = false;
      showTypePopup.value = false;
      if (profile.value.province && profile.value.score) {
        setTimeout(() => fetchRank(), 0);
      }
    }
    function toggleSidebar() { showSidebar.value = !showSidebar.value; }
    function closeSidebar() { showSidebar.value = false; }
    function openCutoffs() { showCutoffs.value = true; }
    function closeCutoffs() { showCutoffs.value = false; }
    function openMajors() { showMajors.value = true; }
    function closeMajors() { showMajors.value = false; }
    function closeUniDetail() { showUniDetail.value = null; }
    function toggleScoreLinks() { showScoreLinks.value = !showScoreLinks.value; }
    function toggleProvincePopup() { showProvincePopup.value = !showProvincePopup.value; showTypePopup.value = false; showScoreLinks.value = false; }
    function toggleTypePopup() { showTypePopup.value = !showTypePopup.value; showProvincePopup.value = false; showScoreLinks.value = false; }
    function closeAllDropdowns() { showProvincePopup.value = false; showTypePopup.value = false; showScoreLinks.value = false; }
    function selectProvince(p) { profile.value.province = p; onProfileChange(); }
    function selectType(t) { profile.value.type = t; onProfileChange(); }
    function toggleCutoffFilter(p) { cutoffFilter.value = (cutoffFilter.value === p ? '' : p); }
    function setMajorSearch(c) { majorSearch.value = c; }
    function selectSession(sid) { loadSession(sid); closeSidebar(); }
    function onShiftEnter() { inputText.value += '\n'; }

    // ========== 分享 ==========
    function openShare() { showShare.value = true; nextTick(() => drawShareCard()); }
    function closeShare() { showShare.value = false; }

    function drawShareCard() {
      const canvas = shareCanvas.value;
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const w = 400, h = 560;
      canvas.width = w;
      canvas.height = h;

      // 背景
      const gradient = ctx.createLinearGradient(0, 0, 0, h);
      gradient.addColorStop(0, '#eff6ff');
      gradient.addColorStop(1, '#ffffff');
      ctx.fillStyle = gradient;
      ctx.fillRect(0, 0, w, h);

      // 顶部装饰条
      ctx.fillStyle = '#2563eb';
      ctx.fillRect(0, 0, w, 8);

      let y = 40;

      // 标题
      ctx.fillStyle = '#1e3a5f';
      ctx.font = 'bold 24px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('雪峰AI · 高考志愿填报', w / 2, y);
      y += 35;

      // 副标题
      ctx.fillStyle = '#6b7280';
      ctx.font = '13px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.fillText('张雪峰风格智能志愿分析助手', w / 2, y);
      y += 30;

      // 分割线
      ctx.strokeStyle = '#e5e7eb';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(30, y);
      ctx.lineTo(w - 30, y);
      ctx.stroke();
      y += 25;

      // 用户信息
      if (profile.value.province) {
        ctx.fillStyle = '#374151';
        ctx.font = '14px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.textAlign = 'center';
        const info = profile.value.province + ' ' + profile.value.type + ' ' + profile.value.score + '分' +
          (rankInfo.value ? ' (位次' + rankInfo.value.rank + ')' : '');
        ctx.fillText(info, w / 2, y);
        y += 25;
      }

      // 推荐结果
      const allCards = [];
      for (const m of messages.value) {
        if (m.role === 'assistant' && m._cards && m._cards.length > 0) {
          allCards.push(...m._cards);
        }
      }

      if (allCards.length > 0) {
        ctx.fillStyle = '#1f2937';
        ctx.font = 'bold 16px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText('推荐院校', 30, y);
        y += 25;

        const colors = { '冲': '#dc2626', '稳': '#2563eb', '保': '#16a34a' };
        const bgColors = { '冲': '#fef2f2', '稳': '#eff6ff', '保': '#f0fdf4' };
        const labels = { '冲': '冲刺', '稳': '稳妥', '保': '保底' };

        for (const card of allCards.slice(0, 6)) {
          const color = colors[card.type] || '#6b7280';
          const bgColor = bgColors[card.type] || '#f9fafb';

          ctx.fillStyle = bgColor;
          ctx.fillRect(30, y - 5, w - 60, 32);
          ctx.strokeStyle = color;
          ctx.lineWidth = 1.5;
          ctx.strokeRect(30, y - 5, w - 60, 32);

          ctx.fillStyle = color;
          ctx.font = 'bold 11px "PingFang SC","Microsoft YaHei",sans-serif';
          ctx.fillText(labels[card.type], 40, y + 15);

          ctx.fillStyle = '#1f2937';
          ctx.font = '13px "PingFang SC","Microsoft YaHei",sans-serif';
          ctx.fillText(card.name, 80, y + 15);

          if (card.probability) {
            ctx.fillStyle = color;
            ctx.font = '11px "PingFang SC","Microsoft YaHei",sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(card.probability, w - 40, y + 15);
            ctx.textAlign = 'left';
          }
          y += 35;
        }
      } else {
        ctx.fillStyle = '#9ca3af';
        ctx.font = '13px "PingFang SC","Microsoft YaHei",sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('打开雪峰AI，输入你的分数和意向', w / 2, y);
        ctx.fillText('获取个性化冲/稳/保志愿推荐', w / 2, y + 22);
        y += 50;
      }

      // 底部
      y = Math.max(y + 20, h - 60);
      ctx.strokeStyle = '#e5e7eb';
      ctx.beginPath();
      ctx.moveTo(30, y);
      ctx.lineTo(w - 30, y);
      ctx.stroke();
      y += 25;

      ctx.fillStyle = '#9ca3af';
      ctx.font = '11px "PingFang SC","Microsoft YaHei",sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('扫码体验雪峰AI高考志愿填报', w / 2, y);
      y += 18;
      ctx.fillText('gaokao-2026 · 高考志愿不迷路', w / 2, y);
    }

    function downloadShare() {
      const canvas = shareCanvas.value;
      if (!canvas) return;
      canvas.toBlob(blob => {
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = '雪峰AI志愿推荐_' + new Date().toISOString().slice(0, 10) + '.png';
        a.click();
      }, 'image/png');
    }

    // ========== API 请求 ==========
    function api(path, body, timeoutMs = 15000) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      const options = {
        signal: controller.signal,
        ...(body ? {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body)
        } : {})
      };

      return fetch(API + path, options)
        .then(r => {
          clearTimeout(timer);
          if (!r.ok) throw new Error('HTTP ' + r.status + ': ' + r.statusText);
          return r.json();
        })
        .catch(e => {
          clearTimeout(timer);
          throw e;
        });
    }

    function fetchCutoffs() {
      api('/cutoffs')
        .then(d => { if (d.code === 0) cutoffData.value = d.data; })
        .catch(e => console.warn('fetchCutoffs:', e));
    }
    function fetchLinks() {
      api('/score-links')
        .then(d => { if (d.code === 0) scoreLinks.value = d; })
        .catch(e => console.warn('fetchLinks:', e));
    }
    function fetchMajors() {
      api('/majors')
        .then(d => { if (d.code === 0) majorData.value = d.data; })
        .catch(e => console.warn('fetchMajors:', e));
    }
    function fetchRank() {
      const pv = profile.value;
      if (!pv.province || !pv.type || !pv.score) return;
      api('/rank?province=' + pv.province + '&type=' + pv.type + '&score=' + pv.score)
        .then(d => { if (d.code === 0 && d.data) rankInfo.value = d.data; })
        .catch(e => console.warn('fetchRank:', e));
    }
    function fetchUni(name) {
      api('/universities?name=' + encodeURIComponent(name))
        .then(d => { if (d.code === 0 && d.data.length > 0) showUniDetail.value = d.data[0]; })
        .catch(e => console.warn('fetchUni:', e));
    }

    // ========== 会话删除 ==========
    function deleteSession(sid, e) {
      if (e) e.stopPropagation();
      if (!confirm('确定删除这条对话记录吗？')) return;

      // 调用后端删除
      fetch(API + '/sessions/' + sid, { method: 'DELETE' })
        .catch(e => console.warn('deleteSession API:', e));

      // 从列表中移除
      sessions.value = sessions.value.filter(s => s.id !== sid);

      // 清除消息缓存
      removeSessionMsgs(sid);

      // 如果删除的是当前会话，开启新会话
      if (currentSessionId.value === sid) {
        newChat(true);
      }
    }

    // ========== 计算属性 ==========
    const cutoffCount = computed(() => (cutoffData.value.available || []).length);
    const rankCount = computed(() => rankInfo.value ? 1 : 0);
    const cutoffProvinces = computed(() => {
      const names = (cutoffData.value.available || []).map(s => s.province);
      return [...new Set(names)].sort();
    });
    const cutoffPending = computed(() => cutoffData.value.pendingProvinces || []);
    const filteredCutoffs = computed(() => {
      const all = cutoffData.value.available || [];
      const filtered = cutoffFilter.value
        ? all.filter(s => s.province === cutoffFilter.value)
        : all;

      const by = {};
      for (const s of filtered) {
        const k = s.province + '|' + s.type;
        if (!by[k]) {
          by[k] = { province: s.province, type: s.type, special: null, ug: null, college: null };
        }
        if (s.batch === '特控线') by[k].special = s.score;
        else if (s.batch === '本科线' || s.batch === '一段线') by[k].ug = s.score;
        else if (s.batch === '专科线' || s.batch === '二段线') by[k].college = s.score;
      }
      return Object.values(by).sort((a, b) =>
        a.province.localeCompare(b.province, 'zh') || a.type.localeCompare(b.type, 'zh')
      );
    });
    const scoreProvinces = computed(() => scoreLinks.value.provinces || []);
    const majorCategories = computed(() => majorData.value.categories || []);
    const filteredMajors = computed(() => {
      let d = majorData.value.data || majorData.value;
      if (Array.isArray(d) && majorSearch.value) {
        d = d.filter(m => m.name.includes(majorSearch.value) || m.category.includes(majorSearch.value));
      }
      return Array.isArray(d) ? d.slice(0, 20) : [];
    });

    // ========== 冲稳保卡片解析 ==========
    function parseRecommendations(content) {
      if (!content) return [];
      const results = [];

      const patterns = [
        { regex: /(?:冲(?:刺)?[：:]\s*|(?:🔴|🟥|🚀)\s*冲(?:刺)?[：:]\s*)([\s\S]*?)(?=(?:稳(?:妥)?[：:]|保(?:底)?[：:]|$))/i, type: '冲' },
        { regex: /(?:稳(?:妥)?[：:]\s*|(?:🔵|🟦|💙)\s*稳(?:妥)?[：:]\s*)([\s\S]*?)(?=(?:冲(?:刺)?[：:]|保(?:底)?[：:]|$))/i, type: '稳' },
        { regex: /(?:保(?:底)?[：:]\s*|(?:🟢|🟩|💚)\s*保(?:底)?[：:]\s*)([\s\S]*?)$/i, type: '保' }
      ];

      for (const { regex, type } of patterns) {
        const match = content.match(regex);
        if (match) {
          const lines = match[1].split(/[\n,，、;；]/).filter(Boolean);
          for (const line of lines) {
            const trimmed = line.trim();
            const schoolMatch = trimmed.match(/(\S{2,8}(?:大学|学院))/);
            const diffMatch = trimmed.match(/([-+]\d{1,3})\s*分/);
            const probMatch = trimmed.match(/(\d{2,3})\s*%/);

            if (schoolMatch) {
              results.push({
                type,
                name: schoolMatch[1],
                diff: diffMatch ? diffMatch[1] : '',
                probability: probMatch ? probMatch[1] + '%' : ''
              });
            }
          }
        }
      }

      if (results.length === 0) {
        const chongIdx = content.search(/冲(?:刺)?[：:]/);
        const wenIdx = content.search(/稳(?:妥)?[：:]/);
        const baoIdx = content.search(/保(?:底)?[：:]/);

        if (chongIdx >= 0 || wenIdx >= 0 || baoIdx >= 0) {
          const extractSchools = (text, type) => {
            const schoolRegex = /(?:^|\n)\s*[-•\d.]*\s*(\S{2,8}(?:大学|学院))\s*(?:[-+]\d{1,3}\s*分\s*)?(?:(\d{2,3})\s*%\s*)?/gm;
            let m;
            while ((m = schoolRegex.exec(text)) !== null) {
              results.push({ type, name: m[1], diff: '', probability: m[2] ? m[2] + '%' : '' });
            }
          };

          if (chongIdx >= 0) {
            const end = wenIdx > chongIdx ? wenIdx : (baoIdx > chongIdx ? baoIdx : undefined);
            extractSchools(content.slice(chongIdx, end), '冲');
          }
          if (wenIdx >= 0) {
            const end = baoIdx > wenIdx ? baoIdx : undefined;
            extractSchools(content.slice(wenIdx, end), '稳');
          }
          if (baoIdx >= 0) {
            extractSchools(content.slice(baoIdx), '保');
          }
        }
      }

      return results;
    }

    // ========== SSE 聊天 ==========
    function sendMessage() {
      const text = inputText.value.trim();
      if (!text || loading.value) return;

      // 检查省份/分数/类型是否已填写
      if (!profile.value.province || !profile.value.score || !profile.value.type) {
        checkShowOnboarding();
        return;
      }

      error.value = '';
      inputText.value = '';
      lastUserMsg = text;
      loading.value = true;

      if (!currentSessionId.value) {
        const sid = crypto.randomUUID ? crypto.randomUUID() : 's_' + Date.now();
        currentSessionId.value = sid;
        sessions.value.unshift({
          id: sid,
          title: text.replace(/\n/g, ' ').slice(0, 20),
          updatedAt: new Date().toISOString()
        });
      }
      saveLocalData();

      const uLid = Date.now();
      messages.value.push({ _lid: uLid, role: 'user', content: text });
      nextTick(() => scrollBottom());

      const aLid = Date.now() + 1;
      messages.value.push({
        _lid: aLid,
        role: 'assistant',
        content: '',
        streaming: true,
        thinking: '正在分析...',
        _cards: []
      });
      nextTick(() => scrollBottom());

      const controller = new AbortController();
      const chatTimer = setTimeout(() => controller.abort(), 120000);

      const hist = messages.value
        .filter(m => !m._lid || m._lid < aLid)
        .slice(-21, -1)
        .map(m => ({ role: m.role, content: m.content }));

      if (profile.value.province && profile.value.score) {
        let sysMsg = profile.value.province + ' ' + profile.value.type + ' ' + profile.value.score + '分';
        if (rankInfo.value) sysMsg += '（位次约' + rankInfo.value.rank + '名）';
        hist.unshift({ role: 'system', content: '用户已设置：' + sysMsg });
      }
      hist.push({ role: 'user', content: text });

      fetch(API + '/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: currentSessionId.value,
          message: text,
          history: hist,
          profile: profile.value.province ? profile.value : null
        }),
        signal: controller.signal
      })
        .then(resp => {
          if (!resp.ok) throw new Error('HTTP ' + resp.status + ': ' + resp.statusText);
          const reader = resp.body.getReader();
          const dec = new TextDecoder();
          let buf = '';
          let firstChunk = true;

          function cleanup() {
            clearTimeout(chatTimer);
            loading.value = false;
            const ai = messages.value.find(m => m._lid === aLid);
            if (ai && ai.content) {
              ai._cards = parseRecommendations(ai.content);
            }
            const si = sessions.value.find(x => x.id === currentSessionId.value);
            if (si) si.updatedAt = new Date().toISOString();
            saveLocalData();
            nextTick(() => scrollBottom());
          }

          function processLine(line) {
            if (!line.startsWith('data: ')) return;
            try {
              const d = JSON.parse(line.slice(6));
              const ai = messages.value.find(m => m._lid === aLid);
              if (!ai) return;

              if (d.type === 'thinking') {
                ai.thinking = d.message;
              } else if (d.type === 'chunk') {
                if (firstChunk) { ai.thinking = ''; firstChunk = false; }
                ai.content += d.content;
              } else if (d.type === 'done') {
                ai.streaming = false;
                ai.model = d.model;
                ai.latency = d.latency;
              } else if (d.type === 'error') {
                ai.streaming = false;
                ai.content += '\n\n' + d.error;
                error.value = d.error;
              }
              nextTick(() => scrollBottom());
            } catch (e) {
              console.warn('SSE parse error:', e, line.slice(0, 100));
            }
          }

          function processLines(idx, lines) {
            if (idx >= lines.length) { pump(); return; }
            processLine(lines[idx]);
            processLines(idx + 1, lines);
          }

          function pump() {
            reader.read().then(result => {
              if (result.done) {
                const ai = messages.value.find(m => m._lid === aLid);
                if (ai) ai.streaming = false;
                cleanup();
                return;
              }
              buf += dec.decode(result.value, { stream: true });
              const lines = buf.split('\n');
              buf = lines.pop() || '';
              processLines(0, lines);
            }).catch(e => {
              if (e.name === 'AbortError') {
                error.value = '请求超时，请重试';
              } else {
                error.value = '连接失败: ' + e.message;
              }
              const ai = messages.value.find(m => m._lid === aLid);
              if (ai) { ai.streaming = false; ai.content += '\n\n连接中断'; }
              cleanup();
            });
          }

          pump();
        })
        .catch(e => {
          if (e.name === 'AbortError') {
            error.value = '请求超时(120s)，请重试';
          } else if (e.message.includes('HTTP 503')) {
            error.value = 'AI服务未配置，请检查API密钥';
          } else if (e.message.includes('HTTP 429')) {
            error.value = '请求太频繁，请稍后再试';
          } else {
            error.value = '连接失败: ' + e.message;
          }
          const ai = messages.value.find(m => m._lid === aLid);
          if (ai) { ai.streaming = false; ai.content += '\n\n' + error.value; }
          clearTimeout(chatTimer);
          loading.value = false;
          const si = sessions.value.find(x => x.id === currentSessionId.value);
          if (si) si.updatedAt = new Date().toISOString();
          saveLocalData();
          nextTick(() => scrollBottom());
        });
    }

    function retryLast() {
      if (!lastUserMsg) return;
      inputText.value = lastUserMsg;
      nextTick(() => sendMessage());
    }
    function newChat(skipOnboarding) {
      currentSessionId.value = null;
      messages.value = [];
      error.value = '';
      rankInfo.value = null;
      profile.value = { province: '', score: '', type: '' };
      nextTick(() => {
        scrollBottom();
        if (!skipOnboarding) checkShowOnboarding();
      });
    }
    function loadSession(sid) {
      currentSessionId.value = sid;
      error.value = '';
      showOnboarding.value = false;
      loadSessionMsgs(sid);
      loadSessionProfile(sid);
      nextTick(() => scrollBottom());
    }
    function quickStart(t) {
      inputText.value = t;
      nextTick(() => {
        if (inputEl.value) { inputEl.value.focus(); autoResize(); }
      });
    }
    function gotoScore(p) {
      const links = (scoreLinks.value.data || []).filter(x => x.province === p);
      if (links.length > 0) {
        showScoreLinks.value = false;
        window.open(links[0].url, '_blank', 'noopener');
      }
    }
    function sendFeedback(msg, rating) {
      msg.feedback = rating;
      api('/feedback', { rating, message: msg.content.slice(0, 100) })
        .catch(e => console.warn('sendFeedback:', e));
    }
    function exportForm() {
      const lines = [];
      lines.push('高考志愿填报参考表');
      lines.push('生成时间：' + new Date().toLocaleString());
      if (profile.value.province) {
        lines.push('省份：' + profile.value.province + ' ' + (profile.value.type || '') +
          ' ' + (profile.value.score ? profile.value.score + '分' : '') +
          (rankInfo.value ? ' 位次：' + rankInfo.value.rank : ''));
      }
      lines.push('---');
      for (const m of messages.value) {
        if (m.role === 'assistant') lines.push(m.content);
      }
      const blob = new Blob([lines.join('\n\n')], { type: 'text/plain;charset=utf-8' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = '志愿填报参考_' + new Date().toISOString().slice(0, 10) + '.txt';
      a.click();
    }
    function handleMsgClick(e) {
      const t = e.target;
      if (t.classList.contains('school-link')) fetchUni(t.textContent);
    }

    // ========== UI 工具 ==========
    function scrollBottom() {
      nextTick(() => {
        if (msgContainer.value) msgContainer.value.scrollTop = msgContainer.value.scrollHeight;
      });
    }
    function autoResize() {
      const el = inputEl.value;
      if (!el) return;
      el.style.height = 'auto';
      el.style.height = Math.min(el.scrollHeight, 128) + 'px';
    }
    function fmtTime(ts) {
      if (!ts) return '';
      const d = new Date(ts);
      const diff = Date.now() - d;
      if (diff < 60000) return '刚刚';
      if (diff < 3600000) return Math.floor(diff / 60000) + '分钟前';
      if (diff < 86400000) return Math.floor(diff / 3600000) + '小时前';
      return d.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' });
    }
    function renderMd(t) {
      if (!t) return '';
      try {
        marked.setOptions({ breaks: true, gfm: true });
        let h = marked.parse(t);
        h = h.replace(/<script[\s\S]*?<\/script>/gi, '');
        h = h.replace(/<iframe[\s\S]*?<\/iframe>/gi, '');
        h = h.replace(/\bon\w+\s*=\s*"[^"]*"/gi, '');
        h = h.replace(/\bon\w+\s*=\s*'[^']*'/gi, '');
        h = h.replace(/\bon\w+\s*=\s*[^"'\s][^>\s]*/gi, '');
        h = h.replace(/javascript\s*:/gi, '');
        h = h.replace(/<svg[\s>][\s\S]*?<\/svg>/gi, '');
        h = h.replace(/<math[\s>][\s\S]*?<\/math>/gi, '');
        h = h.replace(/(\S{2,6}(大学|学院))/g,
          '<span class="school-link" title="点击查看院校详情">$1</span>');
        return h;
      } catch (e) {
        return t.replace(/</g, '&lt;');
      }
    }
    function copyText(t) {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(t).catch(() => fallbackCopy(t));
      } else {
        fallbackCopy(t);
      }
    }
    function fallbackCopy(t) {
      const ta = document.createElement('textarea');
      ta.value = t;
      ta.style.position = 'fixed';
      ta.style.left = '-9999px';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
    }

    // ========== 初始化 ==========
    onMounted(() => {
      loadDark();
      loadLocalData();

      // 首次加载时检查是否显示引导
      checkShowOnboarding();

      Promise.all([fetchCutoffs(), fetchLinks(), fetchMajors()]).then(() => {
        if (profile.value.province && profile.value.score) fetchRank();
      });

      if (sessions.value.length > 0 && currentSessionId.value) {
        loadSession(currentSessionId.value);
      }

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          showSidebar.value = false;
          showCutoffs.value = false;
          showMajors.value = false;
          showScoreLinks.value = false;
          showProvincePopup.value = false;
          showTypePopup.value = false;
          showShare.value = false;
        }
      });
    });

    return {
      currentSessionId, sessions, messages, inputText, loading, error,
      showSidebar, showCutoffs, showMajors, showScoreLinks,
      showProvincePopup, showTypePopup, showOnboarding, showUniDetail, showShare,
      darkMode, cutoffFilter, majorSearch,
      cutoffData, cutoffCount, rankCount, cutoffProvinces, cutoffPending, filteredCutoffs,
      scoreLinks, scoreProvinces, majorData, majorCategories, filteredMajors,
      rankInfo, profile, allProvinces, subjectTypes,
      msgContainer, inputEl, examples, shareCanvas,
      onboardProvince, onboardScore, onboardType,
      sendMessage, retryLast, newChat, loadSession, quickStart, gotoScore,
      sendFeedback, exportForm, handleMsgClick,
      scrollBottom, autoResize, fmtTime, renderMd, copyText,
      fetchRank, saveProfile, dismissOnboarding, checkShowOnboarding, finishOnboarding, setOnboardProvince,
      toggleDark, toggleSidebar, closeSidebar,
      openCutoffs, closeCutoffs, openMajors, closeMajors, closeUniDetail,
      toggleScoreLinks, toggleProvincePopup, toggleTypePopup,
      closeAllDropdowns, selectProvince, selectType,
      toggleCutoffFilter, setMajorSearch,
      selectSession, onShiftEnter, onProfileChange,
      deleteSession,
      openShare, closeShare, drawShareCard, downloadShare
    };
  }
}).mount('#app');
