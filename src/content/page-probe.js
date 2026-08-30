/* FlowEnglish - page-probe：注入页面主世界（world: MAIN）
 * 只读 B 站页面状态，轮询变化后通过 document CustomEvent 广播给 content script。
 * 不访问任何扩展 API，不修改页面数据。
 */
(function () {
  'use strict';

  function currentPage() {
    var m = location.search.match(/[?&]p=(\d+)/);
    return m ? parseInt(m[1], 10) : 1;
  }

  function readState() {
    var s = window.__INITIAL_STATE__ || null;
    var bvid = null, title = '', pages = [], subtitleList = [], cid = null;

    if (s && s.videoData) {
      var vd = s.videoData;
      bvid = vd.bvid || null;
      title = vd.title || '';
      pages = Array.isArray(vd.pages) ? vd.pages : [];
      subtitleList = (vd.subtitle && Array.isArray(vd.subtitle.list)) ? vd.subtitle.list : [];
    }
    if (!bvid) {
      var m = location.pathname.match(/BV[0-9A-Za-z]{10}/);
      bvid = m ? m[0] : null;
    }
    if (!bvid) return null;

    var page = currentPage();
    var part = null;
    for (var i = 0; i < pages.length; i++) {
      if (pages[i].page === page) { part = pages[i]; break; }
    }
    if (!part && pages.length) part = pages[0];
    cid = (part && part.cid) || (s && s.videoData && s.videoData.cid) || null;

    return {
      bvid: bvid,
      page: page,
      cid: cid,
      title: title || document.title.replace(/_哔哩哔哩_bilibili.*$/, ''),
      partTitle: (part && part.part) || '',
      pages: pages.map(function (p) { return { page: p.page, cid: p.cid, part: p.part }; }),
      subtitleList: subtitleList.map(function (x) {
        return { lan: x.lan || '', lanDoc: x.lan_doc || '', url: x.subtitle_url || '', id: x.id || 0 };
      })
    };
  }

  function signature(st) {
    if (!st) return 'null';
    return [st.bvid, st.page, st.cid, st.title, st.subtitleList.length].join('|');
  }

  var lastSig = '';
  function tick() {
    var st;
    try { st = readState(); } catch (e) { st = null; }
    var sig = signature(st);
    if (sig === lastSig || !st) return;
    lastSig = sig;
    document.dispatchEvent(new CustomEvent('flowenglish:state', { detail: st }));
  }

  // SPA 路由变化时立刻补一次
  try {
    var rawPush = history.pushState, rawReplace = history.replaceState;
    history.pushState = function () {
      var r = rawPush.apply(this, arguments);
      setTimeout(tick, 120);
      setTimeout(tick, 800);
      return r;
    };
    history.replaceState = function () {
      var r = rawReplace.apply(this, arguments);
      setTimeout(tick, 120);
      return r;
    };
    window.addEventListener('popstate', function () { setTimeout(tick, 120); });
  } catch (e) { /* ignore */ }

  tick();
  setInterval(tick, 700);
})();
