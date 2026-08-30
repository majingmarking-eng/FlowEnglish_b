/* FlowEnglish - background service worker
 * 职责：代理转发用户自己配置的 ASR / 翻译 / LLM 请求（解决跨域、密钥不离开浏览器）；
 *       拉取 B 站原生字幕列表（wbi 签名）与字幕 JSON。
 * 不提供任何对外服务，不上传任何用户数据到第三方。
 */
importScripts('../lib/core.js', '../lib/storage.js');

(function (global) {
  'use strict';

  var FE = global.FlowEnglish;
  var MSG = FE.MSG;
  var util = FE.util;

  /* ================= B 站 wbi 签名 ================= */
  var MIXIN_KEY_ENC_TAB = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
    27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
    37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
    22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52
  ];

  var wbiCache = { key: null, ts: 0 };

  function getWbiKey() {
    if (wbiCache.key && Date.now() - wbiCache.ts < 6 * 3600 * 1000) {
      return Promise.resolve(wbiCache.key);
    }
    return fetch('https://api.bilibili.com/x/web-interface/nav', { credentials: 'include' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        var img = j && j.data && j.data.wbi_img;
        if (!img || !img.img_url) throw new Error('wbi keys unavailable');
        var base = function (u) { return u.split('/').pop().split('.')[0]; };
        var orig = base(img.img_url) + base(img.sub_url);
        var key = MIXIN_KEY_ENC_TAB.map(function (i) { return orig[i]; }).join('').slice(0, 32);
        wbiCache = { key: key, ts: Date.now() };
        return key;
      });
  }

  function wbiSign(params) {
    return getWbiKey().then(function (mixin) {
      var p = Object.assign({}, params, { wts: Math.floor(Date.now() / 1000) });
      var query = Object.keys(p).sort().map(function (k) {
        var v = String(p[k]).replace(/[!'()*]/g, '');
        return encodeURIComponent(k) + '=' + encodeURIComponent(v);
      }).join('&');
      return query + '&w_rid=' + util.md5(query + mixin);
    });
  }

  function mapSubtitleList(arr) {
    return (arr || []).map(function (x) {
      return { lan: x.lan || '', lanDoc: x.lan_doc || '', url: x.subtitle_url || '', id: x.id || 0 };
    });
  }

  function getBiliSubtitles(bvid, cid) {
    return wbiSign({ bvid: bvid, cid: cid })
      .then(function (q) {
        return fetch('https://api.bilibili.com/x/player/wbi/v2?' + q, { credentials: 'include' });
      })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (j && j.code === 0 && j.data && j.data.subtitle) {
          var subs = j.data.subtitle.subtitles || j.data.subtitle.list || [];
          if (subs.length) return mapSubtitleList(subs);
        }
        throw new Error('wbi empty');
      })
      .catch(function () {
        /* 回退：旧版接口（部分环境无需签名） */
        return fetch('https://api.bilibili.com/x/player/v2?bvid=' + encodeURIComponent(bvid) + '&cid=' + encodeURIComponent(cid), { credentials: 'include' })
          .then(function (r) { return r.json(); })
          .then(function (j) {
            if (j && j.code === 0 && j.data && j.data.subtitle) {
              return mapSubtitleList(j.data.subtitle.subtitles || []);
            }
            return [];
          })
          .catch(function () { return []; });
      });
  }

  /* ================= 通用网络代理 ================= */
  function fetchText(url) {
    if (!/^https?:\/\//i.test(url)) return Promise.resolve({ ok: false, error: 'invalid url' });
    return fetch(url, { credentials: 'include' })
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.text();
      })
      .then(function (text) { return { ok: true, text: text }; })
      .catch(function (e) { return { ok: false, error: String(e && e.message || e) }; });
  }

  function parseExtraHeaders(raw) {
    var out = {};
    String(raw || '').split('\n').forEach(function (line) {
      var i = line.indexOf(':');
      if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
    });
    return out;
  }

  /* ================= ASR ================= */
  function parseAsrResponse(j) {
    var data = j && (j.data || j.result || j) || {};
    var text = data.text || data.transcript || data.transcription || '';
    var segments = null;
    var raw = data.segments || data.sentences || data.results || null;
    if (Array.isArray(raw) && raw.length && typeof raw[0] === 'object') {
      segments = raw.map(function (s) {
        var start = s.start != null ? +s.start : s.begin_time != null ? s.begin_time / 1000 : 0;
        var end = s.end != null ? +s.end : s.end_time != null ? s.end_time / 1000 : start;
        return { start: start, end: end, text: s.text || s.transcript || s.sentence || '' };
      });
    }
    return { text: text, segments: segments };
  }

  /* ================= 火山引擎 · 豆包语音识别（极速版，一次请求返回） =================
   * POST /api/v3/auc/bigmodel/recognize/flash
   * 鉴权：新版 X-Api-Key；旧版 X-Api-App-Key + X-Api-Access-Key
   * 请求体 JSON：audio.data 为 base64 音频（wav/mp3/ogg），request.show_utterances 返回分句毫秒时间戳
   */
  function doAsrVolcanoFlash(payload, asr) {
    var endpoint = (asr.endpoint && asr.endpoint.trim()) || FE.VOLCANO_FLASH_ENDPOINT;
    var headers = {
      'Content-Type': 'application/json',
      'X-Api-Resource-Id': asr.resourceId || FE.VOLCANO_DEFAULT_RESOURCE,
      'X-Api-Request-Id': (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : util.uid('req'),
      'X-Api-Sequence': '-1'
    };
    if (asr.apiKey) {
      headers['X-Api-Key'] = asr.apiKey;
    } else if (asr.appKey && asr.accessKey) {
      headers['X-Api-App-Key'] = asr.appKey;
      headers['X-Api-Access-Key'] = asr.accessKey;
    } else {
      return Promise.resolve({ ok: false, error: '未配置火山引擎 API Key（或旧版 App ID + Access Token）' });
    }

    var langMap = { en: 'en-US', zh: 'zh-CN', 'zh-cn': 'zh-CN', 'en-us': 'en-US' };
    var rawLang = String(asr.language || '').trim().toLowerCase();
    var language = langMap[rawLang] || asr.language || 'en-US';

    var mime = payload.mime || 'audio/wav';
    if (mime.indexOf('webm') > -1) {
      return Promise.resolve({ ok: false, error: '火山极速版不支持 WebM，请在配置页把「上传格式」改为 WAV 16kHz' });
    }

    var body = {
      user: { uid: 'flowenglish' },
      audio: {
        format: mime.indexOf('wav') > -1 ? 'wav' : mime.indexOf('mp3') > -1 || mime.indexOf('mpeg') > -1 ? 'mp3' : 'ogg',
        data: payload.audio,
        rate: 16000,
        bits: 16,
        channel: 1,
        language: language
      },
      request: {
        model_name: 'bigmodel',
        enable_itn: true,
        enable_punc: true,
        show_utterances: true
      }
    };

    return fetch(endpoint, {
      method: 'POST',
      headers: headers,
      body: JSON.stringify(body)
    }).then(function (r) {
      var hCode = r.headers.get('X-Api-Status-Code') || '';
      var hMsg = r.headers.get('X-Api-Message') || '';
      return r.text().then(function (text) {
        try { console.log('[FE/ASR-volc] status=' + r.status + ' code=' + hCode, text.slice(0, 800)); } catch (e) { /* ignore */ }
        var j = null;
        try { j = JSON.parse(text); } catch (e) { /* body 可能为空 */ }
        /* 状态码可能出现在 HTTP 头、也可能出现在响应体（兼容两种） */
        var bCode = '';
        var bMsg = '';
        if (j) {
          if (j.code != null) bCode = String(j.code);
          else if (j.headers && j.headers['X-Api-Status-Code'] != null) bCode = String(j.headers['X-Api-Status-Code']);
          else if (j.body && j.body.code != null) bCode = String(j.body.code);
          if (j.message) bMsg = String(j.message);
          else if (j.body && j.body.message) bMsg = String(j.body.message);
        }
        var code = hCode || bCode || '';
        var msg = hMsg || bMsg || '';
        /* 静音 / 空音频：视为成功但无内容，直接跳过该切片 */
        if (code === '20000003' || code === '45000002') {
          return { ok: true, text: '', segments: [] };
        }
        if (code !== '20000000') {
          throw new Error('火山 ASR 失败 ' + (code || 'HTTP ' + r.status) + '：' + (msg || text.slice(0, 240)));
        }
        /* 结果可能位于 body.result / result / 顶层（兼容不同文档版本的返回结构） */
        var data = (j && (j.result || (j.body && j.body.result))) || j || {};
        var result = data.result || data;
        var segments = (result.utterances || []).map(function (u) {
          return {
            start: (+u.start_time || 0) / 1000,
            end: (+u.end_time || 0) / 1000,
            text: String(u.text || '').trim()
          };
        }).filter(function (s) { return s.text; });
        return { ok: true, text: result.text || data.text || '', segments: segments };
      });
    }).catch(function (e) {
      return { ok: false, error: String(e && e.message || e) };
    });
  }

  function doAsr(payload) {
    return FE.store.getConfig().then(function (cfg) {
      var asr = cfg.asr || {};
      var protocol = asr.protocol || 'openai';

      if (protocol === 'volcano-flash') {
        return doAsrVolcanoFlash(payload, asr);
      }

      if (!asr.endpoint || !asr.endpoint.trim()) {
        return { ok: false, error: '未配置 ASR 接口地址' };
      }
      var bytes = util.base64ToBytes(payload.audio);
      var mime = payload.mime || 'audio/wav';
      var headers = parseExtraHeaders(asr.extraHeaders);
      if (asr.token) headers['Authorization'] = 'Bearer ' + asr.token;

      var init;

      if (protocol === 'json-base64') {
        headers['Content-Type'] = 'application/json';
        init = {
          method: 'POST',
          headers: headers,
          body: JSON.stringify({
            audio: payload.audio,
            mime: mime,
            model: asr.model || undefined,
            language: asr.language || 'en'
          })
        };
      } else {
        /* openai | multipart：均为 multipart/form-data */
        var fd = new FormData();
        var fname = mime.indexOf('wav') > -1 ? 'audio.wav' : mime.indexOf('ogg') > -1 ? 'audio.ogg' : 'audio.webm';
        fd.append(asr.fieldName || 'file', new Blob([bytes], { type: mime }), fname);
        if (asr.model) fd.append('model', asr.model);
        if (asr.language) fd.append('language', asr.language);
        if (protocol === 'openai' && asr.verboseJson !== false) {
          fd.append('response_format', asr.responseFormat || 'verbose_json');
          fd.append('timestamp_granularities[]', 'segment');
        }
        /* multipart 协议下不允许手动设置 Content-Type（boundary 由浏览器生成） */
        if (headers['Content-Type']) delete headers['Content-Type'];
        init = { method: 'POST', headers: headers, body: fd };
      }

      return fetch(asr.endpoint.trim(), init)
        .then(function (r) {
          return r.text().then(function (body) {
            /* 把 ASR 原始响应打到 devtools console，便于排查 0 段成功之类的问题 */
            try { console.log('[FE/ASR] ' + asr.endpoint + ' status=' + r.status, body.slice(0, 800)); } catch (e) { /* ignore */ }
            if (!r.ok) throw new Error('HTTP ' + r.status + '：' + body.slice(0, 240));
            try { return JSON.parse(body); }
            catch (e) { return { text: body }; }
          });
        })
        .then(function (j) {
          var parsed = typeof j === 'string' ? { text: j, segments: null } : parseAsrResponse(j);
          return { ok: true, text: parsed.text || '', segments: parsed.segments || null };
        })
        .catch(function (e) {
          return { ok: false, error: String(e && e.message || e) };
        });
    });
  }

  /* ================= LLM / 翻译 ================= */
  function pickChatConfig(cfg, purpose) {
    if (purpose === 'translate' && cfg.translate && cfg.translate.enabled && cfg.translate.endpoint) {
      return {
        endpoint: cfg.translate.endpoint,
        token: cfg.translate.token || cfg.llm.token,
        model: cfg.translate.model || cfg.llm.model,
        temperature: cfg.translate.temperature != null ? cfg.translate.temperature : 0.2
      };
    }
    return {
      endpoint: cfg.llm.endpoint,
      token: cfg.llm.token,
      model: cfg.llm.model,
      temperature: cfg.llm.temperature != null ? cfg.llm.temperature : 0.4
    };
  }

  function doChat(payload) {
    return FE.store.getConfig().then(function (cfg) {
      var c = pickChatConfig(cfg, payload.purpose);
      if (!c.endpoint || !c.endpoint.trim()) return { ok: false, error: '未配置 LLM 接口' };
      if (!c.token) return { ok: false, error: '未配置 LLM Token' };

      return fetch(c.endpoint.trim(), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + c.token
        },
        body: JSON.stringify({
          model: c.model,
          messages: payload.messages || [],
          temperature: c.temperature
        })
      }).then(function (r) {
        return r.text().then(function (body) {
          if (!r.ok) throw new Error('LLM HTTP ' + r.status + '：' + body.slice(0, 200));
          var j;
          try { j = JSON.parse(body); } catch (e) { throw new Error('LLM 返回非 JSON'); }
          var text = j && j.choices && j.choices[0] && j.choices[0].message
            ? j.choices[0].message.content
            : (j && (j.text || (j.data && j.data.text))) || '';
          if (!text) throw new Error('LLM 返回为空');
          return { ok: true, text: String(text).trim() };
        });
      }).catch(function (e) {
        return { ok: false, error: String(e && e.message || e) };
      });
    });
  }

  /* ================= 消息路由 ================= */
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== 'string') return false;

    switch (msg.type) {
      case MSG.GET_CONFIG:
        FE.store.getConfig().then(function (cfg) { sendResponse({ ok: true, config: cfg }); });
        return true;

      case MSG.SET_CONFIG:
        FE.store.setConfig(msg.patch || {}).then(function (cfg) { sendResponse({ ok: true, config: cfg }); });
        return true;

      case MSG.BILI_SUBTITLES:
        getBiliSubtitles(msg.bvid, msg.cid).then(function (list) {
          sendResponse({ ok: true, list: list });
        }).catch(function (e) {
          sendResponse({ ok: false, error: String(e && e.message || e), list: [] });
        });
        return true;

      case MSG.FETCH_TEXT:
        fetchText(msg.url).then(sendResponse);
        return true;

      case MSG.ASR:
        doAsr(msg).then(sendResponse);
        return true;

      case MSG.CHAT:
        doChat(msg).then(sendResponse);
        return true;

      case MSG.OPEN_OPTIONS:
        chrome.storage.local.set({ FE_PENDING_SECTION: msg.hash || '' }, function () {
          chrome.runtime.openOptionsPage();
          sendResponse({ ok: true });
        });
        return true;

      default:
        return false;
    }
  });

  /* ================= 安装 ================= */
  chrome.runtime.onInstalled.addListener(function (details) {
    FE.store.getConfig().then(function (cfg) {
      return FE.store.setConfig(cfg);
    });
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
