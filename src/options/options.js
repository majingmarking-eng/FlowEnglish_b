/* FlowEnglish - options 页逻辑：API 配置 / 缓存管理 / 全局生词本 / 备份 */
(function (global) {
  'use strict';

  var FE = global.FlowEnglish;
  var util = FE.util;
  var h = util.escapeHtml;

  var $ = function (id) { return document.getElementById(id); };

  /* ================= 导航 ================= */
  var NAV = ['api', 'cache', 'words', 'backup'];

  function showSection(name) {
    if (NAV.indexOf(name) < 0) name = 'api';
    NAV.forEach(function (n) {
      $('sec-' + n).hidden = n !== name;
    });
    document.querySelectorAll('.nav-item').forEach(function (a) {
      a.classList.toggle('is-active', a.getAttribute('data-nav') === name);
    });
    if (name === 'cache') renderCache();
    if (name === 'words') renderWords();
  }

  function navFromHash() {
    var hash = (location.hash || '').replace('#', '');
    showSection(hash);
  }

  window.addEventListener('hashchange', navFromHash);

  /* content 面板跳来时带的待定位 section */
  function consumePendingSection() {
    return new Promise(function (resolve) {
      chrome.storage.local.get('FE_PENDING_SECTION', function (o) {
        var v = o && o.FE_PENDING_SECTION;
        if (v) {
          chrome.storage.local.remove('FE_PENDING_SECTION');
          resolve(String(v).replace('#', ''));
        } else {
          resolve(null);
        }
      });
    });
  }

  /* ================= 协议联动 ================= */
  var PROTOCOL_DEFAULT_ENDPOINTS = {
    'volcano-flash': 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
    'openai': 'https://api.openai.com/v1/audio/transcriptions',
    'multipart': '',
    'json-base64': ''
  };

  function syncProtocolUI() {
    var p = $('asr-protocol').value;
    var isVolcano = p === 'volcano-flash';
    $('volcano-fields').hidden = !isVolcano;
    $('field-token').hidden = isVolcano;
    $('field-model').hidden = isVolcano;
    $('field-headers').hidden = isVolcano;
    $('asr-language').placeholder = isVolcano ? 'en-US（火山引擎要求带地区后缀）' : 'en';
    /* 接口地址为空、或还是其他协议的默认地址时，自动带入当前协议默认地址 */
    var ep = $('asr-endpoint');
    var known = Object.keys(PROTOCOL_DEFAULT_ENDPOINTS).map(function (k) { return PROTOCOL_DEFAULT_ENDPOINTS[k]; });
    if (!ep.value.trim() || known.indexOf(ep.value.trim()) > -1) {
      ep.value = PROTOCOL_DEFAULT_ENDPOINTS[p] || '';
    }
    if (isVolcano) {
      $('asr-audio-format').value = 'wav16k';
    }
  }

  $('asr-protocol').addEventListener('change', syncProtocolUI);

  /* ================= 供应商预设 ================= */
  var ARK_BASE = 'https://ark.cn-beijing.volces.com/api/v3';
  var ASR_PRESETS = {
    'volc-ark': {
      protocol: 'openai',
      endpoint: ARK_BASE + '/audio/transcriptions',
      model: 'doubao-seed-asr-1-0',
      language: 'en',
      tokenHint: '方舟 API Key（方舟控制台 → API Key 管理）',
      modelHint: '豆包种子 ASR 模型 ID，以控制台开通的为准'
    },
    'volc-speech': {
      protocol: 'volcano-flash',
      endpoint: 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash',
      model: 'bigmodel',
      language: 'en-US'
    },
    'openai': {
      protocol: 'openai',
      endpoint: 'https://api.openai.com/v1/audio/transcriptions',
      model: 'whisper-1',
      language: 'en',
      tokenHint: 'sk-...'
    }
  };
  var LLM_PRESETS = {
    'volc-ark': {
      endpoint: ARK_BASE + '/chat/completions',
      model: 'doubao-seed-2-1-pro-260628',
      tokenHint: '方舟 API Key（方舟控制台 → API Key 管理）',
      modelHint: 'Model ID 或推理接入点 ep-xxxx'
    },
    'openai': {
      endpoint: 'https://api.openai.com/v1/chat/completions',
      model: 'gpt-4o-mini',
      tokenHint: 'sk-...'
    },
    'deepseek': {
      endpoint: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-chat',
      tokenHint: 'DeepSeek API Key'
    }
  };

  $('asr-preset').addEventListener('change', function () {
    var p = ASR_PRESETS[$('asr-preset').value];
    if (!p) return;
    $('asr-protocol').value = p.protocol;
    syncProtocolUI();
    $('asr-endpoint').value = p.endpoint;
    if (p.model) $('asr-model').value = p.model;
    if (p.language) $('asr-language').value = p.language;
    if (p.tokenHint) $('asr-token').placeholder = p.tokenHint;
    if (p.modelHint) $('asr-model').placeholder = p.modelHint;
  });

  $('llm-preset').addEventListener('change', function () {
    var p = LLM_PRESETS[$('llm-preset').value];
    if (!p) return;
    $('llm-endpoint').value = p.endpoint;
    $('llm-model').value = p.model || '';
    if (p.tokenHint) $('llm-token').placeholder = p.tokenHint;
    if (p.modelHint) $('llm-model').placeholder = p.modelHint;
  });

  /* ================= 配置 ================= */
  function fillConfig(cfg) {
    $('asr-endpoint').value = cfg.asr.endpoint || '';
    $('asr-token').value = cfg.asr.token || '';
    $('asr-protocol').value = cfg.asr.protocol || 'openai';
    $('asr-model').value = cfg.asr.model || '';
    $('asr-language').value = cfg.asr.language || 'en';
    $('asr-audio-format').value = cfg.asr.audioFormat || 'wav16k';
    $('asr-slice').value = cfg.asr.sliceSeconds || 60;
    $('asr-headers').value = cfg.asr.extraHeaders || '';
    $('asr-api-key').value = cfg.asr.apiKey || '';
    $('asr-app-key').value = cfg.asr.appKey || '';
    $('asr-access-key').value = cfg.asr.accessKey || '';
    $('asr-resource-id').value = cfg.asr.resourceId || 'volc.bigasr.auc_turbo';
    /* 按已保存的协议+地址自动选中预设（弱匹配） */
    $('asr-preset').value = matchAsrPreset(cfg.asr);
    syncProtocolUI();
    /* syncProtocolUI 可能覆盖已保存的自定义地址，恢复之 */
    $('asr-endpoint').value = cfg.asr.endpoint || $('asr-endpoint').value;

    $('llm-endpoint').value = cfg.llm.endpoint || '';
    $('llm-token').value = cfg.llm.token || '';
    $('llm-model').value = cfg.llm.model || '';
    $('llm-preset').value = matchLlmPreset(cfg.llm);

    $('tr-endpoint').value = cfg.translate.endpoint || '';
    $('tr-token').value = cfg.translate.token || '';
    $('tr-model').value = cfg.translate.model || '';
  }

  function matchAsrPreset(asr) {
    asr = asr || {};
    if (asr.protocol === 'volcano-flash') return 'volc-speech';
    var ep = asr.endpoint || '';
    if (ep.indexOf('/api/v3/audio/transcriptions') > -1 && ep.indexOf('ark.') > -1) return 'volc-ark';
    if (ep.indexOf('api.openai.com/v1/audio/transcriptions') > -1) return 'openai';
    return 'custom';
  }

  function matchLlmPreset(llm) {
    llm = llm || {};
    var ep = llm.endpoint || '';
    if (ep.indexOf('ark.cn-beijing.volces.com') > -1) return 'volc-ark';
    if (ep.indexOf('api.openai.com/v1/chat/completions') > -1) return 'openai';
    if (ep.indexOf('api.deepseek.com') > -1) return 'deepseek';
    return 'custom';
  }

  function collectConfig() {
    var protocol = $('asr-protocol').value;
    var isVolcano = protocol === 'volcano-flash';
    var asrCfg = {
      enabled: false,
      endpoint: $('asr-endpoint').value.trim(),
      token: $('asr-token').value.trim(),
      protocol: protocol,
      model: $('asr-model').value.trim() || 'whisper-1',
      language: $('asr-language').value.trim() || (isVolcano ? 'en-US' : 'en'),
      audioFormat: isVolcano ? 'wav16k' : $('asr-audio-format').value,
      sliceSeconds: util.clamp(+$('asr-slice').value || 60, 15, 300),
      fieldName: 'file',
      extraHeaders: $('asr-headers').value,
      verboseJson: $('asr-preset').value !== 'volc-ark',   // 方舟 ASR 不带 verbose_json 可选参数
      apiKey: $('asr-api-key').value.trim(),
      appKey: $('asr-app-key').value.trim(),
      accessKey: $('asr-access-key').value.trim(),
      resourceId: $('asr-resource-id').value.trim() || 'volc.bigasr.auc_turbo'
    };
    asrCfg.enabled = isVolcano
      ? !!(asrCfg.apiKey || (asrCfg.appKey && asrCfg.accessKey))
      : !!asrCfg.endpoint;
    return {
      asr: asrCfg,
      llm: {
        enabled: !!($('llm-endpoint').value.trim() && $('llm-token').value.trim()),
        endpoint: $('llm-endpoint').value.trim(),
        token: $('llm-token').value.trim(),
        model: $('llm-model').value.trim() || 'gpt-4o-mini',
        protocol: 'openai-chat',
        temperature: 0.4
      },
      translate: {
        enabled: !!$('tr-endpoint').value.trim(),
        endpoint: $('tr-endpoint').value.trim(),
        token: $('tr-token').value.trim(),
        model: $('tr-model').value.trim(),
        protocol: 'openai-chat',
        temperature: 0.2
      }
    };
  }

  $('save-config').addEventListener('click', function () {
    FE.store.setConfig(collectConfig()).then(function () {
      var tip = $('save-tip');
      tip.textContent = '已保存到本地';
      tip.classList.add('is-ok');
      setTimeout(function () { tip.textContent = ''; }, 2500);
    });
  });

  $('llm-test').addEventListener('click', function () {
    var result = $('llm-test-result');
    result.textContent = '测试中…';
    result.className = 'test-result';
    var cfg = collectConfig();
    if (!cfg.llm.endpoint || !cfg.llm.token) {
      result.textContent = '请先填写 LLM 地址与 Token';
      result.classList.add('is-bad');
      return;
    }
    FE.store.setConfig(cfg).then(function () {
      return new Promise(function (resolve) {
        chrome.runtime.sendMessage({
          type: FE.MSG.CHAT,
          purpose: 'define',
          messages: [
            { role: 'system', content: 'Reply with exactly: ok' },
            { role: 'user', content: 'ping' }
          ]
        }, resolve);
      });
    }).then(function (res) {
      if (res && res.ok) {
        result.textContent = '连接成功：' + String(res.text || '').slice(0, 40);
        result.classList.add('is-ok');
      } else {
        result.textContent = '失败：' + ((res && res.error) || '未知错误');
        result.classList.add('is-bad');
      }
    });
  });

  /* ================= 缓存管理 ================= */
  function fmtBytes(n) {
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(2) + ' MB';
  }

  function renderCache() {
    var listEl = $('cache-list');
    listEl.innerHTML = '<div class="empty">加载中…</div>';
    Promise.all([FE.store.listVideos(), FE.store.usageBytes()]).then(function (r) {
      var list = r[0], bytes = r[1];
      $('cache-usage').textContent = '占用 ' + fmtBytes(bytes) + ' · ' + list.length + ' 个视频';
      if (!list.length) {
        listEl.innerHTML = '<div class="empty">暂无缓存。到 B 站视频页点击 flowenglish 按钮开始学习。</div>';
        return;
      }
      listEl.innerHTML = list.map(function (v) {
        return '<div class="cache-row" data-key="' + h(v.key) + '">' +
          '<div class="cache-main">' +
            '<div class="cache-title">' + h(v.title || v.bvid) +
              (v.page > 1 ? '<span class="cache-part">P' + v.page + (v.partTitle ? ' ' + h(v.partTitle) : '') + '</span>' : '') +
            '</div>' +
            '<div class="cache-meta">' +
              '<span class="tag ' + (v.source === 'asr' ? 'tag-green' : 'tag-blue') + '">' + (v.source === 'asr' ? 'ASR' : '原生字幕') + '</span>' +
              (v.partial ? '<span class="tag tag-warn">未完成</span>' : '') +
              '<span>' + v.cues + ' 句字幕</span><span>' + v.words + ' 生词</span><span>' + v.notes + ' 笔记</span>' +
              '<span>' + new Date(v.updatedAt).toLocaleString('zh-CN') + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="cache-actions">' +
            '<button class="btn btn-ghost btn-sm" data-act="open" type="button">打开视频</button>' +
            '<button class="btn btn-ghost btn-sm" data-act="md" type="button">导出 MD</button>' +
            '<button class="btn btn-danger btn-sm" data-act="del" type="button">删除</button>' +
          '</div>' +
        '</div>';
      }).join('');

      listEl.querySelectorAll('.cache-row').forEach(function (row) {
        var key = row.getAttribute('data-key');
        row.querySelectorAll('[data-act]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            var act = btn.getAttribute('data-act');
            if (act === 'open') {
              FE.store.getVideoByKey(key).then(function (rec) {
                if (rec) {
                  var url = 'https://www.bilibili.com/video/' + rec.bvid + (rec.page > 1 ? '/?p=' + rec.page : '');
                  window.open(url, '_blank');
                }
              });
            } else if (act === 'md') {
              FE.store.getVideoByKey(key).then(function (rec) {
                if (!rec) return;
                FE.exporter.download(FE.exporter.safeName(rec.title || rec.bvid) + '.md', FE.exporter.recToMarkdown(rec), 'text/markdown;charset=utf-8');
              });
            } else if (act === 'del') {
              FE.store.getVideoByKey(key).then(function (rec) {
                if (!rec) return;
                if (!confirm('删除「' + (rec.title || rec.bvid) + '」的缓存？\n字幕、生词、笔记、练习记录将一并清除，不可恢复。')) return;
                FE.store.deleteVideo(rec.bvid, rec.page).then(renderCache);
              });
            }
          });
        });
      });
    });
  }

  $('cache-refresh').addEventListener('click', renderCache);

  /* ================= 全局生词本 ================= */
  function renderWords() {
    var listEl = $('words-list');
    listEl.innerHTML = '<div class="empty">加载中…</div>';
    FE.store.allWords().then(function (words) {
      if (!words.length) {
        listEl.innerHTML = '<div class="empty">暂无生词。在视频字幕里划选英文单词即可加入。</div>';
        return;
      }
      listEl.innerHTML =
        '<div class="words-count">共 ' + words.length + ' 个生词</div>' +
        words.map(function (w) {
          var link = 'https://www.bilibili.com/video/' + w.bvid + (w.page > 1 ? '/?p=' + w.page : '') + '?t=' + Math.floor(w.start || 0);
          return '<div class="word-row" data-key="' + h(util.videoKey(w.bvid, w.page)) + '" data-id="' + h(w.id) + '">' +
            '<div class="word-main">' +
              '<span class="word-text">' + h(w.word) + '</span>' +
              (w.note ? '<span class="word-note">' + h(w.note) + '</span>' : '') +
            '</div>' +
            '<div class="word-ctx" title="' + h(w.context || '') + '">' + h(w.context || '') + '</div>' +
            '<div class="word-side">' +
              '<a class="word-link" href="' + h(link) + '" target="_blank" rel="noopener">' + h(util.formatTime(w.start)) + ' ↗</a>' +
              '<button class="mini-btn danger" data-act="del" type="button" title="删除">✕</button>' +
            '</div>' +
          '</div>';
        }).join('');

      listEl.querySelectorAll('.word-row [data-act="del"]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var rowEl = btn.closest('.word-row');
          var key = rowEl.getAttribute('data-key');
          var id = rowEl.getAttribute('data-id');
          FE.store.getVideoByKey(key).then(function (rec) {
            if (!rec) return;
            rec.words = (rec.words || []).filter(function (w) { return w.id !== id; });
            FE.store.saveVideo(rec).then(renderWords);
          });
        });
      });
    });
  }

  $('words-refresh').addEventListener('click', renderWords);
  $('words-export').addEventListener('click', function () {
    FE.store.allWords().then(function (words) {
      FE.exporter.download('flowenglish_words.csv', FE.exporter.wordsToCsv(words), 'text/csv;charset=utf-8');
    });
  });

  /* ================= 备份 ================= */
  $('backup-export').addEventListener('click', function () {
    FE.store.exportAll().then(function (data) {
      var name = 'flowenglish_backup_' + new Date().toISOString().slice(0, 10) + '.json';
      FE.exporter.download(name, FE.exporter.toJson(data), 'application/json;charset=utf-8');
      $('backup-tip').textContent = '已导出 ' + name;
    });
  });

  $('backup-import').addEventListener('change', function (e) {
    var file = e.target.files && e.target.files[0];
    if (!file) return;
    var mode = $('backup-mode').value;
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(String(reader.result)); }
      catch (err) {
        $('backup-tip').textContent = '文件解析失败：不是有效的 JSON';
        return;
      }
      if (!data || !data.videos) {
        $('backup-tip').textContent = '文件格式不正确（缺少 videos 字段）';
        return;
      }
      if (mode === 'overwrite' && !confirm('覆盖导入会先清空现有全部视频缓存，确定继续？')) return;
      FE.store.importAll(data, mode).then(function (r) {
        $('backup-tip').textContent = '导入完成：写入 ' + r.imported + ' 条视频缓存';
        e.target.value = '';
      });
    };
    reader.readAsText(file);
  });

  /* ================= 启动 ================= */
  FE.store.getConfig().then(function (cfg) {
    fillConfig(cfg);
    return consumePendingSection();
  }).then(function (pending) {
    if (pending) {
      location.hash = '#' + pending;
      showSection(pending);
    } else {
      navFromHash();
    }
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
