/* FlowEnglish - exporter：SRT / Markdown / CSV / JSON 备份，全部在浏览器本地完成 */
(function (global) {
  'use strict';

  var FE = (global.FlowEnglish = global.FlowEnglish || {});
  var util = FE.util;
  var exp = (FE.exporter = {});

  exp.download = function (filename, content, mime) {
    mime = mime || 'text/plain;charset=utf-8';
    var blob = content instanceof Blob ? content : new Blob([content], { type: mime });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1500);
  };

  exp.safeName = function (s, fallback) {
    var t = String(s || '').replace(/[\\/:*?"<>|\n\r\t]+/g, '_').trim();
    t = t.replace(/\s+/g, ' ').slice(0, 60);
    return t || (fallback || 'flowenglish');
  };

  exp.toCsv = function (rows) {
    var lines = [];
    (rows || []).forEach(function (row) {
      lines.push(row.map(function (cell) {
        var v = cell == null ? '' : String(cell);
        if (/[",\n\r]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"';
        return v;
      }).join(','));
    });
    return '﻿' + lines.join('\r\n');
  };

  exp.wordsToCsv = function (words) {
    return exp.toCsv([['word', 'context', 'note', 'video', 'page', 'timestamp', 'link', 'addedAt']].concat(
      (words || []).map(function (w) {
        return [
          w.word || '',
          w.context || '',
          w.note || '',
          w.title || w.bvid || '',
          w.page || '',
          util.formatTime(w.start),
          w.bvid ? 'https://www.bilibili.com/video/' + w.bvid + (w.page && w.page > 1 ? '/?p=' + w.page : '') + '?t=' + Math.floor(w.start || 0) : '',
          w.addedAt ? new Date(w.addedAt).toLocaleString('zh-CN') : ''
        ];
      })
    ));
  };

  exp.recToMarkdown = function (rec) {
    var L = [];
    L.push('# ' + (rec.title || 'B 站视频'));
    L.push('');
    L.push('- BV：' + (rec.bvid || '-') + '　分 P：' + (rec.page || 1) + (rec.partTitle ? '（' + rec.partTitle + '）' : ''));
    L.push('- 字幕来源：' + (rec.sourceLabel || rec.source || '-') + (rec.partial ? '（未完成，字幕可能不完整）' : ''));
    L.push('- 链接：<https://www.bilibili.com/video/' + (rec.bvid || '') + (rec.page > 1 ? '/?p=' + rec.page : '') + '>');
    L.push('- 更新时间：' + new Date(rec.updatedAt || Date.now()).toLocaleString('zh-CN'));
    L.push('');

    L.push('## 笔记');
    L.push('');
    var notes = (rec.notes || []).slice().sort(function (a, b) { return (a.start || 0) - (b.start || 0); });
    if (!notes.length) {
      L.push('_（暂无笔记）_');
    } else {
      notes.forEach(function (n) {
        L.push('- **[' + util.formatTime(n.start) + ']**' + (n.ai ? ' _AI_' : '') + ' ' + String(n.text || '').replace(/\n/g, '\n  '));
      });
    }
    L.push('');

    L.push('## 生词');
    L.push('');
    var words = rec.words || [];
    if (!words.length) {
      L.push('_（暂无生词）_');
    } else {
      words.forEach(function (w) {
        L.push('- **' + (w.word || '') + '** — ' + (w.context || '') + (w.note ? '　释义：' + w.note : ''));
      });
    }
    L.push('');

    L.push('## 字幕全文');
    L.push('');
    (rec.cues || []).forEach(function (c) {
      L.push('- `[' + util.formatTime(c.start) + ']` ' + (c.text || '') + (c.zh ? '\n  - ' + c.zh : ''));
    });
    L.push('');
    return L.join('\n');
  };

  exp.recToSrt = function (rec, withZh) {
    return FE.subtitle.toSrt(rec.cues || [], { withZh: withZh });
  };

  exp.toJson = function (data) {
    return JSON.stringify(data, null, 2);
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
