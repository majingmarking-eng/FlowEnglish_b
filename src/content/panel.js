/* FlowEnglish - panel：悬浮学习面板（字幕 / 生词 / 练习 / 笔记）
 * 由 index.js 调用 FE.panel.mount(anchor, host) 创建；host 提供全部业务回调。
 */
(function (global) {
  'use strict';

  var FE = (global.FlowEnglish = global.FlowEnglish || {});
  var util = FE.util;
  var h = util.escapeHtml;

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function timeChip(t, title) {
    return '<button class="fe-timechip" data-t="' + (t || 0) + '" title="' + h(title || '跳转到 ' + util.formatTime(t)) + '">' + h(util.formatTime(t)) + '</button>';
  }

  var TABS = [
    { id: 'subs', label: '字幕' },
    { id: 'words', label: '生词' },
    { id: 'quiz', label: '练习' },
    { id: 'notes', label: '笔记' }
  ];

  FE.panel = {};

  FE.panel.mount = function (anchor, host) {
    var state = {
      open: false,
      tab: 'subs',
      record: null,
      pageInfo: null,
      showChinese: false,
      currentTime: 0,
      loop: { on: false, idx: -1, a: 0, b: 0 },
      quiz: null,
      asr: null,
      wordTooltip: null,
      translateNotice: null   // {type:'unconfigured'|'failed', message, missing}
    };

    /* ============ 根节点与启动条 ============ */
    var root = el(
      '<div id="flowenglish-root">' +
        '<div class="fe-launcher">' +
          '<button class="fe-brand-btn" type="button" title="开启 FlowEnglish 学习模式">' +
            '<span class="fe-brand-dot"></span>flowenglish' +
          '</button>' +
          '<div class="fe-launcher-actions">' +
            '<button class="fe-btn fe-btn-primary fe-btn-sm" data-role="start" type="button" title="开始学习：优先缓存/原生字幕，没有才走 ASR">▶ 开始</button>' +
            '<button class="fe-btn fe-btn-ghost fe-btn-sm" data-role="pause" type="button" title="暂停：同时暂停视频，记录当前位置">⏸ 暂停</button>' +
          '</div>' +
          '<span class="fe-launcher-status">未激活 · 点击「开始」</span>' +
        '</div>' +
        '<section class="fe-panel" hidden></section>' +
      '</div>'
    );

    var launcherBtn = root.querySelector('.fe-brand-btn');
    var launcherStatus = root.querySelector('.fe-launcher-status');
    var panel = root.querySelector('.fe-panel');

    launcherBtn.addEventListener('click', function () {
      host.onLauncherClick();
    });
    root.querySelector('[data-role="start"]').addEventListener('click', function () {
      host.onStart();
    });
    root.querySelector('[data-role="pause"]').addEventListener('click', function () {
      host.onPause();
    });

    /* ============ 面板骨架 ============ */
    panel.innerHTML =
      '<header class="fe-head">' +
        '<div class="fe-head-left">' +
          '<span class="fe-brand-mini">flowenglish</span>' +
          '<span class="fe-source-badge" data-role="source" hidden></span>' +
          '<span class="fe-title" data-role="title"></span>' +
        '</div>' +
        '<nav class="fe-tabs">' + TABS.map(function (t) {
          return '<button class="fe-tab" data-tab="' + t.id + '" type="button">' + t.label + '</button>';
        }).join('') + '</nav>' +
        '<div class="fe-head-right">' +
          '<label class="fe-switch" title="中文翻译开关">' +
            '<input type="checkbox" data-role="zh-toggle"><span class="fe-switch-ui"></span><span class="fe-switch-label">中文</span>' +
          '</label>' +
          '<button class="fe-icon-btn" data-role="collapse" title="收起面板" type="button">▾</button>' +
        '</div>' +
      '</header>' +
      '<div class="fe-asr-bar" data-role="asr" hidden></div>' +
      '<div class="fe-body">' +
        '<div class="fe-pane" data-pane="subs"></div>' +
        '<div class="fe-pane" data-pane="words" hidden></div>' +
        '<div class="fe-pane" data-pane="quiz" hidden></div>' +
        '<div class="fe-pane" data-pane="notes" hidden></div>' +
      '</div>' +
      '<footer class="fe-foot">' +
        '<div class="fe-foot-left">' +
          '<button class="fe-link-btn" data-role="export-srt" type="button">SRT</button>' +
          '<button class="fe-link-btn" data-role="export-srt-zh" type="button">双语SRT</button>' +
          '<button class="fe-link-btn" data-role="export-md" type="button">Markdown</button>' +
          '<button class="fe-link-btn" data-role="export-csv" type="button">生词CSV</button>' +
        '</div>' +
        '<div class="fe-foot-right">' +
          '<button class="fe-link-btn" data-role="goto-words" type="button">全局生词本</button>' +
          '<button class="fe-link-btn" data-role="goto-settings" type="button">API 配置</button>' +
          '<button class="fe-link-btn" data-role="goto-cache" type="button">缓存管理</button>' +
          '<button class="fe-link-btn fe-danger" data-role="clear-cache" type="button">清空本视频缓存</button>' +
        '</div>' +
      '</footer>';

    var panes = {};
    root.querySelectorAll('.fe-pane').forEach(function (p) { panes[p.getAttribute('data-pane')] = p; });

    /* ============ 弹窗 / 提示 ============ */
    var modalWrap = el('<div class="fe-modal-wrap" hidden><div class="fe-modal"></div></div>');
    root.appendChild(modalWrap);
    var toastEl = el('<div class="fe-toast" hidden></div>');
    root.appendChild(toastEl);
    var toastTimer = null;

    function toast(msg, ms) {
      toastEl.textContent = msg;
      toastEl.hidden = false;
      clearTimeout(toastTimer);
      toastTimer = setTimeout(function () { toastEl.hidden = true; }, ms || 2600);
    }

    function showModal(opts) {
      var m = modalWrap.querySelector('.fe-modal');
      m.innerHTML =
        '<div class="fe-modal-title">' + h(opts.title || '提示') + '</div>' +
        '<div class="fe-modal-body">' + (opts.html || h(opts.message || '')) + '</div>' +
        '<div class="fe-modal-actions">' + (opts.actions || []).map(function (a, i) {
          return '<button class="fe-btn ' + (a.primary ? 'fe-btn-primary' : a.danger ? 'fe-btn-danger' : 'fe-btn-ghost') + '" data-act="' + i + '" type="button">' + h(a.label) + '</button>';
        }).join('') + '</div>';
      m.querySelectorAll('[data-act]').forEach(function (btn) {
        btn.addEventListener('click', function () {
          var a = opts.actions[+btn.getAttribute('data-act')];
          modalWrap.hidden = true;
          if (a && a.onClick) a.onClick();
        });
      });
      modalWrap.hidden = false;
    }
    function hideModal() { modalWrap.hidden = true; }

    /* ============ 字幕页 ============ */
    function renderSubs() {
      var p = panes.subs;
      var rec = state.record;
      if (!rec) {
        p.innerHTML =
          '<div class="fe-empty">' +
            '<div class="fe-empty-title">尚未加载字幕</div>' +
            '<div class="fe-empty-desc">点击上方 flowenglish 按钮开始，本插件不会自动运行。</div>' +
          '</div>';
        return;
      }
      var cues = rec.cues || [];
      var loopOn = state.loop.on && state.loop.idx >= 0;

      var noticeHtml = '';
      if (state.translateNotice) {
        var n = state.translateNotice;
        if (n.type === 'unconfigured') {
          noticeHtml = '<div class="fe-notice is-warn">' +
            '<span>未配置 LLM 接口，无法生成中文翻译。</span>' +
            '<button class="fe-btn fe-btn-sm" data-role="notice-settings" type="button">去配置</button>' +
          '</div>';
        } else if (n.type === 'failed') {
          noticeHtml = '<div class="fe-notice is-error">' +
            '<span>' + h(n.message || '部分句子翻译失败') + (n.missing ? '（' + n.missing + ' 句未翻译）' : '') + '</span>' +
            '<button class="fe-btn fe-btn-sm" data-role="notice-retry" type="button">重试</button>' +
          '</div>';
        } else if (n.type === 'resume') {
          noticeHtml = '<div class="fe-notice is-resume">' +
            '<span>上次 ASR 未完成，停在 <b>' + h(util.formatTime(n.stopTime)) + '</b>，可继续转写剩余部分。</span>' +
            '<button class="fe-btn fe-btn-sm" data-role="notice-resume" type="button">继续转写</button>' +
          '</div>';
        }
      }

      p.innerHTML =
        noticeHtml +
        '<div class="fe-now-card">' +
          '<div class="fe-now-meta">' +
            '<span data-role="now-time">' + h(util.formatTime(state.currentTime)) + '</span>' +
            '<span class="fe-dot-sep"></span>' +
            '<span data-role="now-idx"></span>' +
            (loopOn ? '<span class="fe-loop-badge">循环中</span>' : '') +
          '</div>' +
          '<div class="fe-now-en" data-role="now-en"></div>' +
          '<div class="fe-now-zh" data-role="now-zh"' + (state.showChinese ? '' : ' hidden') + '></div>' +
          '<div class="fe-now-actions">' +
            '<button class="fe-btn fe-btn-primary fe-btn-sm" data-role="replay" type="button" title="Alt+X">重播本句</button>' +
            '<button class="fe-btn fe-btn-ghost fe-btn-sm" data-role="loop-toggle" type="button" title="Alt+C">' + (loopOn ? '取消循环' : '循环本句') + '</button>' +
            '<button class="fe-btn fe-btn-ghost fe-btn-sm" data-role="mark" type="button">标记时间点</button>' +
          '</div>' +
        '</div>' +
        '<div class="fe-cue-list">' + cues.map(function (c, i) {
          var active = state.loop.on && state.loop.idx === i;
          return '<div class="fe-cue' + (active ? ' is-looping' : '') + '" data-i="' + i + '">' +
            '<div class="fe-cue-side">' + timeChip(c.start) +
              '<button class="fe-mini-btn" data-role="loop-cue" data-i="' + i + '" title="循环此句" type="button">⇄</button>' +
            '</div>' +
            '<div class="fe-cue-main">' +
              '<div class="fe-cue-en" data-i="' + i + '">' + h(c.text) + '</div>' +
              '<div class="fe-cue-zh"' + (state.showChinese ? '' : ' hidden') + '>' + h(c.zh || '') + '</div>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>';

      /* 交互绑定（提示条按钮仅在提示条存在时渲染，需判空） */
      var nsBtn = p.querySelector('[data-role="notice-settings"]');
      if (nsBtn) nsBtn.addEventListener('click', function () { host.openSettings('api'); });
      var nrBtn = p.querySelector('[data-role="notice-retry"]');
      if (nrBtn) nrBtn.addEventListener('click', function () { host.translateRetry(); });
      var rsBtn = p.querySelector('[data-role="notice-resume"]');
      if (rsBtn) rsBtn.addEventListener('click', function () { host.continueAsr(); });
      p.querySelector('[data-role="replay"]').addEventListener('click', function () { host.replay(); });
      p.querySelector('[data-role="loop-toggle"]').addEventListener('click', function () { host.toggleLoop(); });
      p.querySelector('[data-role="mark"]').addEventListener('click', function () {
        /* 标记时间点 -> 记入笔记：该时间点的英文 + 中文 + 我的评论 */
        var t = state.currentTime;
        var rec = state.record;
        var idx = rec && rec.cues ? FE.subtitle.findCueIndex(rec.cues, t) : -1;
        var cue = idx >= 0 ? rec.cues[idx] : null;
        var enHtml = cue && cue.text ? h(cue.text) : '<span class="fe-muted">（当前时间点没有字幕）</span>';
        var zhHtml = cue && cue.zh ? h(cue.zh) : '<span class="fe-muted">（暂无中文翻译）</span>';
        showModal({
          title: '记入笔记 · ' + util.formatTime(t),
          html:
            '<div class="fe-mark-en">' + enHtml + '</div>' +
            '<div class="fe-mark-zh">' + zhHtml + '</div>' +
            '<label class="fe-mark-label">我的评论（可选）</label>' +
            '<input class="fe-input" id="fe-mark-note" type="text" placeholder="例如：这里讲了定语从句，需要复习" style="width:100%" autocomplete="off">',
          actions: [
            { label: '取消' },
            { label: '记入笔记', primary: true, onClick: function () {
                var inp = document.getElementById('fe-mark-note');
                host.addMark(t, inp ? inp.value.trim() : '');
            } }
          ]
        });
        var inp = document.getElementById('fe-mark-note');
        if (inp) setTimeout(function () { inp.focus(); }, 30);
      });
      p.querySelectorAll('.fe-timechip').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          host.seek(+b.getAttribute('data-t'));
        });
      });
      p.querySelectorAll('[data-role="loop-cue"]').forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          host.loopCue(+b.getAttribute('data-i'));
        });
      });
      p.querySelectorAll('.fe-cue').forEach(function (row) {
        row.addEventListener('click', function () {
          var i = +row.getAttribute('data-i');
          var cue = (state.record.cues || [])[i];
          if (cue) host.seek(cue.start);
        });
      });
      /* 划词：在英文文本上 mouseup 时检测选区 */
      p.querySelectorAll('.fe-cue-en, .fe-now-en').forEach(function (node) {
        node.addEventListener('mouseup', function () {
          setTimeout(function () { handleWordSelection(node); }, 10);
        });
      });
      syncNow();
    }

    /* ============ 划词加生词 ============ */
    function hideWordTooltip() {
      if (state.wordTooltip) {
        state.wordTooltip.remove();
        state.wordTooltip = null;
      }
    }

    function handleWordSelection(anchorNode) {
      hideWordTooltip();
      var sel = global.getSelection();
      if (!sel || sel.isCollapsed) return;
      var raw = sel.toString().trim();
      var word = util.cleanWord(raw);
      if (!util.isWordLike(word)) return;
      if (!anchorNode.contains(sel.anchorNode)) return;

      var cueIdx = -1;
      var row = anchorNode.closest ? anchorNode.closest('.fe-cue') : null;
      if (row) cueIdx = +row.getAttribute('data-i');
      if (cueIdx < 0) cueIdx = FE.subtitle.findCueIndex((state.record && state.record.cues) || [], state.currentTime);
      var cue = (state.record && state.record.cues || [])[cueIdx] || null;

      var range = sel.getRangeAt(0);
      var rect = range.getBoundingClientRect();
      var tip = el(
        '<div class="fe-word-tip">' +
          '<button class="fe-btn fe-btn-primary fe-btn-sm" type="button">＋ 加入生词：<b>' + h(word) + '</b></button>' +
        '</div>'
      );
      tip.style.position = 'fixed';
      tip.style.left = Math.max(8, Math.min(rect.left, innerWidth - 200)) + 'px';
      tip.style.top = (rect.bottom + 8) + 'px';
      tip.style.zIndex = 2147483647;
      tip.querySelector('button').addEventListener('click', function () {
        host.addWord(word, cue ? cue.text : raw, cue ? cue.start : state.currentTime);
        hideWordTooltip();
        try { sel.removeAllRanges(); } catch (e) { /* ignore */ }
      });
      document.body.appendChild(tip);
      state.wordTooltip = tip;
      setTimeout(hideWordTooltip, 6000);
    }

    /* 划词提示只在首次挂载时注册一次（面板可能被 B 站重建多次，避免监听器累积） */
    if (!FE.panel._docMouseBound) {
      FE.panel._docMouseBound = true;
      document.addEventListener('mousedown', function (e) {
        document.querySelectorAll('.fe-word-tip').forEach(function (tip) {
          if (!tip.contains(e.target)) tip.remove();
        });
      });
    }

    /* ============ 当前句高亮 ============ */
    var lastCueIdx = -2;
    function syncNow() {
      var rec = state.record;
      if (!rec || !rec.cues) return;
      var idx = FE.subtitle.findCueIndex(rec.cues, state.currentTime);
      var nowTime = panel.querySelector('[data-role="now-time"]');
      var nowIdx = panel.querySelector('[data-role="now-idx"]');
      var nowEn = panel.querySelector('[data-role="now-en"]');
      var nowZh = panel.querySelector('[data-role="now-zh"]');
      if (!nowTime) return;
      nowTime.textContent = util.formatTime(state.currentTime);
      if (idx >= 0) {
        var c = rec.cues[idx];
        nowIdx.textContent = '第 ' + (idx + 1) + ' / ' + rec.cues.length + ' 句';
        if (idx !== lastCueIdx) {
          nowEn.textContent = c.text || '';
          nowZh.textContent = c.zh || '';
          var list = panel.querySelector('.fe-cue-list');
          if (list) {
            var prev = list.querySelector('.fe-cue.is-current');
            if (prev) prev.classList.remove('is-current');
            var cur = list.querySelector('.fe-cue[data-i="' + idx + '"]');
            if (cur) {
              cur.classList.add('is-current');
              if (state.autoScroll !== false) {
                cur.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
              }
            }
          }
          lastCueIdx = idx;
        }
      } else {
        nowIdx.textContent = '';
      }
    }

    /* ============ 生词页 ============ */
    function renderWords() {
      var p = panes.words;
      var rec = state.record;
      var words = (rec && rec.words) || [];
      if (!words.length) {
        p.innerHTML =
          '<div class="fe-empty">' +
            '<div class="fe-empty-title">还没有生词</div>' +
            '<div class="fe-empty-desc">在字幕里用鼠标划选一个英文单词，点「＋ 加入生词」。</div>' +
          '</div>';
        return;
      }
      p.innerHTML =
        '<div class="fe-words-list">' + words.map(function (w) {
          return '<div class="fe-word-row" data-id="' + w.id + '">' +
            '<div class="fe-word-main">' +
              '<span class="fe-word-text">' + h(w.word) + '</span>' +
              (w.note ? '<span class="fe-word-note">' + h(w.note) + '</span>' : '') +
            '</div>' +
            '<div class="fe-word-ctx" title="' + h(w.context || '') + '">' + h(w.context || '') + '</div>' +
            '<div class="fe-word-actions">' +
              timeChip(w.start) +
              '<button class="fe-mini-btn" data-role="define" data-id="' + w.id + '" title="AI 释义" type="button">✨</button>' +
              '<button class="fe-mini-btn fe-danger" data-role="del" data-id="' + w.id + '" title="删除" type="button">✕</button>' +
            '</div>' +
          '</div>';
        }).join('') + '</div>';
      p.querySelectorAll('.fe-timechip').forEach(function (b) {
        b.addEventListener('click', function () { host.seek(+b.getAttribute('data-t')); });
      });
      p.querySelectorAll('[data-role="define"]').forEach(function (b) {
        b.addEventListener('click', function () { host.defineWord(b.getAttribute('data-id')); });
      });
      p.querySelectorAll('[data-role="del"]').forEach(function (b) {
        b.addEventListener('click', function () { host.deleteWord(b.getAttribute('data-id')); });
      });
    }

    /* ============ 练习页 ============ */
    function renderQuiz() {
      var p = panes.quiz;
      var rec = state.record;
      if (!rec || !(rec.cues || []).length) {
        p.innerHTML = '<div class="fe-empty"><div class="fe-empty-title">先加载字幕再出题</div></div>';
        return;
      }
      if (!state.quiz) {
        var hist = (rec.exercises || []).slice().sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        p.innerHTML =
          '<div class="fe-quiz-intro">' +
            '<div class="fe-quiz-title">基于当前视频字幕生成填空题</div>' +
            '<div class="fe-quiz-desc">从字幕中抽取关键词挖空，共 5 题，答错可重答。完全在本地生成，不消耗 API。</div>' +
            '<button class="fe-btn fe-btn-primary" data-role="gen" type="button">生成 5 道填空题</button>' +
          '</div>' +
          (hist.length ?
            '<div class="fe-quiz-history"><div class="fe-quiz-h-title">最近练习</div>' + hist.slice(0, 5).map(function (q) {
              return '<div class="fe-quiz-h-row"><span>' + new Date(q.createdAt).toLocaleString('zh-CN') + '</span><span class="fe-quiz-score">' + q.score + ' / ' + (q.items || []).length + '</span></div>';
            }).join('') + '</div>' : '');
        p.querySelector('[data-role="gen"]').addEventListener('click', function () { host.genQuiz(); });
        return;
      }
      var q = state.quiz;
      var rows = q.items.map(function (it, i) {
        var ans = q.answers ? q.answers[i] : '';
        var ok = q.graded ? it.correct : null;
        return '<div class="fe-quiz-item' + (q.graded ? (ok ? ' is-ok' : ' is-bad') : '') + '">' +
          '<div class="fe-quiz-no">' + (i + 1) + '.</div>' +
          '<div class="fe-quiz-main">' +
            '<div class="fe-quiz-sentence">' + h(it.sentence) + '</div>' +
            (it.hint ? '<div class="fe-quiz-hint">' + h(it.hint) + '</div>' : '') +
            '<div class="fe-quiz-input-row">' +
              '<input class="fe-input" data-i="' + i + '" type="text" placeholder="填入缺失的单词" value="' + h(ans || '') + '"' + (q.graded ? ' disabled' : '') + ' autocomplete="off" spellcheck="false">' +
              (q.graded ? '<span class="fe-quiz-answer">' + h(it.answer) + '</span>' : '') +
            '</div>' +
          '</div>' +
          timeChip(it.start) +
        '</div>';
      }).join('');
      p.innerHTML =
        '<div class="fe-quiz-body">' + rows + '</div>' +
        '<div class="fe-quiz-actions">' +
          (q.graded
            ? '<span class="fe-quiz-score-big">' + q.score + ' / ' + q.items.length + '</span>' +
              '<button class="fe-btn fe-btn-primary" data-role="again" type="button">再来一组</button>'
            : '<button class="fe-btn fe-btn-primary" data-role="check" type="button">核对答案</button>' +
              '<button class="fe-btn fe-btn-ghost" data-role="restart" type="button">换一组</button>') +
        '</div>';
      p.querySelectorAll('.fe-timechip').forEach(function (b) {
        b.addEventListener('click', function () { host.seek(+b.getAttribute('data-t')); });
      });
      if (!q.graded) {
        p.querySelector('[data-role="check"]').addEventListener('click', function () {
          var answers = [];
          p.querySelectorAll('.fe-input').forEach(function (inp) {
            answers[+inp.getAttribute('data-i')] = inp.value;
          });
          host.submitQuiz(answers);
        });
        p.querySelector('[data-role="restart"]').addEventListener('click', function () { host.genQuiz(); });
      } else {
        p.querySelector('[data-role="again"]').addEventListener('click', function () { host.genQuiz(); });
      }
    }

    /* ============ 笔记页 ============ */
    function renderNotes() {
      var p = panes.notes;
      var rec = state.record;
      var notes = ((rec && rec.notes) || []).slice().sort(function (a, b) { return (a.start || 0) - (b.start || 0); });
      p.innerHTML =
        '<div class="fe-note-editor">' +
          '<textarea class="fe-textarea" data-role="note-text" rows="3" placeholder="随手记：语法点、疑问、心得…"></textarea>' +
          '<div class="fe-note-editor-actions">' +
            '<button class="fe-btn fe-btn-ghost fe-btn-sm" data-role="insert-time" type="button">插入当前时间 ' + h(util.formatTime(state.currentTime)) + '</button>' +
            '<button class="fe-btn fe-btn-primary fe-btn-sm" data-role="save" type="button">保存笔记</button>' +
            '<button class="fe-btn fe-btn-ghost fe-btn-sm" data-role="ai" type="button">✨ AI 生成笔记</button>' +
          '</div>' +
        '</div>' +
        '<div class="fe-notes-list">' + (notes.length ? notes.map(function (n) {
          return '<div class="fe-note-row">' +
            '<div class="fe-note-head">' + timeChip(n.start) +
              (n.ai ? '<span class="fe-note-ai">AI</span>' : '') +
              '<span class="fe-note-time">' + new Date(n.createdAt || Date.now()).toLocaleString('zh-CN') + '</span>' +
              '<button class="fe-mini-btn fe-danger" data-role="del" data-id="' + n.id + '" type="button">✕</button>' +
            '</div>' +
            '<div class="fe-note-text">' + h(n.text || '').replace(/\n/g, '<br>') + '</div>' +
          '</div>';
        }).join('') : '<div class="fe-empty"><div class="fe-empty-desc">暂无笔记</div></div>') + '</div>';

      p.querySelector('[data-role="insert-time"]').addEventListener('click', function () {
        var ta = p.querySelector('[data-role="note-text"]');
        ta.value = (ta.value ? ta.value + ' ' : '') + '[' + util.formatTime(state.currentTime) + '] ';
        ta.focus();
      });
      p.querySelector('[data-role="save"]').addEventListener('click', function () {
        var ta = p.querySelector('[data-role="note-text"]');
        var text = ta.value.trim();
        if (!text) return toast('先写点内容再保存');
        host.addNote(text, state.currentTime);
        ta.value = '';
      });
      p.querySelector('[data-role="ai"]').addEventListener('click', function () { host.aiNote(); });
      p.querySelectorAll('[data-role="del"]').forEach(function (b) {
        b.addEventListener('click', function () { host.deleteNote(b.getAttribute('data-id')); });
      });
      p.querySelectorAll('.fe-timechip').forEach(function (b) {
        b.addEventListener('click', function () { host.seek(+b.getAttribute('data-t')); });
      });
    }

    /* ============ 通用渲染调度 ============ */
    function renderCurrent() {
      if (state.tab === 'subs') renderSubs();
      else if (state.tab === 'words') renderWords();
      else if (state.tab === 'quiz') renderQuiz();
      else if (state.tab === 'notes') renderNotes();
    }

    /* ============ 头部 / 底部事件 ============ */
    panel.querySelectorAll('.fe-tab').forEach(function (b) {
      b.addEventListener('click', function () {
        state.tab = b.getAttribute('data-tab');
        panel.querySelectorAll('.fe-tab').forEach(function (x) {
          x.classList.toggle('is-active', x === b);
        });
        Object.keys(panes).forEach(function (k) { panes[k].hidden = k !== state.tab; });
        renderCurrent();
      });
    });
    panel.querySelector('.fe-tab[data-tab="subs"]').classList.add('is-active');

    panel.querySelector('[data-role="zh-toggle"]').addEventListener('change', function (e) {
      host.setShowChinese(e.target.checked);
    });
    panel.querySelector('[data-role="collapse"]').addEventListener('click', function () { host.collapsePanel(); });

    panel.querySelector('[data-role="export-srt"]').addEventListener('click', function () { host.exportData('srt'); });
    panel.querySelector('[data-role="export-srt-zh"]').addEventListener('click', function () { host.exportData('srt-zh'); });
    panel.querySelector('[data-role="export-md"]').addEventListener('click', function () { host.exportData('md'); });
    panel.querySelector('[data-role="export-csv"]').addEventListener('click', function () { host.exportData('csv'); });
    panel.querySelector('[data-role="goto-words"]').addEventListener('click', function () { host.openSettings('words'); });
    panel.querySelector('[data-role="goto-settings"]').addEventListener('click', function () { host.openSettings('api'); });
    panel.querySelector('[data-role="goto-cache"]').addEventListener('click', function () { host.openSettings('cache'); });
    panel.querySelector('[data-role="clear-cache"]').addEventListener('click', function () {
      showModal({
        title: '清空本视频缓存',
        message: '将删除当前视频（含本 P）的字幕、生词、笔记、练习记录，且不可恢复。',
        actions: [
          { label: '取消' },
          { label: '确认删除', danger: true, onClick: function () { host.clearCache(); } }
        ]
      });
    });

    /* ============ 对外 API ============ */
    var api = {
      root: root,

      isOpen: function () { return state.open; },

      setLauncherStatus: function (text, opts) {
        launcherStatus.textContent = text;
        opts = opts || {};
        root.classList.toggle('fe-active', !!opts.active);
        if (opts.active) launcherStatus.classList.add('is-active');
        else launcherStatus.classList.remove('is-active');
      },

      openPanel: function () {
        state.open = true;
        panel.hidden = false;
        renderCurrent();
        api.refreshMeta();
      },
      closePanel: function () {
        state.open = false;
        panel.hidden = true;
        hideModal();
      },

      refreshMeta: function () {
        var info = state.pageInfo || {};
        var rec = state.record;
        panel.querySelector('[data-role="title"]').textContent =
          (info.title || '') + (info.page > 1 ? ' · P' + info.page + (info.partTitle ? ' ' + info.partTitle : '') : '');
        var badge = panel.querySelector('[data-role="source"]');
        if (rec && rec.source) {
          badge.hidden = false;
          badge.textContent = rec.source === 'native' ? 'B站原生字幕' : 'ASR 生成' + (rec.partial ? '（未完成）' : '');
          badge.classList.toggle('is-asr', rec.source === 'asr');
        } else {
          badge.hidden = true;
        }
      },

      setPageInfo: function (info) {
        state.pageInfo = info;
        api.refreshMeta();
      },

      setRecord: function (rec) {
        state.record = rec;
        lastCueIdx = -2;
        api.refreshMeta();
        if (state.open) renderCurrent();
      },

      setShowChinese: function (v) {
        state.showChinese = !!v;
        var toggle = panel.querySelector('[data-role="zh-toggle"]');
        if (toggle) toggle.checked = state.showChinese;
        if (state.open && state.tab === 'subs') renderSubs();
      },

      syncTime: function (t) {
        state.currentTime = t;
        if (!state.open) return;
        syncNow();
        if (state.tab === 'notes') {
          var btn = panel.querySelector('[data-role="insert-time"]');
          if (btn) btn.textContent = '插入当前时间 ' + util.formatTime(t);
        }
      },

      setLoop: function (loop) {
        state.loop = loop;
        if (state.open && state.tab === 'subs') renderSubs();
      },

      setQuiz: function (q) {
        state.quiz = q;
        if (state.open && state.tab === 'quiz') renderQuiz();
      },

      setAsr: function (asr) {
        var bar = panel.querySelector('[data-role="asr"]');
        if (!asr) { bar.hidden = true; bar.innerHTML = ''; return; }
        /* 首次显示时创建，之后只改内容，避免进度刷新把「停止」按钮换掉导致点击落空 */
        if (bar.hidden) {
          bar.hidden = false;
          bar.innerHTML =
            '<div class="fe-asr-inner">' +
              '<div class="fe-asr-info">' +
                '<span class="fe-asr-state"></span>' +
                '<span class="fe-asr-detail"></span>' +
              '</div>' +
              '<div class="fe-asr-track"><div class="fe-asr-fill"></div></div>' +
              '<button class="fe-btn fe-btn-ghost fe-btn-sm" data-role="asr-stop" type="button">停止并保存</button>' +
            '</div>';
          bar.querySelector('[data-role="asr-stop"]').addEventListener('click', function () { host.stopAsr(); });
        }
        var pct = asr.totalSec > 0 ? Math.min(100, Math.round((asr.capturedSec / asr.totalSec) * 100)) : 0;
        var stateEl = bar.querySelector('.fe-asr-state');
        if (asr.error) {
          stateEl.textContent = '转写失败：' + asr.error;
          stateEl.classList.add('is-error');
        } else {
          stateEl.textContent = asr.label || '正在采集音频并转写…';
          stateEl.classList.remove('is-error');
        }
        bar.querySelector('.fe-asr-detail').textContent =
          (asr.error ? '查看 devtools console 详情（按 F12 → Console → 过滤 [FE/ASR]）· ' : '') +
          util.formatTime(asr.capturedSec) + ' / ' + util.formatTime(asr.totalSec) +
          ' · 已完成 ' + (asr.doneSlices || 0) + ' 段';
        bar.querySelector('.fe-asr-fill').style.width = pct + '%';
      },

      /* 翻译状态提示条：未配置 LLM / 部分失败 */
      setTranslateNotice: function (notice) {
        state.translateNotice = notice || null;
        if (state.open && state.tab === 'subs') renderSubs();
      },

      showConfirmAsr: function (opts) {
        showModal({
          title: '未检测到英文字幕',
          html: '<p>该视频（BV ' + h(opts.bvid) + (opts.page > 1 ? ' · P' + opts.page : '') + '）没有可用的英文字幕。</p>' +
                '<p>可以调用你在配置页填写的 <b>ASR 接口</b>，采集当前页面播放的音频生成带时间戳字幕。生成结果会<b>永久缓存在本地</b>，下次打开无需再次消耗接口。</p>' +
                (opts.configured
                  ? '<p class="fe-muted">注意：需要本页持续播放，采集时长约等于视频时长。</p>'
                  : '<p class="fe-modal-warn">尚未配置 ASR 接口，请先到「API 配置」填写地址与 Token。</p>'),
          actions: opts.configured
            ? [
                { label: '取消' },
                { label: '开始生成字幕', primary: true, onClick: opts.onConfirm }
              ]
            : [
                { label: '取消' },
                { label: '去配置 ASR 接口', primary: true, onClick: opts.onGoSettings }
              ]
        });
      },

      /* ASR 未完成时的续传选择 */
      confirmResume: function (opts) {
        showModal({
          title: '从暂停处继续',
          html: '<p>上次暂停在 <b>' + h(util.formatTime(opts.stopTime)) + '</b>（当前播放位置 ' + h(util.formatTime(opts.currentTime)) + '）。</p>' +
                '<p class="fe-muted">已转写的内容会保留并自动合并，不重复消耗。</p>',
          actions: [
            { label: '取消' },
            { label: '从暂停处继续（' + h(util.formatTime(opts.stopTime)) + '）', primary: true, onClick: opts.onFromStop },
            { label: '从当前播放位置开始', primary: true, onClick: opts.onFromNow }
          ]
        });
      },

      showError: function (message, opts) {
        showModal(Object.assign({
          title: '出错了',
          message: message,
          actions: [{ label: '知道了', primary: true }]
        }, opts || {}));
      },

      hideModal: hideModal,
      toast: toast,

      setTab: function (tab) {
        var b = panel.querySelector('.fe-tab[data-tab="' + tab + '"]');
        if (b) b.click();
      },

      setAutoScroll: function (v) { state.autoScroll = v; },

      destroy: function () {
        root.remove();
      }
    };

    /* 注入 */
    if (anchor.mode === 'after') {
      anchor.el.insertAdjacentElement('afterend', root);
    } else {
      anchor.el.appendChild(root);
    }
    return api;
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
