/* FlowEnglish - core：命名空间、常量、纯工具函数
 * 以 classic script 形式被 content / background(importScripts) / 扩展页面同时加载。
 */
(function (global) {
  'use strict';

  var FE = (global.FlowEnglish = global.FlowEnglish || {});
  FE.VERSION = '0.1.0';

  FE.MSG = {
    GET_CONFIG: 'FE/GET_CONFIG',
    SET_CONFIG: 'FE/SET_CONFIG',
    BILI_SUBTITLES: 'FE/BILI_SUBTITLES',
    FETCH_TEXT: 'FE/FETCH_TEXT',
    ASR: 'FE/ASR',
    CHAT: 'FE/CHAT',
    OPEN_OPTIONS: 'FE/OPEN_OPTIONS'
  };

  /* ---------------- 默认配置 ---------------- */
  FE.DEFAULT_CONFIG = {
    asr: {
      enabled: false,
      endpoint: '',           // 例：https://api.openai.com/v1/audio/transcriptions
      token: '',
      protocol: 'openai',     // openai | multipart | json-base64 | volcano-flash
      model: 'whisper-1',
      language: 'en',
      responseFormat: 'verbose_json',
      verboseJson: true,      // openai 协议是否带 verbose_json + 时间戳参数（火山方舟 ASR 不支持则关掉）
      audioFormat: 'wav16k',  // wav16k | webm
      sliceSeconds: 60,
      fieldName: 'file',      // multipart 协议下的文件字段名
      extraHeaders: '',       // 每行一条：Key: Value
      /* 火山引擎 · 豆包语音识别（volcano-flash）专用 */
      apiKey: '',             // 新版控制台 X-Api-Key（优先）
      appKey: '',             // 旧版控制台 X-Api-App-Key（App ID）
      accessKey: '',          // 旧版控制台 X-Api-Access-Key（Access Token）
      resourceId: 'volc.bigasr.auc_turbo'
    },
    translate: {
      enabled: false,
      endpoint: '',           // 留空则复用 llm 配置
      token: '',
      model: '',
      protocol: 'openai-chat',
      temperature: 0.2
    },
    llm: {
      enabled: false,
      endpoint: 'https://api.openai.com/v1/chat/completions',
      token: '',
      model: 'gpt-4o-mini',
      protocol: 'openai-chat',
      temperature: 0.4
    },
    ui: {
      showChinese: false,
      panelMode: 'inline',    // inline | dock
      autoScroll: true
    }
  };

  var util = (FE.util = {});

  /* ---------------- 通用 ---------------- */
  util.isPlainObject = function (v) {
    return Object.prototype.toString.call(v) === '[object Object]';
  };

  util.merge = function (base, patch) {
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    if (!util.isPlainObject(patch)) return out;
    Object.keys(patch).forEach(function (k) {
      var pv = patch[k];
      if (util.isPlainObject(pv) && util.isPlainObject(out[k])) out[k] = util.merge(out[k], pv);
      else out[k] = pv;
    });
    return out;
  };

  util.uid = function (prefix) {
    return (prefix || 'id') + '_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  };

  util.clamp = function (n, min, max) {
    return Math.min(max, Math.max(min, n));
  };

  util.sleep = function (ms) {
    return new Promise(function (r) { setTimeout(r, ms); });
  };

  util.debounce = function (fn, wait) {
    var t = null;
    return function () {
      var args = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, args); }, wait || 200);
    };
  };

  util.escapeHtml = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  /* ---------------- 时间 ---------------- */
  util.formatTime = function (sec) {
    if (sec == null || isNaN(sec)) sec = 0;
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return (h > 0 ? h + ':' : '') + pad(m) + ':' + pad(s);
  };

  util.formatTimeSrt = function (sec) {
    if (sec == null || isNaN(sec)) sec = 0;
    sec = Math.max(0, sec);
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
    var ms = Math.round((sec - Math.floor(sec)) * 1000);
    var p2 = function (n) { return n < 10 ? '0' + n : '' + n; };
    var p3 = function (n) { return n < 10 ? '00' + n : n < 100 ? '0' + n : '' + n; };
    return p2(h) + ':' + p2(m) + ':' + p2(s) + ',' + p3(ms);
  };

  util.parseTime = function (str) {
    var m = String(str || '').trim().match(/^(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?$/);
    if (!m) return 0;
    var h = +m[1] || 0, mi = +m[2], s = +m[3], ms = m[4] ? +m[4].padEnd(3, '0') : 0;
    return h * 3600 + mi * 60 + s + ms / 1000;
  };

  /* ---------------- 缓存 key ---------------- */
  util.videoKey = function (bvid, page) {
    return 'FE_V_' + String(bvid || 'unknown') + '_' + (page == null ? 1 : page);
  };
  FE.KEY_CONFIG = 'FE_CFG';
  FE.KEY_INDEX = 'FE_IDX';

  /* ---------------- 字幕语种判定 ---------------- */
  util.isEnglishSubtitle = function (item) {
    if (!item) return false;
    var lan = String(item.lan || '').toLowerCase();
    if (/^(ai-)?en(-|_|$)/.test(lan)) return true;
    var doc = item.lanDoc || item.lan_doc || '';
    return /英语|英文|english/i.test(doc);
  };

  util.isChineseSubtitle = function (item) {
    if (!item) return false;
    var lan = String(item.lan || '').toLowerCase();
    if (/^(ai-)?zh(-|_|$)/.test(lan)) return true;
    var doc = item.lanDoc || item.lan_doc || '';
    return /中文|汉语|chinese/i.test(doc);
  };

  /* ---------------- ASR 配置校验（按协议区分） ---------------- */
  util.asrConfigured = function (cfg) {
    var a = (cfg && cfg.asr) || {};
    if (a.protocol === 'volcano-flash') {
      return !!(a.apiKey || (a.appKey && a.accessKey));
    }
    return !!(a.endpoint && a.endpoint.trim());
  };

  FE.VOLCANO_FLASH_ENDPOINT = 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash';
  FE.VOLCANO_DEFAULT_RESOURCE = 'volc.bigasr.auc_turbo';

  /* ---------------- 二进制 / base64 ---------------- */
  util.bytesToBase64 = function (bytes) {
    var chunk = 0x8000, parts = [];
    for (var i = 0; i < bytes.length; i += chunk) {
      parts.push(String.fromCharCode.apply(null, bytes.subarray(i, i + chunk)));
    }
    return global.btoa(parts.join(''));
  };

  util.base64ToBytes = function (b64) {
    var bin = global.atob(b64);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  };

  util.blobToBase64 = function (blob) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () {
        var dataUrl = String(fr.result);
        resolve(dataUrl.slice(dataUrl.indexOf(',') + 1));
      };
      fr.onerror = function () { reject(fr.error || new Error('read blob failed')); };
      fr.readAsDataURL(blob);
    });
  };

  /* ---------------- 文本清洗 ---------------- */
  util.cleanWord = function (w) {
    return String(w || '').trim().replace(/^[^A-Za-z]+|[^A-Za-z'-]+$/g, '');
  };

  util.isWordLike = function (w) {
    return /^[A-Za-z][A-Za-z'-]{1,}$/.test(String(w || '').trim());
  };

  /* ---------------- md5（B 站 wbi 签名用，零依赖） ---------------- */
  function add32(a, b) { return (a + b) >>> 0; }
  function cmn(q, a, b, x, s, t) {
    a = add32(add32(a, q), add32(x, t));
    return add32((a << s) | (a >>> (32 - s)), b);
  }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

  function md5cycle(state, k) {
    var a = state[0], b = state[1], c = state[2], d = state[3];

    a = ff(a, b, c, d, k[0], 7, -680876936);   d = ff(d, a, b, c, k[1], 12, -389564586);
    c = ff(c, d, a, b, k[2], 17, 606105819);   b = ff(b, c, d, a, k[3], 22, -1044525330);
    a = ff(a, b, c, d, k[4], 7, -176418897);   d = ff(d, a, b, c, k[5], 12, 1200080426);
    c = ff(c, d, a, b, k[6], 17, -1473231341); b = ff(b, c, d, a, k[7], 22, -45705983);
    a = ff(a, b, c, d, k[8], 7, 1770035416);   d = ff(d, a, b, c, k[9], 12, -1958414417);
    c = ff(c, d, a, b, k[10], 17, -42063);     b = ff(b, c, d, a, k[11], 22, -1990404162);
    a = ff(a, b, c, d, k[12], 7, 1804603682);  d = ff(d, a, b, c, k[13], 12, -40341101);
    c = ff(c, d, a, b, k[14], 17, -1502002290);b = ff(b, c, d, a, k[15], 22, 1236535329);

    a = gg(a, b, c, d, k[1], 5, -165796510);   d = gg(d, a, b, c, k[6], 9, -1069501632);
    c = gg(c, d, a, b, k[11], 14, 643717713);  b = gg(b, c, d, a, k[0], 20, -373897302);
    a = gg(a, b, c, d, k[5], 5, -701558691);   d = gg(d, a, b, c, k[10], 9, 38016083);
    c = gg(c, d, a, b, k[15], 14, -660478335); b = gg(b, c, d, a, k[4], 20, -405537848);
    a = gg(a, b, c, d, k[9], 5, 568446438);    d = gg(d, a, b, c, k[14], 9, -1019803690);
    c = gg(c, d, a, b, k[3], 14, -187363961);  b = gg(b, c, d, a, k[8], 20, 1163531501);
    a = gg(a, b, c, d, k[13], 5, -1444681467); d = gg(d, a, b, c, k[2], 9, -51403784);
    c = gg(c, d, a, b, k[7], 14, 1735328473);  b = gg(b, c, d, a, k[12], 20, -1926607734);

    a = hh(a, b, c, d, k[5], 4, -378558);      d = hh(d, a, b, c, k[8], 11, -2022574463);
    c = hh(c, d, a, b, k[11], 16, 1839030562); b = hh(b, c, d, a, k[14], 23, -35309556);
    a = hh(a, b, c, d, k[1], 4, -1530992060);  d = hh(d, a, b, c, k[4], 11, 1272893353);
    c = hh(c, d, a, b, k[7], 16, -155497632);  b = hh(b, c, d, a, k[10], 23, -1094730640);
    a = hh(a, b, c, d, k[13], 4, 681279174);   d = hh(d, a, b, c, k[0], 11, -358537222);
    c = hh(c, d, a, b, k[3], 16, -722521979);  b = hh(b, c, d, a, k[6], 23, 76029189);
    a = hh(a, b, c, d, k[9], 4, -640364487);   d = hh(d, a, b, c, k[12], 11, -421815835);
    c = hh(c, d, a, b, k[15], 16, 530742520);  b = hh(b, c, d, a, k[2], 23, -995338651);

    a = ii(a, b, c, d, k[0], 6, -198630844);   d = ii(d, a, b, c, k[7], 10, 1126891415);
    c = ii(c, d, a, b, k[14], 15, -1416354905);b = ii(b, c, d, a, k[5], 21, -57434055);
    a = ii(a, b, c, d, k[12], 6, 1700485571);  d = ii(d, a, b, c, k[3], 10, -1894986606);
    c = ii(c, d, a, b, k[10], 15, -1051523);   b = ii(b, c, d, a, k[1], 21, -2054922799);
    a = ii(a, b, c, d, k[8], 6, 1873313359);   d = ii(d, a, b, c, k[15], 10, -30611744);
    c = ii(c, d, a, b, k[6], 15, -1560198380); b = ii(b, c, d, a, k[13], 21, 1309151649);
    a = ii(a, b, c, d, k[4], 6, -145523070);   d = ii(d, a, b, c, k[11], 10, -1120210379);
    c = ii(c, d, a, b, k[2], 15, 718787259);   b = ii(b, c, d, a, k[9], 21, -343485551);

    state[0] = add32(a, state[0]);
    state[1] = add32(b, state[1]);
    state[2] = add32(c, state[2]);
    state[3] = add32(d, state[3]);
  }

  function md5blk(bytes, off) {
    var w = new Array(16);
    for (var j = 0; j < 16; j++) {
      var o = off + j * 4;
      w[j] = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24);
    }
    return w;
  }

  util.md5 = function (input) {
    var bytes;
    if (typeof input === 'string') {
      bytes = new TextEncoder().encode(input);
    } else if (input instanceof Uint8Array) {
      bytes = input;
    } else {
      bytes = new Uint8Array(input);
    }
    var state = [1732584193, -271733879, -1732584194, 271733878];
    var len = bytes.length, i;
    for (i = 64; i <= len; i += 64) md5cycle(state, md5blk(bytes, i - 64));
    var rest = bytes.subarray(i - 64);
    var tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (i = 0; i < rest.length; i++) tail[i >> 2] |= rest[i] << ((i % 4) << 3);
    tail[i >> 2] |= 0x80 << ((i % 4) << 3);
    if (rest.length >= 56) {
      md5cycle(state, tail);
      tail = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    }
    tail[14] = (len * 8) >>> 0;
    tail[15] = Math.floor(len / 0x20000000);
    md5cycle(state, tail);

    var out = '';
    for (var s = 0; s < 4; s++) {
      for (var b = 0; b < 4; b++) {
        var v = (state[s] >>> (b * 8)) & 0xff;
        out += (v < 16 ? '0' : '') + v.toString(16);
      }
    }
    return out;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
