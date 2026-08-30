/* FlowEnglish - capture：仅在用户确认 ASR 后才采集页面正在播放的音频，切片上传。
 * 主路径：video.captureStream() + MediaRecorder 分片；可选转码为 16kHz 单声道 WAV。
 * 加固点：
 *  1) muted 视频元素：Chrome 已知 bug 会让 MediaRecorder.start() 直接失败，
 *     采集期间临时置 volume=0 / muted=false（不产生扬声器声音），结束后恢复；
 *  2) mime 多级候选 + 无 mimeType 兜底，最大限度兼容不同浏览器；
 *  3) 录制前校验音频轨道存在、每切片校验轨道存活（播放器切换源会 end 旧轨道）；
 *  4) recorder.onerror 兜底，全部失败路径给出可理解的中文报错。
 */
(function (global) {
  'use strict';

  var FE = (global.FlowEnglish = global.FlowEnglish || {});
  var cap = (FE.capture = {});

  cap.isSupported = function (video) {
    if (!video) return false;
    var fn = video.captureStream || video.mozCaptureStream;
    return typeof fn === 'function' && typeof MediaRecorder !== 'undefined';
  };

  var audioCtx = null;
  function getAudioCtx() {
    if (!audioCtx) audioCtx = new (global.AudioContext || global.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function writeString(view, off, str) {
    for (var i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i));
  }

  function encodeWav(samples, sampleRate) {
    var numSamples = samples.length;
    var buffer = new ArrayBuffer(44 + numSamples * 2);
    var view = new DataView(buffer);
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + numSamples * 2, true);
    writeString(view, 8, 'WAVE');
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeString(view, 36, 'data');
    view.setUint32(40, numSamples * 2, true);
    var off = 44;
    for (var i = 0; i < numSamples; i++, off += 2) {
      var s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    }
    return buffer;
  }

  cap.toWav16kBlob = function (blob) {
    return blob.arrayBuffer().then(function (ab) {
      return getAudioCtx().decodeAudioData(ab);
    }).then(function (audioBuf) {
      var frames = Math.max(1, Math.ceil(audioBuf.duration * 16000));
      var offline = new OfflineAudioContext(1, frames, 16000);
      var src = offline.createBufferSource();
      src.buffer = audioBuf;
      src.connect(offline.destination);
      src.start(0);
      return offline.startRendering();
    }).then(function (rendered) {
      var samples = rendered.getChannelData(0);
      return new Blob([encodeWav(samples, 16000)], { type: 'audio/wav' });
    });
  };

  /* ---------------- mime 候选 ---------------- */
  function supportedMimes() {
    var candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/ogg', 'audio/mp4'];
    var out = [];
    candidates.forEach(function (m) {
      try { if (MediaRecorder.isTypeSupported(m)) out.push(m); } catch (e) { /* ignore */ }
    });
    return out;
  }

  /**
   * start(video, opts) -> controller
   * opts: {
   *   sliceSeconds, format: 'wav16k'|'webm',
   *   onSlice({blob, mime, offset, duration, seq}),
   *   onProgress({capturedSec, totalSec, sliceIndex, state}),
   *   onDone(), onError(err)
   * }
   */
  cap.start = function (video, opts) {
    opts = opts || {};
    var sliceSeconds = opts.sliceSeconds || 60;
    var mimeCandidates = supportedMimes();

    var running = true;
    var stopping = false;
    var seq = 0;
    var capturedSec = 0;
    var lastT = video.currentTime || 0;
    var recorder = null;
    var chunks = [];
    var sliceStart = video.currentTime || 0;
    var sliceElapsed = 0;
    var skipNextSlice = false;   // 停止/结束时丢弃过短残片
    var stream = null;

    /* muted 兼容：仅当视频原本处于静音时临时解静音（保持音量 0，不出声）。
     * 非静音视频完全不动，避免采集过程把用户正在听的音量静音掉。 */
    var prevMuted = null, prevVolume = null;
    function unmuteForCapture() {
      try {
        if (video.muted) {
          prevMuted = true;
          prevVolume = video.volume;
          video.muted = false;
          video.volume = 0;
        }
      } catch (e) { /* ignore */ }
    }
    function restoreMute() {
      try {
        if (prevMuted !== null) video.muted = prevMuted;
        if (prevVolume !== null) video.volume = prevVolume;
      } catch (e) { /* ignore */ }
    }

    function acquireStream() {
      if (!video || video.readyState < 1) return { error: '视频还没准备好，请先点击播放再开始采集' };
      var fn = video.captureStream || video.mozCaptureStream;
      if (typeof fn !== 'function') return { error: '当前浏览器不支持页面音频采集（请使用较新版本 Chrome/Edge）' };
      var s;
      try { s = fn.call(video); } catch (e) { return { error: '获取音频流失败：' + (e && e.message || e) }; }
      if (!s || !s.getAudioTracks || !s.getAudioTracks().length) {
        return { error: '该视频没有可采集的音频轨道（可能是无声视频或播放器未初始化音频）' };
      }
      return { stream: s };
    }

    function streamAlive() {
      try {
        var tracks = stream.getAudioTracks();
        return !!(tracks.length && tracks[0].readyState !== 'ended');
      } catch (e) { return false; }
    }

    var acquired = acquireStream();
    if (acquired.error) {
      fail(new Error(acquired.error));
      return { stop: function () { return Promise.resolve(); }, isRunning: function () { return false; } };
    }
    stream = acquired.stream;
    unmuteForCapture();

    function makeRecorder() {
      var lastErr = null;
      var tries = mimeCandidates.concat([undefined]); // 最后尝试无 mimeType（用浏览器默认）
      for (var i = 0; i < tries.length; i++) {
        try {
          var r = tries[i] !== undefined ? new MediaRecorder(stream, { mimeType: tries[i] }) : new MediaRecorder(stream);
          r.ondataavailable = function (e) { if (e.data && e.data.size > 0) chunks.push(e.data); };
          r.onerror = function () {
            fail(new Error('录音过程中断（MediaRecorder 错误），请重新开始'));
          };
          r.onstop = function () {
            var blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
            chunks = [];
            /* 停止/结束时的最后一段可能极短（< 2s），内容基本为空白，直接丢弃，
             * 避免向 ASR 接口发送过短音频导致「转写失败」 */
            if (!skipNextSlice && blob.size > 0 && opts.onSlice) {
              seq++;
              opts.onSlice({
                blob: blob,
                mime: blob.type,
                offset: sliceStart,
                duration: Math.max(0.5, sliceElapsed),
                seq: seq
              });
            }
            skipNextSlice = false;
          };
          r.start();
          return r;
        } catch (e) {
          lastErr = e;
        }
      }
      throw lastErr || new Error('无法启动录音（不支持的音频格式）');
    }

    function flushSlice() {
      return new Promise(function (resolve) {
        if (!recorder || recorder.state === 'inactive') { resolve(); return; }
        recorder.addEventListener('stop', function () { resolve(); }, { once: true });
        try { recorder.stop(); } catch (e) { resolve(); }
      });
    }

    function startNextSlice() {
      /* 切片之间校验：播放器切换源会把旧音频轨道置为 ended，旧 recorder 无法复用，需重开 */
      if (!streamAlive()) {
        fail(new Error('音频轨道已结束（播放器可能切换了视频源），请重新点击开始采集'));
        return false;
      }
      try {
        recorder = makeRecorder();
        return true;
      } catch (e) {
        fail(new Error('启动录音失败：' + (e && e.message || e)));
        return false;
      }
    }

    function progress(state) {
      if (opts.onProgress) {
        opts.onProgress({
          capturedSec: capturedSec,
          totalSec: video.duration || 0,
          sliceIndex: seq,
          state: state,
          currentTime: video.currentTime || 0
        });
      }
    }

    if (!startNextSlice()) return { stop: function () { return Promise.resolve(); }, isRunning: function () { return false; } };
    progress('recording');

    var timer = setInterval(function () {
      if (!running) { clearInterval(timer); return; }
      var now = video.currentTime || 0;
      var delta = now - lastT;
      lastT = now;
      if (video.paused || video.ended || delta <= 0 || delta > 5) {
        if (video.paused && recorder && recorder.state === 'recording') {
          try { recorder.pause(); } catch (e) { /* ignore */ }
          progress('paused');
          return;
        }
        progress(video.ended ? 'ending' : 'idle');
        if (!video.ended) return;
      }
      if (!video.paused && recorder && recorder.state === 'paused') {
        try { recorder.resume(); } catch (e) { /* ignore */ }
      }
      capturedSec += delta;
      sliceElapsed += delta;
      progress('recording');

      if (sliceElapsed >= sliceSeconds || video.ended) {
        sliceElapsed = 0;
        if (!video.ended) {
          flushSlice().then(function () {
            if (!running) return;
            sliceStart = video.currentTime || 0;
            if (startNextSlice()) progress('recording');
          });
        } else {
          finish();
        }
      }
    }, 250);

    function finish() {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      flushSlice().then(function () {
        running = false;
        restoreMute();
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
        if (opts.onDone) opts.onDone();
      });
    }

    function fail(err) {
      if (stopping) return;
      stopping = true;
      clearInterval(timer);
      running = false;
      restoreMute();
      try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
      if (opts.onError) opts.onError(err instanceof Error ? err : new Error(String(err)));
    }

    return {
      stop: function () {
        if (!running) return Promise.resolve();
        stopping = true;               // 阻止并发 finish() 把手动停止误判为完整结束
        /* 最后一段不足 2 秒视为无效残片，直接丢弃不送转写 */
        skipNextSlice = sliceElapsed < 2;
        clearInterval(timer);
        running = false;
        return flushSlice().then(function () {
          restoreMute();
          try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
        });
      },
      isRunning: function () { return running; }
    };
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
