/* FlowEnglish - subtitle：字幕归一化 / SRT / 双语对齐 / 出题（纯函数，可单测） */
(function (global) {
  'use strict';

  var FE = (global.FlowEnglish = global.FlowEnglish || {});
  var sub = (FE.subtitle = {});

  var STOP = ('a an the and or but if then than that this these those is am are was were be been being ' +
    'do does did doing have has had having i you he she it we they me him her us them my your his its our their ' +
    'to of in on at for with from by as into about over after before under again once here there all any both each ' +
    'few more most other some such no nor not only own same so too very can will just should now what which who whom ' +
    "i'm i've it's don't that's you're we're let's gonna wanna").split(' ');
  var STOPSET = {};
  STOP.forEach(function (w) { STOPSET[w] = true; });

  /* ---------------- 归一化 ---------------- */
  // B 站字幕 JSON：{ body: [{ from, to, location, content }] }，换行用 \N
  sub.normalizeBili = function (json) {
    var body = json && json.body;
    if (!Array.isArray(body)) return [];
    var cues = body.map(function (it) {
      var text = String(it.content == null ? '' : it.content)
        .replace(/\\N/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return {
        start: +it.from || 0,
        end: Math.max(+it.to || 0, +it.from || 0),
        text: text
      };
    }).filter(function (c) { return c.text; });
    return sub.sortCues(cues);
  };

  sub.sortCues = function (cues) {
    return cues.slice().sort(function (a, b) { return a.start - b.start; });
  };

  // 去掉相邻重复（ASR 切片边界常见重叠）
  sub.dedupeCues = function (cues) {
    var out = [];
    cues.forEach(function (c) {
      var last = out[out.length - 1];
      if (last && Math.abs(last.start - c.start) < 0.3 && last.text === c.text) {
        last.end = Math.max(last.end, c.end);
        return;
      }
      if (last && c.start < last.end - 0.05 && c.text && last.text && last.text.endsWith(c.text)) {
        last.end = Math.max(last.end, c.end);
        return;
      }
      out.push(c);
    });
    return out;
  };

  /* ---------------- SRT ---------------- */
  sub.parseSrt = function (text) {
    var blocks = String(text || '').replace(/\r/g, '').split(/\n{2,}/);
    var cues = [];
    blocks.forEach(function (b) {
      var lines = b.split('\n').filter(function (l) { return l.trim() !== ''; });
      if (lines.length < 2) return;
      var timeLine = lines.find(function (l) { return l.indexOf('-->') > -1; });
      if (!timeLine) return;
      var parts = timeLine.split('-->');
      var start = FE.util.parseTime(parts[0]);
      var end = FE.util.parseTime(parts[1]);
      var textLines = lines.filter(function (l) { return l !== timeLine && !/^\d+$/.test(l.trim()); });
      var t = textLines.join(' ').trim();
      if (!t) return;
      cues.push({ start: start, end: end || start + 2, text: t });
    });
    return sub.sortCues(cues);
  };

  sub.toSrt = function (cues, opts) {
    opts = opts || {};
    var withZh = !!opts.withZh;
    return (cues || []).map(function (c, i) {
      var txt = c.text || '';
      if (withZh && c.zh) txt += '\n' + c.zh;
      return (i + 1) + '\n' + FE.util.formatTimeSrt(c.start) + ' --> ' + FE.util.formatTimeSrt(c.end) + '\n' + txt + '\n';
    }).join('\n');
  };

  /* ---------------- 双语对齐 ---------------- */
  sub.alignTranslation = function (enCues, zhCues) {
    if (!zhCues || !zhCues.length) return enCues;
    var zs = sub.sortCues(zhCues);
    var p = 0;
    return enCues.map(function (c) {
      var mid = (c.start + c.end) / 2;
      var picked = [];
      while (p < zs.length && zs[p].end < c.start) p++;
      for (var i = p; i < zs.length && zs[i].start <= c.end; i++) {
        var ov = Math.min(c.end, zs[i].end) - Math.max(c.start, zs[i].start);
        if (ov > 0.2 || (zs[i].start <= mid && zs[i].end >= mid)) picked.push(zs[i].text);
      }
      return Object.assign({}, c, { zh: picked.join(' ').trim() });
    });
  };

  /* ---------------- 时间定位 ---------------- */
  sub.findCueIndex = function (cues, t) {
    if (!cues || !cues.length) return -1;
    var lo = 0, hi = cues.length - 1, res = -1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { res = mid; lo = mid + 1; }
      else hi = mid - 1;
    }
    if (res >= 0 && t > cues[res].end + 0.5) return -1;
    return res;
  };

  /* ---------------- 分词 / 关键词 ---------------- */
  sub.tokens = function (text) {
    return String(text || '')
      .replace(/[’'](?:s|t|re|ve|ll|d|m)\b/gi, '')
      .match(/[A-Za-z][A-Za-z'-]*/g) || [];
  };

  sub.pickKeywords = function (text, n) {
    var seen = {};
    var list = sub.tokens(text)
      .map(function (w) { return w.toLowerCase(); })
      .filter(function (w) {
        if (w.length < 4 || STOPSET[w]) return false;
        if (seen[w]) return false;
        seen[w] = true;
        return true;
      })
      .sort(function (a, b) { return b.length - a.length; });
    return list.slice(0, n || 3);
  };

  /* ---------------- 填空练习（本地生成，不依赖 API） ---------------- */
  sub.buildQuiz = function (cues, opts) {
    opts = opts || {};
    var count = opts.count || 5;
    var pool = (cues || []).filter(function (c) { return (c.text || '').split(/\s+/).length >= 6; });
    if (!pool.length) pool = cues || [];
    var step = Math.max(1, Math.floor(pool.length / count));
    var items = [];
    for (var i = 0; i < pool.length && items.length < count; i += step) {
      var c = pool[i];
      var kws = sub.pickKeywords(c.text, 3);
      if (!kws.length) continue;
      var kw = kws[items.length % kws.length];
      var re = new RegExp('\\b' + kw.replace(/[-']/g, '\\$&') + '\\b', 'i');
      if (!re.test(c.text)) continue;
      items.push({
        start: c.start,
        end: c.end,
        sentence: c.text.replace(re, '____'),
        answer: kw,
        hint: (c.zh || '').slice(0, 40)
      });
    }
    return items;
  };

  /* ---------------- 翻译分批 ---------------- */
  sub.chunkCues = function (cues, maxChars, maxItems) {
    maxChars = maxChars || 1200;
    maxItems = maxItems || 20;
    var out = [], cur = [], len = 0;
    (cues || []).forEach(function (c) {
      var t = (c.text || '').trim();
      if (!t) return;
      if (cur.length && (len + t.length > maxChars || cur.length >= maxItems)) {
        out.push(cur.slice()); cur = []; len = 0;
      }
      cur.push(c); len += t.length + 1;
    });
    if (cur.length) out.push(cur);
    return out;
  };

  /* ---------------- 纯文本（供 LLM 用） ---------------- */
  sub.toPlainText = function (cues, withTime) {
    return (cues || []).map(function (c) {
      return (withTime ? '[' + FE.util.formatTime(c.start) + '] ' : '') + (c.text || '');
    }).join('\n');
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
