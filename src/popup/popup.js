/* FlowEnglish - popup：状态速览 + 快捷入口 */
(function (global) {
  'use strict';

  var FE = global.FlowEnglish;
  var $ = function (id) { return document.getElementById(id); };

  function setBadge(id, ok, okText, badText) {
    var el = $(id);
    el.textContent = ok ? okText : badText;
    el.classList.toggle('badge-green', !!ok);
  }

  Promise.all([FE.store.getConfig(), FE.store.listVideos(), FE.store.allWords()]).then(function (r) {
    var cfg = r[0], videos = r[1], words = r[2];
    setBadge('st-asr', !!(cfg.asr.endpoint && cfg.asr.endpoint.trim()), '已配置', '未配置');
    setBadge('st-llm', !!(cfg.llm.endpoint && cfg.llm.token), '已配置', '未配置');
    $('st-videos').textContent = videos.length + ' 个';
    $('st-words').textContent = words.length + ' 个';
  });

  $('open-options').addEventListener('click', function () {
    chrome.runtime.openOptionsPage();
  });

  $('open-bili').addEventListener('click', function () {
    chrome.tabs.create({ url: 'https://www.bilibili.com' });
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
