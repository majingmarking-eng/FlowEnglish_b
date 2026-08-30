/* FlowEnglish - storage：全部数据只落在浏览器本地 chrome.storage.local */
(function (global) {
  'use strict';

  var FE = (global.FlowEnglish = global.FlowEnglish || {});
  var util = FE.util;

  function area() { return global.chrome && global.chrome.storage ? global.chrome.storage.local : null; }

  function get(key) {
    return new Promise(function (resolve, reject) {
      var a = area();
      if (!a) return reject(new Error('storage unavailable'));
      a.get(key, function (o) {
        if (global.chrome.runtime && global.chrome.runtime.lastError) return reject(new Error(global.chrome.runtime.lastError.message));
        resolve(o ? o[key] : undefined);
      });
    });
  }

  function set(obj) {
    return new Promise(function (resolve, reject) {
      var a = area();
      if (!a) return reject(new Error('storage unavailable'));
      a.set(obj, function () {
        if (global.chrome.runtime && global.chrome.runtime.lastError) return reject(new Error(global.chrome.runtime.lastError.message));
        resolve(true);
      });
    });
  }

  function remove(keys) {
    return new Promise(function (resolve, reject) {
      var a = area();
      if (!a) return reject(new Error('storage unavailable'));
      a.remove(keys, function () {
        if (global.chrome.runtime && global.chrome.runtime.lastError) return reject(new Error(global.chrome.runtime.lastError.message));
        resolve(true);
      });
    });
  }

  function emptyRecord() {
    return {
      bvid: '',
      cid: null,
      page: 1,
      title: '',
      partTitle: '',
      source: '',          // native | asr
      sourceLabel: '',
      lang: 'en',
      partial: false,      // ASR 中途停止，字幕不完整
      asrStopAt: null,     // ASR 上次停止位置（秒），供刷新后续传
      cues: [],            // {start,end,text,zh}
      words: [],           // {id,word,context,start,note,addedAt}
      notes: [],           // {id,start,text,createdAt,updatedAt,ai}
      exercises: [],       // {id,createdAt,items,score}
      marks: [],           // {id,start,label,createdAt}
      createdAt: 0,
      updatedAt: 0
    };
  }

  var store = (FE.store = {
    EMPTY: emptyRecord,

    /* ---------------- 配置 ---------------- */
    getConfig: function () {
      return get(FE.KEY_CONFIG).then(function (cfg) {
        return util.merge(FE.DEFAULT_CONFIG, cfg || {});
      });
    },
    setConfig: function (patch) {
      return store.getConfig().then(function (cfg) {
        var next = util.merge(cfg, patch || {});
        return set((function () { var o = {}; o[FE.KEY_CONFIG] = next; return o; })()).then(function () { return next; });
      });
    },

    /* ---------------- 视频缓存索引 ---------------- */
    getIndex: function () {
      return get(FE.KEY_INDEX).then(function (idx) { return idx || {}; });
    },
    refreshIndex: function (rec) {
      return store.getIndex().then(function (idx) {
        var key = util.videoKey(rec.bvid, rec.page);
        idx[key] = {
          bvid: rec.bvid,
          cid: rec.cid,
          page: rec.page,
          title: rec.title,
          partTitle: rec.partTitle || '',
          source: rec.source,
          sourceLabel: rec.sourceLabel || '',
          partial: !!rec.partial,
          cues: (rec.cues || []).length,
          words: (rec.words || []).length,
          notes: (rec.notes || []).length,
          updatedAt: rec.updatedAt || Date.now()
        };
        var o = {}; o[FE.KEY_INDEX] = idx;
        return set(o).then(function () { return idx; });
      });
    },

    /* ---------------- 单视频记录 ---------------- */
    getVideo: function (bvid, page) {
      var key = util.videoKey(bvid, page);
      return get(key).then(function (rec) { return rec || null; });
    },
    getVideoByKey: function (key) {
      return get(key).then(function (rec) { return rec || null; });
    },
    saveVideo: function (rec) {
      rec.updatedAt = Date.now();
      if (!rec.createdAt) rec.createdAt = rec.updatedAt;
      var o = {}; o[util.videoKey(rec.bvid, rec.page)] = rec;
      return set(o).then(function () { return store.refreshIndex(rec).then(function () { return rec; }); });
    },
    patchVideo: function (bvid, page, patch) {
      return store.getVideo(bvid, page).then(function (rec) {
        rec = util.merge(rec || emptyRecord(), patch || {});
        rec.bvid = bvid;
        rec.page = page;
        return store.saveVideo(rec);
      });
    },
    // 删除视频缓存 => 该视频下的字幕 / 生词 / 笔记 / 练习 / 标记 一并清除
    deleteVideo: function (bvid, page) {
      var key = util.videoKey(bvid, page);
      return remove(key).then(function () {
        return store.getIndex().then(function (idx) {
          delete idx[key];
          var o = {}; o[FE.KEY_INDEX] = idx;
          return set(o);
        });
      });
    },

    /* ---------------- 全局 ---------------- */
    listVideos: function () {
      return store.getIndex().then(function (idx) {
        return Object.keys(idx).map(function (k) { return Object.assign({ key: k }, idx[k]); })
          .sort(function (a, b) { return (b.updatedAt || 0) - (a.updatedAt || 0); });
      });
    },
    allWords: function () {
      return store.listVideos().then(function (list) {
        var keys = list.map(function (v) { return v.key; });
        return new Promise(function (resolve) {
          if (!keys.length) return resolve([]);
          area().get(keys, function (o) {
            o = o || {};
            var out = [];
            list.forEach(function (v) {
              var rec = o[v.key];
              if (!rec) return;
              (rec.words || []).forEach(function (w) {
                out.push(Object.assign({}, w, {
                  bvid: v.bvid, page: v.page, title: v.title, partTitle: v.partTitle || ''
                }));
              });
            });
            out.sort(function (a, b) { return (b.addedAt || 0) - (a.addedAt || 0); });
            resolve(out);
          });
        });
      });
    },
    exportAll: function () {
      return new Promise(function (resolve) {
        var a = area();
        if (!a) return resolve({ version: FE.VERSION, exportedAt: Date.now(), videos: {} });
        a.get(null, function (all) {
          all = all || {};
          var videos = {};
          Object.keys(all).forEach(function (k) {
            if (k.indexOf('FE_V_') === 0) videos[k] = all[k];
          });
          resolve({
            app: 'FlowEnglish',
            version: FE.VERSION,
            exportedAt: new Date().toISOString(),
            config: all[FE.KEY_CONFIG] || null,
            videos: videos
          });
        });
      });
    },
    importAll: function (data, mode) {
      // mode: merge（默认，按 updatedAt 取新） | overwrite（清空后写入）
      var payload = data && data.videos ? data.videos : {};
      var keys = Object.keys(payload);
      function write() {
        if (!keys.length) return Promise.resolve({ imported: 0 });
        return new Promise(function (resolve, reject) {
          var a = area();
          a.get(keys, function (existing) {
            existing = existing || {};
            var out = {}, n = 0;
            keys.forEach(function (k) {
              var inc = payload[k];
              var cur = existing[k];
              if (mode === 'overwrite' || !cur || (inc.updatedAt || 0) >= (cur.updatedAt || 0)) {
                out[k] = inc; n++;
              }
            });
            a.set(out, function () {
              // 重建索引
              store.getIndex().then(function (idx) {
                keys.forEach(function (k) {
                  var rec = out[k] || existing[k];
                  if (!rec) return;
                  idx[k] = {
                    bvid: rec.bvid, cid: rec.cid, page: rec.page, title: rec.title,
                    partTitle: rec.partTitle || '', source: rec.source, sourceLabel: rec.sourceLabel || '',
                    partial: !!rec.partial,
                    cues: (rec.cues || []).length, words: (rec.words || []).length,
                    notes: (rec.notes || []).length, updatedAt: rec.updatedAt || Date.now()
                  };
                });
                var o = {}; o[FE.KEY_INDEX] = idx;
                a.set(o, function () { resolve({ imported: n }); });
              });
            });
          });
        });
      }
      if (mode === 'overwrite') {
        return new Promise(function (resolve) {
          area().get(null, function (all) {
            var del = Object.keys(all || {}).filter(function (k) { return k.indexOf('FE_V_') === 0; });
            if (del.length) remove(del).then(write).then(resolve);
            else write().then(resolve);
          });
        });
      }
      return write();
    },
    usageBytes: function () {
      return new Promise(function (resolve) {
        var a = area();
        if (!a || !a.getBytesInUse) return resolve(0);
        a.getBytesInUse(null, function (n) { resolve(n || 0); });
      });
    }
  });
})(typeof globalThis !== 'undefined' ? globalThis : this);
