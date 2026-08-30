/* FlowEnglish - content orchestrator
 * 流程：用户点击 flowenglish 按钮才激活；
 * 缓存(bv+page) → B 站原生英文字幕 → 无字幕时弹确认，用户同意后才采集音频调 ASR。
 */
(function (global) {
  'use strict';

  var FE = (global.FlowEnglish = global.FlowEnglish || {});
  var util = FE.util;

  if (global.__flowenglishBooted) return;
  global.__flowenglishBooted = true;

  var MSG = FE.MSG;

  /* ================= 状态 ================= */
  var S = {
    panel: null,
    pageInfo: null,       // {bvid,page,cid,title,partTitle,subtitleList}
    record: null,         // 当前视频缓存记录
    activated: false,
    video: null,
    loop: { on: false, idx: -1, a: 0, b: 0 },
    config: null,
    asrCtrl: null,
    asrRunning: false,
    asrStopTime: null,      // ASR 停止位置（续传用）
    quiz: null,
    translating: false,
    observers: []
  };

  /* ================= 与 background 通信 ================= */
  function bg(type, payload) {
    return new Promise(function (resolve) {
      var msg = Object.assign({ type: type }, payload || {});
      try {
        chrome.runtime.sendMessage(msg, function (res) {
          if (chrome.runtime.lastError) {
            resolve({ ok: false, error: chrome.runtime.lastError.message });
          } else {
            resolve(res || { ok: false, error: 'empty response' });
          }
        });
      } catch (e) {
        resolve({ ok: false, error: String(e && e.message || e) });
      }
    });
  }

  /* ================= 页面信息 ================= */
  function onProbeState(e) {
    var info = e.detail;
    if (!info || !info.bvid) return;
    var changed = !S.pageInfo ||
      S.pageInfo.bvid !== info.bvid ||
      S.pageInfo.page !== info.page;
    S.pageInfo = info;
    if (S.panel) S.panel.setPageInfo(info);
    if (changed) onVideoChanged();
  }

  document.addEventListener('flowenglish:state', onProbeState);

  function fallbackPageInfo() {
    var m = location.pathname.match(/BV[0-9A-Za-z]{10}/);
    if (!m) return null;
    var p = location.search.match(/[?&]p=(\d+)/);
    return {
      bvid: m[0],
      page: p ? +p[1] : 1,
      cid: null,
      title: document.title.replace(/_哔哩哔哩_bilibili.*$/, ''),
      partTitle: '',
      pages: [],
      subtitleList: []
    };
  }

  function ensureInfo() {
    if (S.pageInfo && S.pageInfo.bvid) return S.pageInfo;
    S.pageInfo = fallbackPageInfo();
    return S.pageInfo;
  }

  /* ================= 视频元素 ================= */
  function findVideo() {
    return document.querySelector('#bilibili-player video') ||
      document.querySelector('.bpx-player-video-wrap video') ||
      document.querySelector('#playerWrap video') ||
      document.querySelector('video');
  }

  function bindVideo() {
    var v = findVideo();
    if (v === S.video) return v;
    if (S.video) unbindVideo();
    S.video = v;
    if (!v) return null;
    v.addEventListener('timeupdate', onTimeUpdate);
    v.addEventListener('ended', onTimeUpdate);
    return v;
  }

  function unbindVideo() {
    if (!S.video) return;
    S.video.removeEventListener('timeupdate', onTimeUpdate);
    S.video.removeEventListener('ended', onTimeUpdate);
    S.video = null;
  }

  function onTimeUpdate() {
    if (!S.video) return;
    var t = S.video.currentTime || 0;
    if (S.panel) S.panel.syncTime(t);
    if (S.loop.on && S.loop.b > S.loop.a && t > S.loop.b + 0.35) {
      S.video.currentTime = S.loop.a;
    }
  }

  /* ================= 锚点与挂载（防抖防重复） ================= */
  function findAnchor() {
    var player = document.querySelector('#bilibili-player');
    if (player) return { el: player, mode: 'after' };
    var wrap = document.querySelector('#playerWrap');
    if (wrap) return { el: wrap, mode: 'append' };
    var alt = document.querySelector('.player-wrap') || document.querySelector('.bpx-player-container');
    if (alt) return { el: alt, mode: 'after' };
    return null;
  }

  /* ============ 挂载（永不放弃：B 站播放区会反复动态重建） ============ */
  function rootEl() { return document.getElementById('flowenglish-root'); }

  function isVideoPage() { return /^\/video\//.test(location.pathname); }

  function tryMount() {
    if (rootEl() && rootEl().isConnected) return true;
    if (!isVideoPage()) return false;
    var anchor = findAnchor();
    if (!anchor) return false;
    S.panel = FE.panel.mount(anchor, host);
    if (S.pageInfo) S.panel.setPageInfo(S.pageInfo);
    /* root 被 B 站重建后，恢复此前的学习状态 */
    if (S.activated && S.record && (S.record.cues || []).length) {
      S.panel.setRecord(S.record);
      S.panel.setShowChinese(S.config.ui.showChinese);
      S.panel.openPanel();
      setStatus('学习中 · ' + (S.record.source === 'native' ? 'B站原生字幕' : 'ASR 字幕'), true);
    } else {
      S.panel.setLauncherStatus('未激活 · 点击开启学习模式');
    }
    bindVideo();
    return true;
  }

  var mountTimer = null;
  function ensureMounted() {
    if (rootEl() && rootEl().isConnected) {
      bindVideo();
      return;
    }
    if (tryMount()) return;
    /* 锚点暂不可用：退避重试，不设上限 */
    clearTimeout(mountTimer);
    mountTimer = setTimeout(ensureMounted, 800);
  }

  var remount = util.debounce(ensureMounted, 250);

  var mo = new MutationObserver(function () { remount(); });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  /* 兜底轮询：MutationObserver 偶发漏报时也能自愈 */
  setInterval(function () {
    if (isVideoPage() && (!rootEl() || !rootEl().isConnected)) {
      ensureMounted();
    }
  }, 2000);

  /* ================= 学习流程 ================= */
  function onVideoChanged() {
    stopAsrInternal();
    S.record = null;
    S.activated = false;
    S.asrStopTime = null;
    S.quiz = null;
    S.loop = { on: false, idx: -1, a: 0, b: 0 };
    if (S.panel && S.panel.root && S.panel.root.isConnected) {
      S.panel.closePanel();
      S.panel.setAsr(null);
      S.panel.setRecord(null);
      S.panel.setTranslateNotice(null);
      S.panel.setLauncherStatus('未激活 · 点击开启学习模式');
    }
  }

  function setStatus(text, active) {
    if (S.panel) S.panel.setLauncherStatus(text, { active: !!active });
  }

  function enterLearning(rec) {
    S.record = rec;
    S.activated = true;
    setStatus('学习中 · ' + (rec.source === 'native' ? 'B站原生字幕' : 'ASR 字幕'), true);
    if (S.panel) {
      S.panel.setRecord(rec);
      S.panel.setShowChinese(S.config.ui.showChinese);
      S.panel.openPanel();
      /* 重新打开视频：ASR 未完成时显示「继续转写」提示条 */
      if (rec.partial && rec.asrStopAt != null) {
        S.panel.setTranslateNotice({ type: 'resume', stopTime: rec.asrStopAt });
      }
    }
    bindVideo();
    if (S.config.ui.showChinese) maybeTranslate();
  }

  function activate() {
    if (!S.config) {
      FE.store.getConfig().then(function (cfg) { S.config = cfg; activate(); });
      return;
    }
    var info = ensureInfo();
    if (!info || !info.bvid) {
      if (S.panel) S.panel.toast('未能识别当前视频，请刷新页面后再试');
      return;
    }
    setStatus('正在准备…', true);

    var bvid = info.bvid, page = info.page || 1;

    /* 第一步：本地缓存 */
    FE.store.getVideo(bvid, page).then(function (cached) {
      if (cached && (cached.cues || []).length) {
        cached.title = cached.title || info.title;
        enterLearning(cached);
        return null;
      }
      /* 第二步：B 站原生英文字幕 */
      return loadNativeSubtitles(bvid, page).then(function (cues) {
        if (cues && cues.length) {
          var rec = util.merge(FE.store.EMPTY(), {
            bvid: bvid, cid: info.cid, page: page,
            title: info.title, partTitle: info.partTitle || '',
            source: 'native', sourceLabel: 'B站原生英文字幕'
          });
          rec.cues = cues;
          return loadZhSubtitle(bvid, page).then(function (zhCues) {
            if (zhCues && zhCues.length) rec.cues = FE.subtitle.alignTranslation(rec.cues, zhCues);
            return FE.store.saveVideo(rec).then(function () { enterLearning(rec); });
          });
        }
        /* 第三步：无英文字幕 -> 用户确认后才 ASR */
        var cfg = S.config;
        var configured = util.asrConfigured(cfg);
        if (S.panel) {
          S.panel.openPanel();
          S.panel.showConfirmAsr({
            bvid: bvid,
            page: page,
            configured: configured,
            onConfirm: function () { runAsr(bvid, page); },
            onGoSettings: function () { bg(MSG.OPEN_OPTIONS, { hash: '#api' }); }
          });
        }
        setStatus('等待你选择：ASR 生成字幕', true);
        return null;
      });
    }).catch(function (err) {
      setStatus('加载失败：' + (err && err.message || err));
    });
  }

  /* ---------------- 原生字幕 ---------------- */
  function fetchSubtitleJson(url) {
    if (!url) return Promise.resolve([]);
    if (url.indexOf('//') === 0) url = 'https:' + url;
    return bg(MSG.FETCH_TEXT, { url: url }).then(function (res) {
      if (!res.ok) throw new Error(res.error || 'fetch failed');
      try { return FE.subtitle.normalizeBili(JSON.parse(res.text)); }
      catch (e) { return []; }
    });
  }

  function loadNativeSubtitles(bvid, page) {
    var info = S.pageInfo || {};
    var list = (info.subtitleList || []);
    function pick() {
      return list.filter(util.isEnglishSubtitle);
    }
    function fromApi() {
      if (!info.cid) return Promise.resolve([]);
      return bg(MSG.BILI_SUBTITLES, { bvid: bvid, cid: info.cid }).then(function (res) {
        if (!res.ok) return [];
        list = res.list || [];
        return pick();
      });
    }
    var en = pick();
    return (en.length ? Promise.resolve(en) : fromApi()).then(function (enList) {
      if (!enList.length) return [];
      // 优先人工字幕（id 较小的通常是人工），AI 字幕（ai-en）放后面
      enList.sort(function (a, b) { return (/^ai-/i.test(a.lan) ? 1 : 0) - (/^ai-/i.test(b.lan) ? 1 : 0); });
      return fetchSubtitleJson(enList[0].url);
    });
  }

  function loadZhSubtitle(bvid, page) {
    var list = (S.pageInfo && S.pageInfo.subtitleList) || [];
    var zh = list.filter(util.isChineseSubtitle);
    if (!zh.length) return Promise.resolve([]);
    return fetchSubtitleJson(zh[0].url).catch(function () { return []; });
  }

  /* ---------------- ASR ---------------- */
  /* opts: { resume: 是否续传(保留已有字幕), startTime: 从该时间点开始采集 } */
  function runAsr(bvid, page, opts) {
    opts = opts || {};
    var cfg = S.config;
    if (!util.asrConfigured(cfg)) {
      if (S.panel) {
        S.panel.showError('还没有配置 ASR 接口地址与 Token。', {
          actions: [
            { label: '取消' },
            { label: '去配置', primary: true, onClick: function () { bg(MSG.OPEN_OPTIONS, { hash: '#api' }); } }
          ]
        });
      }
      return;
    }
    var v = bindVideo();
    if (!v || !FE.capture.isSupported(v)) {
      if (S.panel) S.panel.showError('当前浏览器无法采集页面音频（需要较新版本 Chrome/Edge），请升级后重试。');
      return;
    }
    if (v.readyState < 1) {
      if (S.panel) S.panel.showError('视频还没有开始加载，请先点击播放，再开始采集。');
      return;
    }
    /* 续传：沿用已有记录与字幕；全新：从空记录开始 */
    var rec = opts.resume && S.record
      ? S.record
      : util.merge(FE.store.EMPTY(), {
          bvid: bvid, cid: (S.pageInfo && S.pageInfo.cid) || null, page: page,
          title: (S.pageInfo && S.pageInfo.title) || '',
          partTitle: (S.pageInfo && S.pageInfo.partTitle) || '',
          source: 'asr', sourceLabel: 'ASR 生成', partial: true
        });
    rec.partial = true;
    rec.source = 'asr';
    rec.sourceLabel = 'ASR 生成';
    S.record = rec;
    S.activated = true;
    if (S.panel) S.panel.setRecord(rec);

    var pending = 0;
    var doneSlices = 0;
    var stopped = false;
    /* 工作数组直接使用 rec.cues：新老会话共享同一引用，续传/在途切片不会互相覆盖 */
    rec.cues = opts.resume ? (rec.cues || []) : [];

    /* 从指定位置起播（续传用） */
    if (opts.startTime != null) {
      try { v.currentTime = Math.max(0, opts.startTime); } catch (e) { /* ignore */ }
    }

    function persist() {
      rec.cues = FE.subtitle.dedupeCues(FE.subtitle.sortCues(rec.cues));
      rec.partial = true;
      return FE.store.saveVideo(rec);
    }

    function appendSegments(segments, offset, duration, rawText) {
      if (segments && segments.length) {
        segments.forEach(function (s) {
          var text = String(s.text || '').trim();
          if (!text) return;
          rec.cues.push({
            start: Math.max(0, offset + (+s.start || 0)),
            end: Math.max(0.2, offset + (+s.end || duration)),
            text: text
          });
        });
      } else if (rawText) {
        var sentences = String(rawText).replace(/\s+/g, ' ').trim().split(/(?<=[.!?])\s+/).filter(Boolean);
        if (!sentences.length) sentences = [rawText];
        var per = duration / sentences.length;
        sentences.forEach(function (s, i) {
          rec.cues.push({ start: offset + i * per, end: offset + (i + 1) * per, text: s });
        });
      }
      rec.cues = FE.subtitle.sortCues(rec.cues);
      doneSlices++;
      if (S.asrRunning) updateAsrBar();   // 已停止后不再"复活"进度条
      persist();
      if (S.panel && S.panel.isOpen()) S.panel.setRecord(rec);
    }

    function updateAsrBar(extra) {
      if (!S.panel || !S.asrRunning) return;
      var info = {
        capturedSec: Math.min(v.currentTime || 0, v.duration || 0),
        totalSec: v.duration || 0,
        doneSlices: doneSlices,
        label: 'ASR 转写中（保持本页播放，可随时停止）'
      };
      S.panel.setAsr(Object.assign(info, extra || {}));
    }

    S.asrRunning = true;
    setStatus('ASR 转写中…', true);

    /* 从头开始更完整：如果当前不在 0 附近，提示但继续从当前位置 */
    if (v.currentTime > 5 && S.panel) {
      S.panel.toast('提示：从头开始采集效果最佳，当前从 ' + util.formatTime(v.currentTime) + ' 开始');
    }
    if (v.paused) { v.play().catch(function () { /* 用户手动播 */ }); }

    /* 火山极速版只收 wav/mp3/ogg，强制走 WAV 16k 转码 */
    var audioFormat = cfg.asr.protocol === 'volcano-flash' ? 'wav16k' : cfg.asr.audioFormat;

    S.asrCtrl = FE.capture.start(v, {
      sliceSeconds: util.clamp(+cfg.asr.sliceSeconds || 60, 15, 300),
      format: audioFormat,
      onSlice: function (slice) {
        /* 双保险：过短残片（< 2s）直接丢弃，不送 ASR */
        if (slice.duration < 2) return;
        pending++;
        updateAsrBar({ label: 'ASR 转写中（已上传 ' + pending + ' 段，排队处理）' });
        var work = audioFormat === 'wav16k'
          ? FE.capture.toWav16kBlob(slice.blob).then(function (wav) {
              return util.blobToBase64(wav).then(function (b64) { return { b64: b64, mime: 'audio/wav' }; });
            })
          : util.blobToBase64(slice.blob).then(function (b64) { return { b64: b64, mime: slice.mime }; });

        work.then(function (payload) {
          return bg(MSG.ASR, {
            audio: payload.b64,
            mime: payload.mime,
            offset: slice.offset,
            duration: slice.duration
          });
        }).then(function (res) {
          pending--;
          if (res.ok) {
            updateAsrBar({ error: null });
            appendSegments(res.segments, slice.offset, slice.duration, res.text);
          } else {
            /* 错误持久显示在 ASR 进度条上，不再只靠 4 秒 toast */
            updateAsrBar({ error: res.error || '未知错误', label: '第 ' + slice.seq + ' 段转写失败' });
            if (S.panel && S.asrRunning) {
              S.panel.toast('第 ' + slice.seq + ' 段转写失败：' + (res.error || '未知错误'), 4000);
            }
          }
        }).catch(function () { pending--; });
      },
      onProgress: function () { updateAsrBar(); },
      onDone: function () {
        stopped = true;
        S.asrRunning = false;
        var fin = function () {
          rec.partial = false;
          rec.asrStopAt = null;   // 转写完成，清除续传标记
          rec.cues = FE.subtitle.dedupeCues(FE.subtitle.sortCues(rec.cues));
          FE.store.saveVideo(rec).then(function () {
            if (S.panel) {
              S.panel.setAsr(null);
              S.panel.setRecord(rec);
              S.panel.toast('ASR 完成，字幕已永久缓存');
              S.panel.setTab('subs');
            }
            setStatus('学习中 · ASR 字幕', true);
            /* 生成英文后自动生成中文翻译（需 LLM；完成后自动打开中文显示） */
            maybeTranslate(true);
          });
        };
        setTimeout(fin, 400);
      },
      onError: function (err) {
        S.asrRunning = false;
        if (S.panel) {
          S.panel.setAsr(null);
          S.panel.showError('音频采集失败：' + (err && err.message || err));
        }
        setStatus('ASR 失败，点击重试');
      }
    });
    updateAsrBar();
  }

  function stopAsrInternal() {
    if (S.asrCtrl) {
      try { S.asrCtrl.stop(); } catch (e) { /* ignore */ }
      S.asrCtrl = null;
    }
    S.asrRunning = false;
  }

  /* 续传：从指定时间继续 ASR，保留已有字幕并合并 */
  function resumeAsr(startTime) {
    var info = S.pageInfo || {};
    S.asrStopTime = null;
    if (S.panel) S.panel.setTranslateNotice(null);
    runAsr(info.bvid, info.page, { resume: true, startTime: startTime });
  }

  /* ---------------- 中文翻译 ----------------
   * force=true：ASR 生成英文后自动翻译，翻译完成自动打开中文显示 */
  function maybeTranslate(force) {
    var rec = S.record;
    if (!rec || !(rec.cues || []).length) return;
    if (S.translating) return;
    var missing = rec.cues.filter(function (c) { return !c.zh; });
    if (!missing.length) {
      if (S.panel) S.panel.setTranslateNotice(null);
      if (force) ensureChineseOn();
      return;
    }
    var cfg = S.config;
    var useTranslate = cfg.translate.enabled && cfg.translate.endpoint;
    var useLlm = cfg.llm.enabled && cfg.llm.endpoint && cfg.llm.token;
    if (!useTranslate && !useLlm) {
      if (S.panel) {
        S.panel.setTranslateNotice({ type: 'unconfigured', message: '未配置 LLM 接口，无法生成中文翻译' });
        S.panel.toast('未配置 LLM 接口，无法生成中文翻译（可到「API 配置」填写火山方舟）', 5000);
      }
      return;
    }

    S.translating = true;
    if (S.panel) S.panel.toast('正在生成中文翻译…');
    var chunks = FE.subtitle.chunkCues(missing, 1200, 20);
    var chain = Promise.resolve();
    var failedCount = 0;
    chunks.forEach(function (chunk) {
      chain = chain.then(function () {
        var lines = chunk.map(function (c, i) { return (i + 1) + '. ' + c.text; }).join('\n');
        return bg(MSG.CHAT, {
          purpose: 'translate',
          messages: [
            { role: 'system', content: 'You are a subtitle translator. Translate English subtitle lines into natural Simplified Chinese. Reply with ONLY a JSON array of strings, same order and same count as input. No commentary.' },
            { role: 'user', content: lines }
          ]
        }).then(function (res) {
          if (!res.ok) {
            failedCount++;
            try { console.log('[FE/translate] fail', res.error); } catch (e) { /* ignore */ }
            return;
          }
          var arr = null;
          try { arr = JSON.parse(res.text); }
          catch (e) {
            var m = String(res.text || '').match(/\[[\s\S]*\]/);
            if (m) { try { arr = JSON.parse(m[0]); } catch (e2) { /* ignore */ } }
          }
          if (!Array.isArray(arr)) {
            failedCount++;
            try { console.log('[FE/translate] bad response', String(res.text).slice(0, 300)); } catch (e2) { /* ignore */ }
            return;
          }
          chunk.forEach(function (c, i) {
            if (arr[i]) c.zh = String(arr[i]).trim();
          });
        });
      });
    });
    chain.then(function () {
      S.translating = false;
      rec.updatedAt = Date.now();
      FE.store.saveVideo(rec).then(function () {
        var stillMissing = rec.cues.filter(function (c) { return !c.zh; }).length;
        if (S.panel) {
          S.panel.setRecord(rec);
          if (stillMissing > 0) {
            S.panel.setTranslateNotice({
              type: 'failed',
              message: '有 ' + stillMissing + ' 句中文翻译失败' + (failedCount ? '（' + failedCount + ' 批请求出错）' : ''),
              missing: stillMissing
            });
            S.panel.toast('部分句子翻译失败，可点击提示条重试', 5000);
          } else {
            S.panel.setTranslateNotice(null);
            S.panel.toast('中文翻译完成');
          }
        }
        if (force && stillMissing === 0) ensureChineseOn();
      });
    });
  }

  /* ASR 生成的英文+中文默认直接展示双语 */
  function ensureChineseOn() {
    if (S.config.ui.showChinese) return;
    FE.store.setConfig({ ui: { showChinese: true } }).then(function (cfg) {
      S.config = cfg;
      if (S.panel) S.panel.setShowChinese(true);
    });
  }

  /* ================= host：面板回调 ================= */
  var host = {
    onLauncherClick: function () {
      if (S.asrRunning) { if (S.panel) S.panel.openPanel(); return; }
      /* ASR 未完成（停止过）：提供续传选择 */
      if (S.activated && S.record && S.record.partial && S.asrStopTime != null) {
        if (S.panel) {
          S.panel.openPanel();
          S.panel.confirmResume({
            stopTime: S.asrStopTime,
            currentTime: S.video ? S.video.currentTime : 0,
            onFromStop: function () { resumeAsr(S.asrStopTime); },
            onFromNow: function () { resumeAsr(S.video ? S.video.currentTime : 0); }
          });
        }
        return;
      }
      if (S.activated && S.record && (S.record.cues || []).length) {
        if (S.panel) {
          if (S.panel.isOpen()) S.panel.closePanel();
          else S.panel.openPanel();
        }
        return;
      }
      activate();
    },

    /* 「开始」：有暂停位置先问，否则走标准流程（缓存 → 原生字幕 → ASR） */
    onStart: function () {
      if (S.asrRunning) {
        if (S.panel) S.panel.toast('正在转写中，可点「暂停」停止');
        return;
      }
      var resumeAt = S.asrStopTime != null
        ? S.asrStopTime
        : (S.record && S.record.asrStopAt != null ? S.record.asrStopAt : null);
      if (resumeAt != null && S.activated) {
        if (S.panel) {
          S.panel.openPanel();
          S.panel.confirmResume({
            stopTime: resumeAt,
            currentTime: S.video ? S.video.currentTime : 0,
            onFromStop: function () {
              if (S.record && S.record.partial) {
                resumeAsr(resumeAt);
              } else {
                /* 纯视频暂停：跳到暂停处走标准流程 */
                var v = bindVideo();
                if (v) { v.currentTime = Math.max(0, resumeAt); }
                activate();
              }
            },
            onFromNow: function () {
              if (S.record && S.record.partial) {
                resumeAsr(S.video ? S.video.currentTime : 0);
              } else {
                activate();
              }
            }
          });
        }
        return;
      }
      activate();
    },

    /* 「暂停」：停掉 ASR 采集（如有），同时暂停视频，记录位置 */
    onPause: function () {
      var v = S.video || bindVideo();
      var t = v ? v.currentTime : 0;
      if (S.asrRunning) {
        stopAsrInternal();
        if (S.panel) S.panel.setAsr(null);
      }
      S.asrStopTime = t;
      if (S.record) {
        S.record.asrStopAt = t;
        FE.store.saveVideo(S.record);
      }
      if (v && !v.paused) v.pause();
      if (S.panel) S.panel.toast('已暂停 · ' + util.formatTime(t) + '，点「开始」可继续');
      setStatus('已暂停 · 停在 ' + util.formatTime(t) + '，点「开始」继续');
    },

    collapsePanel: function () { if (S.panel) S.panel.closePanel(); },

    seek: function (t) {
      var v = bindVideo();
      if (!v) return;
      v.currentTime = Math.max(0, t);
      if (v.paused) v.play().catch(function () { /* ignore */ });
    },

    replay: function () {
      var rec = S.record;
      if (!rec) return;
      var t = (S.video && S.video.currentTime) || 0;
      var idx = FE.subtitle.findCueIndex(rec.cues || [], t);
      if (idx < 0) idx = 0;
      host.seek(rec.cues[idx].start);
    },

    toggleLoop: function () {
      var rec = S.record;
      if (!rec) return;
      if (S.loop.on) {
        S.loop = { on: false, idx: -1, a: 0, b: 0 };
      } else {
        var t = (S.video && S.video.currentTime) || 0;
        var idx = FE.subtitle.findCueIndex(rec.cues || [], t);
        if (idx < 0) { if (S.panel) S.panel.toast('当前时间点没有字幕句'); return; }
        var c = rec.cues[idx];
        S.loop = { on: true, idx: idx, a: c.start, b: Math.max(c.end, c.start + 0.5) };
        host.seek(c.start);
      }
      if (S.panel) S.panel.setLoop(S.loop);
    },

    loopCue: function (i) {
      var rec = S.record;
      if (!rec) return;
      if (S.loop.on && S.loop.idx === i) {
        S.loop = { on: false, idx: -1, a: 0, b: 0 };
      } else {
        var c = (rec.cues || [])[i];
        if (!c) return;
        S.loop = { on: true, idx: i, a: c.start, b: Math.max(c.end, c.start + 0.5) };
        host.seek(c.start);
      }
      if (S.panel) S.panel.setLoop(S.loop);
    },

    setShowChinese: function (v) {
      FE.store.setConfig({ ui: { showChinese: v } }).then(function (cfg) {
        S.config = cfg;
        if (S.panel) S.panel.setShowChinese(v);
        if (v) maybeTranslate();
      });
    },

    addMark: function (t, comment) {
      /* 记入笔记 = 该时间点的 英文 + 中文 + 我的评论 */
      var info = S.pageInfo || {};
      var rec = S.record;
      var idx = rec && rec.cues ? FE.subtitle.findCueIndex(rec.cues, t) : -1;
      var cue = idx >= 0 ? rec.cues[idx] : null;
      var lines = ['[' + util.formatTime(t) + ']'];
      if (cue && cue.text) lines.push('EN: ' + cue.text);
      if (cue && cue.zh) lines.push('ZH: ' + cue.zh);
      if (comment) lines.push('备注: ' + comment);
      var notes = ((rec && rec.notes) || []).concat([{
        id: util.uid('n'), start: t, text: lines.join('\n'),
        createdAt: Date.now(), updatedAt: Date.now(), ai: false
      }]);
      FE.store.patchVideo(info.bvid, info.page, { notes: notes }).then(function (r) {
        S.record = r;
        if (S.panel) {
          S.panel.setRecord(r);
          S.panel.toast('已记入笔记');
        }
      });
    },

    /* -------- 生词 -------- */
    addWord: function (word, context, start) {
      var info = S.pageInfo || {};
      var words = (S.record && S.record.words) || [];
      if (words.some(function (w) { return w.word.toLowerCase() === word.toLowerCase(); })) {
        if (S.panel) S.panel.toast('「' + word + '」已在生词本');
        return;
      }
      words.push({ id: util.uid('w'), word: word, context: context || '', start: start || 0, note: '', addedAt: Date.now() });
      FE.store.patchVideo(info.bvid, info.page, { words: words }).then(function (rec) {
        S.record = rec;
        if (S.panel) {
          S.panel.setRecord(rec);
          S.panel.toast('已加入生词：' + word);
        }
      });
    },

    defineWord: function (id) {
      var cfg = S.config;
      if (!cfg.llm.enabled || !cfg.llm.endpoint || !cfg.llm.token) {
        if (S.panel) {
          S.panel.showError('需要先在「API 配置」填写 LLM 接口才能使用 AI 释义。', {
            actions: [
              { label: '取消' },
              { label: '去配置', primary: true, onClick: function () { bg(MSG.OPEN_OPTIONS, { hash: '#api' }); } }
            ]
          });
        }
        return;
      }
      var w = ((S.record && S.record.words) || []).find(function (x) { return x.id === id; });
      if (!w) return;
      if (S.panel) S.panel.toast('AI 释义生成中…');
      bg(MSG.CHAT, {
        purpose: 'define',
        messages: [
          { role: 'system', content: 'You are an English-Chinese dictionary for ESL learners. Explain the word briefly in Chinese: part of speech, core meaning, and one short example sentence with Chinese translation. Keep it under 60 Chinese characters.' },
          { role: 'user', content: 'Word: ' + w.word + '\nContext: ' + (w.context || '') }
        ]
      }).then(function (res) {
        if (!res.ok) {
          if (S.panel) S.panel.toast('AI 释义失败：' + (res.error || ''), 4000);
          return;
        }
        var words = (S.record.words || []).map(function (x) {
          return x.id === id ? Object.assign({}, x, { note: String(res.text || '').trim() }) : x;
        });
        FE.store.patchVideo(S.pageInfo.bvid, S.pageInfo.page, { words: words }).then(function (rec) {
          S.record = rec;
          if (S.panel) S.panel.setRecord(rec);
        });
      });
    },

    deleteWord: function (id) {
      var words = ((S.record && S.record.words) || []).filter(function (w) { return w.id !== id; });
      FE.store.patchVideo(S.pageInfo.bvid, S.pageInfo.page, { words: words }).then(function (rec) {
        S.record = rec;
        if (S.panel) S.panel.setRecord(rec);
      });
    },

    /* -------- 练习 -------- */
    genQuiz: function () {
      var rec = S.record;
      var items = FE.subtitle.buildQuiz((rec && rec.cues) || [], { count: 5 });
      if (!items.length) {
        if (S.panel) S.panel.toast('字幕太短，无法出题');
        return;
      }
      S.quiz = { items: items, answers: [], graded: false, score: 0 };
      if (S.panel) S.panel.setQuiz(S.quiz);
    },

    submitQuiz: function (answers) {
      var q = S.quiz;
      if (!q || q.graded) return;
      var score = 0;
      q.items = q.items.map(function (it, i) {
        var ans = String(answers[i] || '').trim().toLowerCase();
        var ok = ans === it.answer.toLowerCase();
        if (ok) score++;
        return Object.assign({}, it, { correct: ok });
      });
      q.answers = answers;
      q.graded = true;
      q.score = score;
      var exercises = ((S.record && S.record.exercises) || []).concat([{
        id: util.uid('ex'),
        createdAt: Date.now(),
        items: q.items.map(function (it, i) { return { q: it.sentence, a: it.answer, user: answers[i] || '', correct: it.correct }; }),
        score: score
      }]);
      FE.store.patchVideo(S.pageInfo.bvid, S.pageInfo.page, { exercises: exercises }).then(function (rec) {
        S.record = rec;
        if (S.panel) S.panel.setQuiz(S.quiz);
      });
    },

    /* -------- 笔记 -------- */
    addNote: function (text, start) {
      var notes = ((S.record && S.record.notes) || []).concat([{
        id: util.uid('n'), start: start || 0, text: text, createdAt: Date.now(), updatedAt: Date.now(), ai: false
      }]);
      FE.store.patchVideo(S.pageInfo.bvid, S.pageInfo.page, { notes: notes }).then(function (rec) {
        S.record = rec;
        if (S.panel) {
          S.panel.setRecord(rec);
          S.panel.toast('笔记已保存');
        }
      });
    },

    deleteNote: function (id) {
      var notes = ((S.record && S.record.notes) || []).filter(function (n) { return n.id !== id; });
      FE.store.patchVideo(S.pageInfo.bvid, S.pageInfo.page, { notes: notes }).then(function (rec) {
        S.record = rec;
        if (S.panel) S.panel.setRecord(rec);
      });
    },

    aiNote: function () {
      var cfg = S.config;
      if (!cfg.llm.enabled || !cfg.llm.endpoint || !cfg.llm.token) {
        if (S.panel) {
          S.panel.showError('需要先在「API 配置」填写 LLM 接口才能生成 AI 笔记。', {
            actions: [
              { label: '取消' },
              { label: '去配置', primary: true, onClick: function () { bg(MSG.OPEN_OPTIONS, { hash: '#api' }); } }
            ]
          });
        }
        return;
      }
      var rec = S.record;
      var cues = (rec && rec.cues) || [];
      if (!cues.length) return;
      var t = (S.video && S.video.currentTime) || 0;
      var windowCues = cues.filter(function (c) { return c.start >= t - 180 && c.start <= t + 600; });
      var text = FE.subtitle.toPlainText(windowCues.length ? windowCues : cues.slice(0, 80), true);
      if (S.panel) S.panel.toast('AI 正在整理笔记…');
      bg(MSG.CHAT, {
        purpose: 'notes',
        messages: [
          { role: 'system', content: 'You are an English learning assistant. Based on the video subtitle excerpt, write concise study notes in Chinese: 1) 本段大意 2) 3-6 个重点表达/短语（附中文） 3) 1-2 个语法点。Markdown 格式，控制在 250 字以内。' },
          { role: 'user', content: text }
        ]
      }).then(function (res) {
        if (!res.ok) {
          if (S.panel) S.panel.toast('AI 笔记失败：' + (res.error || ''), 4000);
          return;
        }
        var notes = (S.record.notes || []).concat([{
          id: util.uid('n'), start: t, text: String(res.text || '').trim(),
          createdAt: Date.now(), updatedAt: Date.now(), ai: true
        }]);
        FE.store.patchVideo(S.pageInfo.bvid, S.pageInfo.page, { notes: notes }).then(function (r) {
          S.record = r;
          if (S.panel) {
            S.panel.setRecord(r);
            S.panel.setTab('notes');
            S.panel.toast('AI 笔记已生成');
          }
        });
      });
    },

    /* -------- 导出 / 设置 -------- */
    exportData: function (kind) {
      var rec = S.record;
      if (!rec) return;
      var name = FE.exporter.safeName(rec.title || rec.bvid, rec.bvid) + (rec.page > 1 ? '_p' + rec.page : '');
      if (kind === 'srt') {
        FE.exporter.download(name + '.srt', FE.exporter.recToSrt(rec, false), 'text/plain;charset=utf-8');
      } else if (kind === 'srt-zh') {
        FE.exporter.download(name + '.bilingual.srt', FE.exporter.recToSrt(rec, true), 'text/plain;charset=utf-8');
      } else if (kind === 'md') {
        FE.exporter.download(name + '.md', FE.exporter.recToMarkdown(rec), 'text/markdown;charset=utf-8');
      } else if (kind === 'csv') {
        var words = (rec.words || []).map(function (w) {
          return Object.assign({}, w, { bvid: rec.bvid, page: rec.page, title: rec.title });
        });
        FE.exporter.download(name + '_words.csv', FE.exporter.wordsToCsv(words), 'text/csv;charset=utf-8');
      }
      if (S.panel) S.panel.toast('已导出');
    },

    openSettings: function (section) {
      var map = { api: '#api', cache: '#cache', words: '#words' };
      bg(MSG.OPEN_OPTIONS, { hash: map[section] || '' });
    },

    translateRetry: function () {
      if (S.panel) S.panel.setTranslateNotice(null);
      maybeTranslate(true);
    },

    stopAsr: function () {
      var stopT = S.video ? S.video.currentTime : 0;
      stopAsrInternal();
      S.asrStopTime = stopT;   // 本次会话内记录
      /* 持久化停止位置：刷新页面后仍可续传 */
      if (S.record) {
        S.record.asrStopAt = stopT;
        FE.store.saveVideo(S.record);
      }
      if (S.panel) {
        S.panel.setAsr(null);
        S.panel.toast('已停止并保存，进度已缓存。重新打开视频可继续采集');
      }
      setStatus('ASR 已停止 · 上次停在 ' + util.formatTime(stopT) + '，点击按钮继续');
    },

    /* 重新打开视频时，从提示条触发的续传 */
    continueAsr: function () {
      var rec = S.record;
      if (!rec || rec.asrStopAt == null) {
        if (S.panel) S.panel.toast('未找到上次停止位置，请直接开始转写');
        return;
      }
      if (S.panel) {
        S.panel.confirmResume({
          stopTime: rec.asrStopAt,
          currentTime: S.video ? S.video.currentTime : 0,
          onFromStop: function () { resumeAsr(rec.asrStopAt); },
          onFromNow: function () { resumeAsr(S.video ? S.video.currentTime : 0); }
        });
      }
    },

    clearCache: function () {
      var info = S.pageInfo;
      if (!info) return;
      FE.store.deleteVideo(info.bvid, info.page).then(function () {
        onVideoChanged();
        if (S.panel) S.panel.toast('本视频缓存已清空');
      });
    }
  };

  /* ================= 快捷键 ================= */
  document.addEventListener('keydown', function (e) {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    var tag = (e.target && e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || (e.target && e.target.isContentEditable)) return;
    var k = e.key.toLowerCase();
    if (k === 'z') {
      e.preventDefault();
      host.onLauncherClick();
    } else if (k === 'x' && S.activated) {
      e.preventDefault();
      host.replay();
    } else if (k === 'c' && S.activated) {
      e.preventDefault();
      host.toggleLoop();
    }
  }, true);

  /* ================= 启动 ================= */
  function boot() {
    FE.store.getConfig().then(function (cfg) {
      S.config = cfg;
      if (!S.pageInfo) S.pageInfo = fallbackPageInfo();
      ensureMounted();
      if (S.panel && S.pageInfo) S.panel.setPageInfo(S.pageInfo);
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
