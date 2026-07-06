/*!
 * RadioPlayer — bespoke embeddable online radio player (Phase 1: core widget)
 * -----------------------------------------------------------------------
 * Single-file, framework-free, CMS-agnostic embed widget.
 *
 * Usage:
 *   <script src="radio-player.js"></script>
 *   <div id="radio-player"></div>
 *   <script>
 *     RadioPlayer.init({
 *       stationId: "vawam-radio",
 *       streamUrl: "https://play.vawam.ca/stream.mp3",
 *       hlsUrl: "https://play.vawam.ca/hls/master.m3u8",
 *       apiBase: "https://play.vawam.ca",
 *       theme: "dark",
 *       defaultVisualizer: "spectrum"
 *     });
 *   </script>
 *
 * Notes on scope (Phase 1):
 *   - No ad-server integration, admin panel, or analytics backend yet.
 *   - Metadata comes from the station's real public API
 *     (/api/public/now-playing, /api/public/history, /api/public/schedule,
 *     /api/settings/public) — all confirmed CORS-open (Access-Control-Allow-Origin: *).
 *   - The audio *stream* endpoints (stream.mp3 / hls/master.m3u8) do NOT currently
 *     send Access-Control-Allow-Origin. The widget detects this at runtime and
 *     degrades gracefully: playback always works via plain <audio>, but real
 *     FFT-based visualizers and HLS-in-non-Safari-browsers require CORS to be
 *     enabled on the stream itself. No code change will be needed when that
 *     happens — detection re-runs on every load.
 */
(function (global) {
  'use strict';

  var DEFAULTS = {
    container: 'radio-player',
    stationId: '',
    streamUrl: '',
    hlsUrl: '',
    apiBase: '',
    theme: 'dark',
    defaultVisualizer: 'spectrum',
    primaryColor: null,   // falls back to /api/settings/public if not set
    secondaryColor: null,
    logoUrl: null,
    stationName: null,
    pollNowPlayingMs: 4000,
    pollHistoryMs: 30000,
    pollScheduleMs: 60000,
    hlsJsUrl: 'https://cdn.jsdelivr.net/npm/hls.js@latest'
  };

  var VISUALIZERS = ['spectrum', 'waveform', 'circular', 'particles', 'glow'];

  var EQ_BANDS_HZ = [60, 250, 1000, 4000, 12000];
  var EQ_PRESETS = {
    flat: [0, 0, 0, 0, 0],
    pop: [-1, 2, 3, 2, -1],
    rock: [4, 2, -1, 2, 3],
    jazz: [3, 1, 0, 1, 2],
    classical: [3, 2, -2, 2, 3],
    vocal: [-2, 1, 4, 3, -1]
  };

  var STORAGE_KEYS = {
    visualizer: 'radio_visualizer',
    volume: 'radio_volume',
    eqPreset: 'radio_eq_preset',
    bass: 'radio_bass',
    treble: 'radio_treble',
    widen: 'radio_widen'
  };

  // ---------------------------------------------------------------------
  // Small utilities
  // ---------------------------------------------------------------------

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    attrs = attrs || {};
    for (var k in attrs) {
      if (!attrs.hasOwnProperty(k)) continue;
      if (k === 'class') node.className = attrs[k];
      else if (k === 'html') node.innerHTML = attrs[k];
      else if (k.indexOf('data-') === 0) node.setAttribute(k, attrs[k]);
      else node[k] = attrs[k];
    }
    (children || []).forEach(function (c) { if (c) node.appendChild(c); });
    return node;
  }

  function resolveUrl(base, maybeRelative) {
    if (!maybeRelative) return maybeRelative;
    if (/^https?:\/\//i.test(maybeRelative)) return maybeRelative;
    if (!base) return maybeRelative;
    return base.replace(/\/$/, '') + '/' + maybeRelative.replace(/^\//, '');
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60);
    var s = sec % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  }

  function safeLocalStorage() {
    try {
      var k = '__rp_test__';
      window.localStorage.setItem(k, '1');
      window.localStorage.removeItem(k);
      return window.localStorage;
    } catch (e) {
      // Private mode / disabled storage: fall back to an in-memory shim
      var mem = {};
      return {
        getItem: function (key) { return mem.hasOwnProperty(key) ? mem[key] : null; },
        setItem: function (key, val) { mem[key] = String(val); },
        removeItem: function (key) { delete mem[key]; }
      };
    }
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      if (document.querySelector('script[data-rp-src="' + src + '"]')) {
        // already loading/loaded
        var check = setInterval(function () {
          if (global.Hls) { clearInterval(check); resolve(); }
        }, 50);
        setTimeout(function () { clearInterval(check); resolve(); }, 5000);
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.setAttribute('data-rp-src', src);
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Failed to load ' + src)); };
      document.head.appendChild(s);
    });
  }

  // Detect whether a media URL is actually fetchable cross-origin (i.e. the
  // server sends Access-Control-Allow-Origin for *this* page's origin).
  // A tiny ranged GET is used so we don't pull down a live stream's body.
  function detectCors(url) {
    if (!url) return Promise.resolve(false);
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    return fetch(url, {
      method: 'GET',
      mode: 'cors',
      cache: 'no-store',
      signal: controller ? controller.signal : undefined,
      headers: { Range: 'bytes=0-1' }
    }).then(function (res) {
      if (controller) controller.abort();
      return res.ok || res.status === 206 || res.status === 200;
    }).catch(function () {
      return false;
    });
  }

  // ---------------------------------------------------------------------
  // CSS (injected once, shared by all instances)
  // ---------------------------------------------------------------------

  var CSS = ''
    + '.rp-widget{--rp-primary:#ff7b00;--rp-secondary:#07cbf2;--rp-bg:#111318;--rp-bg-alt:#1b1e26;--rp-text:#f2f3f5;--rp-muted:#9aa0ab;'
    + 'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;background:var(--rp-bg);color:var(--rp-text);'
    + 'border-radius:16px;overflow:hidden;max-width:480px;box-shadow:0 8px 30px rgba(0,0,0,.35);position:relative;}'
    + '.rp-widget.rp-theme-light{--rp-bg:#ffffff;--rp-bg-alt:#f2f3f5;--rp-text:#14161a;--rp-muted:#666d7a;}'
    + '.rp-header{display:flex;align-items:center;gap:10px;padding:14px 16px;background:var(--rp-bg-alt);}'
    + '.rp-logo{width:32px;height:32px;border-radius:8px;object-fit:cover;background:var(--rp-primary);}'
    + '.rp-station-name{font-weight:700;font-size:14px;flex:1;}'
    + '.rp-live-badge{display:none;align-items:center;gap:5px;background:#e5233d;color:#fff;font-size:10px;font-weight:700;'
    + 'letter-spacing:.05em;padding:3px 8px;border-radius:20px;}'
    + '.rp-live-badge.rp-live-on{display:inline-flex;}'
    + '.rp-live-dot{width:6px;height:6px;border-radius:50%;background:#fff;animation:rp-pulse 1.2s infinite;}'
    + '@keyframes rp-pulse{0%,100%{opacity:1}50%{opacity:.25}}'
    + '.rp-viz-wrap{position:relative;width:100%;aspect-ratio:16/7;background:#000;}'
    + '.rp-viz-wrap canvas{width:100%;height:100%;display:block;}'
    + '.rp-viz-fallback-note{position:absolute;bottom:6px;right:8px;font-size:9px;color:rgba(255,255,255,.45);pointer-events:none;}'
    + '.rp-now{display:flex;gap:12px;padding:14px 16px;align-items:center;}'
    + '.rp-cover{width:56px;height:56px;border-radius:10px;object-fit:cover;flex-shrink:0;background:var(--rp-bg-alt);}'
    + '.rp-now-meta{flex:1;min-width:0;}'
    + '.rp-title{font-weight:700;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.rp-artist{font-size:12px;color:var(--rp-muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}'
    + '.rp-progress{height:3px;background:rgba(127,127,127,.3);border-radius:2px;margin-top:6px;overflow:hidden;}'
    + '.rp-progress-bar{height:100%;background:var(--rp-primary);width:0%;transition:width .25s linear;}'
    + '.rp-times{display:flex;justify-content:space-between;font-size:10px;color:var(--rp-muted);margin-top:3px;}'
    + '.rp-controls{display:flex;align-items:center;gap:10px;padding:6px 16px 14px;flex-wrap:wrap;}'
    + '.rp-play-btn{width:44px;height:44px;border-radius:50%;border:none;background:var(--rp-primary);color:#fff;font-size:16px;'
    + 'cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;}'
    + '.rp-play-btn:active{transform:scale(.94);}'
    + '.rp-volume{display:flex;align-items:center;gap:6px;flex:1;min-width:90px;}'
    + '.rp-volume input[type=range]{flex:1;accent-color:var(--rp-primary);}'
    + '.rp-select{background:var(--rp-bg-alt);color:var(--rp-text);border:1px solid rgba(127,127,127,.3);border-radius:8px;'
    + 'font-size:11px;padding:5px 6px;}'
    + '.rp-icon-btn{background:var(--rp-bg-alt);border:1px solid rgba(127,127,127,.3);color:var(--rp-text);border-radius:8px;'
    + 'font-size:12px;padding:5px 8px;cursor:pointer;}'
    + '.rp-section{border-top:1px solid rgba(127,127,127,.15);}'
    + '.rp-section-header{display:flex;justify-content:space-between;align-items:center;padding:10px 16px;cursor:pointer;'
    + 'font-size:12px;font-weight:700;color:var(--rp-muted);text-transform:uppercase;letter-spacing:.04em;}'
    + '.rp-section-body{padding:0 16px 12px;font-size:12px;max-height:180px;overflow-y:auto;}'
    + '.rp-section-body.rp-collapsed{display:none;}'
    + '.rp-list-item{display:flex;justify-content:space-between;gap:8px;padding:6px 0;border-bottom:1px solid rgba(127,127,127,.08);}'
    + '.rp-list-item:last-child{border-bottom:none;}'
    + '.rp-list-title{font-weight:600;}'
    + '.rp-list-sub{color:var(--rp-muted);white-space:nowrap;}'
    + '.rp-share-row{display:flex;gap:8px;padding:10px 16px 16px;flex-wrap:wrap;}'
    + '.rp-share-btn{background:var(--rp-bg-alt);border:1px solid rgba(127,127,127,.3);color:var(--rp-text);border-radius:20px;'
    + 'font-size:11px;padding:6px 10px;cursor:pointer;}'
    + '.rp-empty{color:var(--rp-muted);font-style:italic;}'
    + '.rp-toast{position:absolute;bottom:10px;left:50%;transform:translateX(-50%);background:rgba(0,0,0,.85);color:#fff;'
    + 'font-size:11px;padding:6px 12px;border-radius:20px;opacity:0;transition:opacity .2s;pointer-events:none;}'
    + '.rp-toast.rp-show{opacity:1;}';

  function injectCss() {
    if (document.getElementById('rp-styles')) return;
    var style = el('style', { id: 'rp-styles', html: CSS });
    document.head.appendChild(style);
  }

  // ---------------------------------------------------------------------
  // Visualizer renderers
  // Each takes (ctx, w, h, data, kind) where data is a Uint8Array (freq or
  // time-domain depending on visualizer) and kind is 'real' or 'simulated'.
  // ---------------------------------------------------------------------

  var simPhase = 0;

  function simulatedBars(n) {
    // Procedural "fake but lively" energy so the UI still feels reactive
    // when the browser can't read real FFT data (stream lacks CORS).
    simPhase += 0.06;
    var out = new Uint8Array(n);
    for (var i = 0; i < n; i++) {
      var v = 128 + 90 * Math.sin(simPhase * 1.7 + i * 0.5)
        + 40 * Math.sin(simPhase * 3.1 + i * 0.13)
        + 20 * Math.sin(simPhase * 0.4 + i);
      out[i] = Math.max(4, Math.min(255, v));
    }
    return out;
  }

  var Visualizers = {
    spectrum: function (ctx, w, h, data, color) {
      ctx.clearRect(0, 0, w, h);
      var barCount = 48;
      var step = Math.floor(data.length / barCount) || 1;
      var barW = w / barCount;
      for (var i = 0; i < barCount; i++) {
        var v = data[i * step] / 255;
        var barH = Math.max(2, v * h);
        var grad = ctx.createLinearGradient(0, h - barH, 0, h);
        grad.addColorStop(0, color.secondary);
        grad.addColorStop(1, color.primary);
        ctx.fillStyle = grad;
        ctx.fillRect(i * barW + 1, h - barH, barW - 2, barH);
      }
    },
    waveform: function (ctx, w, h, data, color) {
      ctx.clearRect(0, 0, w, h);
      ctx.lineWidth = 2;
      ctx.strokeStyle = color.primary;
      ctx.beginPath();
      var sliceW = w / data.length;
      var x = 0;
      for (var i = 0; i < data.length; i++) {
        var v = data[i] / 128.0;
        var y = (v * h) / 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
        x += sliceW;
      }
      ctx.stroke();
    },
    circular: function (ctx, w, h, data, color) {
      ctx.clearRect(0, 0, w, h);
      var cx = w / 2, cy = h / 2;
      var radius = Math.min(w, h) * 0.22;
      var points = 64;
      var step = Math.floor(data.length / points) || 1;
      ctx.beginPath();
      for (var i = 0; i <= points; i++) {
        var v = data[(i % points) * step] / 255;
        var r = radius + v * radius * 1.4;
        var angle = (i / points) * Math.PI * 2;
        var x = cx + Math.cos(angle) * r;
        var y = cy + Math.sin(angle) * r;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.strokeStyle = color.primary;
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = color.secondary + '33';
      ctx.fill();
    },
    particles: (function () {
      var particles = null;
      return function (ctx, w, h, data, color) {
        ctx.clearRect(0, 0, w, h);
        var n = 40;
        if (!particles) {
          particles = [];
          for (var i = 0; i < n; i++) {
            particles.push({ x: Math.random() * w, y: Math.random() * h, vy: 0.2 + Math.random() * 0.6 });
          }
        }
        for (var j = 0; j < n; j++) {
          var p = particles[j];
          var v = data[j % data.length] / 255;
          p.y -= p.vy * (0.5 + v * 2);
          if (p.y < -10) { p.y = h + 10; p.x = Math.random() * w; }
          var size = 1.5 + v * 4;
          ctx.beginPath();
          ctx.arc(p.x, p.y, size, 0, Math.PI * 2);
          ctx.fillStyle = j % 2 === 0 ? color.primary : color.secondary;
          ctx.globalAlpha = 0.35 + v * 0.6;
          ctx.fill();
          ctx.globalAlpha = 1;
        }
      };
    })(),
    glow: function (ctx, w, h, data, color) {
      ctx.clearRect(0, 0, w, h);
      var sum = 0;
      for (var i = 0; i < data.length; i++) sum += data[i];
      var avg = sum / data.length / 255;
      var cx = w / 2, cy = h / 2;
      var r = Math.min(w, h) * (0.15 + avg * 0.35);
      var grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
      grad.addColorStop(0, color.primary + 'cc');
      grad.addColorStop(0.6, color.secondary + '55');
      grad.addColorStop(1, 'transparent');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fill();
    }
  };

  // ---------------------------------------------------------------------
  // Main instance
  // ---------------------------------------------------------------------

  function RadioPlayerInstance(config) {
    this.cfg = config;
    this.storage = safeLocalStorage();
    this.audio = null;
    this.audioCtx = null;
    this.analyser = null;
    this.sourceNode = null;
    this.chainNodes = {};
    this.hls = null;
    this.usingCors = false;
    this.corsBlockedFrames = 0;
    this.simulatedViz = false;
    this.retryCount = 0;
    this.retryTimer = null;
    this.dom = {};
    this.state = {
      playing: false,
      visualizer: this.storage.getItem(STORAGE_KEYS.visualizer) || config.defaultVisualizer,
      volume: parseFloat(this.storage.getItem(STORAGE_KEYS.volume)) || 0.8,
      eqPreset: this.storage.getItem(STORAGE_KEYS.eqPreset) || 'flat'
    };
    this._sectionsCollapsed = {};
  }

  RadioPlayerInstance.prototype.init = function () {
    injectCss();
    this._buildDom();
    this._applyTheme({
      primaryColor: this.cfg.primaryColor,
      secondaryColor: this.cfg.secondaryColor,
      logoUrl: this.cfg.logoUrl,
      stationName: this.cfg.stationName
    });
    this._loadSettings();
    this._setupAudioElement();
    this._startMetadataPolling();
    this._resizeCanvas();
    var self = this;
    window.addEventListener('resize', function () { self._resizeCanvas(); });
    this._pickVisualizer(this.state.visualizer, true);
    this._renderLoop();
    return this;
  };

  // -- DOM ---------------------------------------------------------------

  RadioPlayerInstance.prototype._buildDom = function () {
    var container = typeof this.cfg.container === 'string'
      ? document.getElementById(this.cfg.container)
      : this.cfg.container;
    if (!container) {
      throw new Error('RadioPlayer: container "' + this.cfg.container + '" not found.');
    }
    var d = this.dom;

    d.wrapper = el('div', { class: 'rp-widget' + (this.cfg.theme === 'light' ? ' rp-theme-light' : '') });

    // Header
    d.logo = el('img', { class: 'rp-logo', src: this.cfg.logoUrl || '', alt: 'logo' });
    d.stationName = el('div', { class: 'rp-station-name' }, [document.createTextNode(this.cfg.stationName || this.cfg.stationId || 'Radio')]);
    d.liveBadge = el('span', { class: 'rp-live-badge' }, [el('span', { class: 'rp-live-dot' }), document.createTextNode(' LIVE')]);
    d.header = el('div', { class: 'rp-header' }, [d.logo, d.stationName, d.liveBadge]);

    // Visualizer
    d.canvas = el('canvas');
    d.vizNote = el('div', { class: 'rp-viz-fallback-note' });
    d.vizWrap = el('div', { class: 'rp-viz-wrap' }, [d.canvas, d.vizNote]);

    // Now playing
    d.cover = el('img', { class: 'rp-cover', src: '', alt: 'cover art' });
    d.title = el('div', { class: 'rp-title' }, [document.createTextNode('Connecting…')]);
    d.artist = el('div', { class: 'rp-artist' }, [document.createTextNode('')]);
    d.progressBar = el('div', { class: 'rp-progress-bar' });
    d.progress = el('div', { class: 'rp-progress' }, [d.progressBar]);
    d.timeElapsed = el('span', {}, [document.createTextNode('0:00')]);
    d.timeDuration = el('span', {}, [document.createTextNode('0:00')]);
    d.times = el('div', { class: 'rp-times' }, [d.timeElapsed, d.timeDuration]);
    d.nowMeta = el('div', { class: 'rp-now-meta' }, [d.title, d.artist, d.progress, d.times]);
    d.now = el('div', { class: 'rp-now' }, [d.cover, d.nowMeta]);

    // Controls
    var self = this;
    d.playBtn = el('button', { class: 'rp-play-btn', type: 'button' }, []);
    d.playBtn.innerHTML = '&#9658;';
    d.playBtn.addEventListener('click', function () { self.toggle(); });

    d.volumeInput = el('input', { type: 'range', min: '0', max: '1', step: '0.01', value: String(this.state.volume) });
    d.volumeInput.addEventListener('input', function () { self.setVolume(parseFloat(this.value)); });
    d.volume = el('div', { class: 'rp-volume' }, [document.createTextNode('🔊'), d.volumeInput]);

    d.vizSelect = el('select', { class: 'rp-select' });
    VISUALIZERS.forEach(function (v) {
      var opt = el('option', { value: v });
      opt.textContent = v.charAt(0).toUpperCase() + v.slice(1);
      d.vizSelect.appendChild(opt);
    });
    d.vizSelect.value = this.state.visualizer;
    d.vizSelect.addEventListener('change', function () { self.setVisualizer(this.value); });

    d.eqSelect = el('select', { class: 'rp-select' });
    Object.keys(EQ_PRESETS).forEach(function (p) {
      var opt = el('option', { value: p });
      opt.textContent = p.charAt(0).toUpperCase() + p.slice(1);
      d.eqSelect.appendChild(opt);
    });
    d.eqSelect.value = this.state.eqPreset;
    d.eqSelect.addEventListener('change', function () { self.setEQPreset(this.value); });

    d.controls = el('div', { class: 'rp-controls' }, [d.playBtn, d.volume, d.vizSelect, d.eqSelect]);

    // Up next
    d.upNextBody = el('div', { class: 'rp-section-body' }, [el('div', { class: 'rp-empty' }, [document.createTextNode('Queue is empty')])]);
    d.upNextSection = this._buildSection('Up Next', d.upNextBody, 'upNext');

    // History
    d.historyBody = el('div', { class: 'rp-section-body rp-collapsed' }, [el('div', { class: 'rp-empty' }, [document.createTextNode('No recently played tracks')])]);
    d.historySection = this._buildSection('Recently Played', d.historyBody, 'history');

    // Schedule
    d.scheduleBody = el('div', { class: 'rp-section-body rp-collapsed' }, [el('div', { class: 'rp-empty' }, [document.createTextNode('No scheduled shows')])]);
    d.scheduleSection = this._buildSection('Schedule', d.scheduleBody, 'schedule');

    // Share
    d.shareRow = this._buildShareRow();

    d.toast = el('div', { class: 'rp-toast' });

    d.wrapper.appendChild(d.header);
    d.wrapper.appendChild(d.vizWrap);
    d.wrapper.appendChild(d.now);
    d.wrapper.appendChild(d.controls);
    d.wrapper.appendChild(d.upNextSection);
    d.wrapper.appendChild(d.historySection);
    d.wrapper.appendChild(d.scheduleSection);
    d.wrapper.appendChild(d.shareRow);
    d.wrapper.appendChild(d.toast);

    container.innerHTML = '';
    container.appendChild(d.wrapper);
  };

  RadioPlayerInstance.prototype._buildSection = function (label, body, key) {
    var self = this;
    var arrow = el('span', {}, [document.createTextNode('▾')]);
    var header = el('div', { class: 'rp-section-header' }, [document.createTextNode(label), arrow]);
    header.addEventListener('click', function () {
      body.classList.toggle('rp-collapsed');
      arrow.textContent = body.classList.contains('rp-collapsed') ? '▸' : '▾';
    });
    if (body.classList.contains('rp-collapsed')) arrow.textContent = '▸';
    return el('div', { class: 'rp-section' }, [header, body]);
  };

  RadioPlayerInstance.prototype._buildShareRow = function () {
    var self = this;
    var row = el('div', { class: 'rp-share-row' });
    var makeBtn = function (label, handler) {
      var b = el('button', { class: 'rp-share-btn', type: 'button' }, []);
      b.textContent = label;
      b.addEventListener('click', handler);
      return b;
    };
    var shareText = function () {
      var t = self.dom.title.textContent;
      var a = self.dom.artist.textContent;
      var station = self.cfg.stationName || self.cfg.stationId || 'this station';
      return (t && a) ? (t + ' — ' + a + ' on ' + station) : ('Listening to ' + station);
    };
    var pageUrl = function () { return global.location ? global.location.href : ''; };

    row.appendChild(makeBtn('WhatsApp', function () {
      window.open('https://wa.me/?text=' + encodeURIComponent(shareText() + ' ' + pageUrl()), '_blank');
    }));
    row.appendChild(makeBtn('Facebook', function () {
      window.open('https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(pageUrl()), '_blank');
    }));
    row.appendChild(makeBtn('Twitter/X', function () {
      window.open('https://twitter.com/intent/tweet?text=' + encodeURIComponent(shareText()) + '&url=' + encodeURIComponent(pageUrl()), '_blank');
    }));
    row.appendChild(makeBtn('SMS', function () {
      window.open('sms:?&body=' + encodeURIComponent(shareText() + ' ' + pageUrl()), '_blank');
    }));
    row.appendChild(makeBtn('Instagram', function () {
      // Instagram has no web share-intent URL; copy to clipboard as the
      // practical fallback (paste into a Story/DM).
      var text = shareText() + ' ' + pageUrl();
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () {
          self._toast('Copied — paste into Instagram');
        }, function () { self._toast('Copy failed'); });
      } else {
        self._toast('Copy not supported in this browser');
      }
    }));
    if (navigator.share) {
      row.appendChild(makeBtn('Share…', function () {
        navigator.share({ title: shareText(), url: pageUrl() }).catch(function () {});
      }));
    }
    return row;
  };

  RadioPlayerInstance.prototype._toast = function (msg) {
    var t = this.dom.toast;
    t.textContent = msg;
    t.classList.add('rp-show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(function () { t.classList.remove('rp-show'); }, 2200);
  };

  RadioPlayerInstance.prototype._applyTheme = function (opts) {
    if (opts.logoUrl) this.dom.logo.src = resolveUrl(this.cfg.apiBase, opts.logoUrl);
    if (opts.stationName) this.dom.stationName.textContent = opts.stationName;
    var root = this.dom.wrapper;
    if (opts.primaryColor) root.style.setProperty('--rp-primary', opts.primaryColor);
    if (opts.secondaryColor) root.style.setProperty('--rp-secondary', opts.secondaryColor);
  };

  RadioPlayerInstance.prototype._resizeCanvas = function () {
    var canvas = this.dom.canvas;
    var rect = this.dom.vizWrap.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, rect.width * dpr);
    canvas.height = Math.max(1, rect.height * dpr);
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };

  // -- Settings / theme from station API ----------------------------------

  RadioPlayerInstance.prototype._loadSettings = function () {
    if (!this.cfg.apiBase) return;
    var self = this;
    fetch(this.cfg.apiBase.replace(/\/$/, '') + '/api/settings/public', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (data) {
        self._applyTheme({
          primaryColor: self.cfg.primaryColor || data.primaryColor,
          secondaryColor: self.cfg.secondaryColor || data.secondaryColor,
          logoUrl: self.cfg.logoUrl || data.logoUrl,
          stationName: self.cfg.stationName || data.stationName
        });
      })
      .catch(function () { /* non-fatal: keep whatever theme was already applied */ });
  };

  // -- Playback engine ------------------------------------------------------

  RadioPlayerInstance.prototype._setupAudioElement = function () {
    var audio = document.createElement('audio');
    audio.preload = 'none';
    audio.volume = this.state.volume;
    this.audio = audio;

    var self = this;
    audio.addEventListener('playing', function () {
      self.state.playing = true;
      self.retryCount = 0;
      self.dom.playBtn.innerHTML = '&#10074;&#10074;';
    });
    audio.addEventListener('pause', function () {
      self.state.playing = false;
      self.dom.playBtn.innerHTML = '&#9658;';
    });
    audio.addEventListener('error', function () { self._scheduleReconnect('stream error'); });
    audio.addEventListener('stalled', function () { self._scheduleReconnect('stream stalled'); });
    audio.addEventListener('waiting', function () {
      // Only treat prolonged buffering as a failure; brief waits are normal.
      clearTimeout(self._waitTimer);
      self._waitTimer = setTimeout(function () {
        if (!audio.paused) self._scheduleReconnect('stream buffering timeout');
      }, 15000);
    });
    audio.addEventListener('playing', function () { clearTimeout(self._waitTimer); });

    this._chooseFormatAndLoad();
  };

  RadioPlayerInstance.prototype._chooseFormatAndLoad = function () {
    var self = this;
    var audio = this.audio;
    var cfg = this.cfg;
    var canNativeHls = cfg.hlsUrl && audio.canPlayType('application/vnd.apple.mpegurl');

    var proceed = function (useCors) {
      self.usingCors = useCors;
      if (useCors) audio.crossOrigin = 'anonymous';

      if (canNativeHls) {
        // Safari: native HLS playback works without page-level CORS; only
        // real FFT analysis needs it (handled by usingCors above).
        audio.src = cfg.hlsUrl;
        self._connectAudioGraph();
        self._playSafely();
        return;
      }
      if (useCors && cfg.hlsUrl && global.Hls) {
        self._attachHlsJs();
        return;
      }
      if (useCors && cfg.hlsUrl && !global.Hls) {
        loadScript(cfg.hlsJsUrl).then(function () { self._attachHlsJs(); })
          .catch(function () { self._useMp3(); });
        return;
      }
      self._useMp3();
    };

    // Only bother testing CORS on whichever URL we'd actually use for
    // playback/analysis (prefer HLS if present, else the mp3 stream).
    var probeUrl = cfg.hlsUrl || cfg.streamUrl;
    detectCors(probeUrl).then(proceed);
  };

  RadioPlayerInstance.prototype._attachHlsJs = function () {
    var self = this;
    var audio = this.audio;
    try {
      this.hls = new global.Hls({ liveDurationInfinity: true });
      this.hls.on(global.Hls.Events.ERROR, function (event, data) {
        if (data && data.fatal) self._scheduleReconnect('hls.js fatal error: ' + data.type);
      });
      this.hls.loadSource(this.cfg.hlsUrl);
      this.hls.attachMedia(audio);
      this._connectAudioGraph();
      this._playSafely();
    } catch (e) {
      this._useMp3();
    }
  };

  RadioPlayerInstance.prototype._useMp3 = function () {
    // Plain (non-CORS) playback: always works even when the stream lacks
    // Access-Control-Allow-Origin. Real analyser data will not be available
    // in this mode — the visualizer falls back to simulated motion.
    this.audio.crossOrigin = null;
    this.usingCors = false;
    this.audio.src = this.cfg.streamUrl;
    this._connectAudioGraph();
    this._playSafely();
  };

  RadioPlayerInstance.prototype._playSafely = function () {
    var p = this.audio.play();
    if (p && p.catch) p.catch(function () { /* likely autoplay-blocked; wait for user gesture */ });
  };

  RadioPlayerInstance.prototype._scheduleReconnect = function (reason) {
    var self = this;
    if (this.retryTimer) return; // already retrying
    var delay = Math.min(30000, 1000 * Math.pow(2, this.retryCount));
    this.retryCount++;
    console.warn('[RadioPlayer] ' + reason + ' — retrying in ' + Math.round(delay / 1000) + 's');
    try {
      global.dispatchEvent(new CustomEvent('radioplayer:failover', { detail: { reason: reason, attempt: this.retryCount } }));
    } catch (e) { /* CustomEvent not supported in ancient browsers; non-fatal */ }
    this.retryTimer = setTimeout(function () {
      self.retryTimer = null;
      self._chooseFormatAndLoad();
    }, delay);
  };

  // -- Web Audio enhancement chain ------------------------------------------

  RadioPlayerInstance.prototype._connectAudioGraph = function () {
    if (this.audioCtx) return; // already built (re-used across reconnects)
    var AudioContextClass = global.AudioContext || global.webkitAudioContext;
    if (!AudioContextClass) return; // very old browser: playback still works, no enhancements

    try {
      this.audioCtx = new AudioContextClass();
      this.sourceNode = this.audioCtx.createMediaElementSource(this.audio);

      var bass = this.audioCtx.createBiquadFilter();
      bass.type = 'lowshelf'; bass.frequency.value = 120; bass.gain.value = 0;

      var treble = this.audioCtx.createBiquadFilter();
      treble.type = 'highshelf'; treble.frequency.value = 8000; treble.gain.value = 0;

      var eqNodes = EQ_BANDS_HZ.map(function (freq) {
        var f = this.audioCtx.createBiquadFilter();
        f.type = 'peaking'; f.frequency.value = freq; f.Q.value = 1; f.gain.value = 0;
        return f;
      }, this);

      // Simple mid/side style stereo widener via splitter/merger + cross gains.
      var splitter = this.audioCtx.createChannelSplitter(2);
      var merger = this.audioCtx.createChannelMerger(2);
      var widenL = this.audioCtx.createGain();
      var widenR = this.audioCtx.createGain();
      var crossL = this.audioCtx.createGain();
      var crossR = this.audioCtx.createGain();
      widenL.gain.value = 1; widenR.gain.value = 1;
      crossL.gain.value = 0; crossR.gain.value = 0; // 0 = no widening by default

      var compressor = this.audioCtx.createDynamicsCompressor();
      compressor.threshold.value = -24;
      compressor.knee.value = 30;
      compressor.ratio.value = 12;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;

      var analyser = this.audioCtx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.8;
      this.analyser = analyser;

      // Chain: source -> bass -> treble -> eq bands -> splitter/widener/merger -> compressor -> analyser -> destination
      var node = this.sourceNode;
      node.connect(bass); node = bass;
      node.connect(treble); node = treble;
      eqNodes.forEach(function (f) { node.connect(f); node = f; });

      node.connect(splitter);
      splitter.connect(widenL, 0); splitter.connect(crossR, 0);
      splitter.connect(widenR, 1); splitter.connect(crossL, 1);
      widenL.connect(merger, 0, 0); crossL.connect(merger, 0, 0);
      widenR.connect(merger, 0, 1); crossR.connect(merger, 0, 1);

      merger.connect(compressor);
      compressor.connect(analyser);
      analyser.connect(this.audioCtx.destination);

      this.chainNodes = { bass: bass, treble: treble, eqNodes: eqNodes, compressor: compressor, crossL: crossL, crossR: crossR };
      this._applyEQPreset(this.state.eqPreset);
    } catch (e) {
      console.warn('[RadioPlayer] Web Audio graph unavailable, falling back to plain playback:', e);
      this.audioCtx = null;
      this.analyser = null;
    }
  };

  RadioPlayerInstance.prototype._applyEQPreset = function (name) {
    var gains = EQ_PRESETS[name] || EQ_PRESETS.flat;
    if (!this.chainNodes.eqNodes) return;
    this.chainNodes.eqNodes.forEach(function (node, i) { node.gain.value = gains[i] || 0; });
  };

  RadioPlayerInstance.prototype.setBassBoost = function (db) {
    if (this.chainNodes.bass) this.chainNodes.bass.gain.value = db;
  };
  RadioPlayerInstance.prototype.setTrebleBoost = function (db) {
    if (this.chainNodes.treble) this.chainNodes.treble.gain.value = db;
  };
  RadioPlayerInstance.prototype.setStereoWidth = function (amount /* 0..1 */) {
    if (this.chainNodes.crossL) {
      this.chainNodes.crossL.gain.value = -amount;
      this.chainNodes.crossR.gain.value = -amount;
    }
  };
  RadioPlayerInstance.prototype.setCompressorStrength = function (ratio) {
    if (this.chainNodes.compressor) this.chainNodes.compressor.ratio.value = ratio;
  };

  RadioPlayerInstance.prototype.setEQPreset = function (name) {
    if (!EQ_PRESETS[name]) return;
    this.state.eqPreset = name;
    this.storage.setItem(STORAGE_KEYS.eqPreset, name);
    this._applyEQPreset(name);
    if (this.dom.eqSelect) this.dom.eqSelect.value = name;
  };

  // -- Playback controls ------------------------------------------------

  RadioPlayerInstance.prototype.play = function () {
    if (this.audioCtx && this.audioCtx.state === 'suspended') this.audioCtx.resume();
    this._playSafely();
  };
  RadioPlayerInstance.prototype.pause = function () { if (this.audio) this.audio.pause(); };
  RadioPlayerInstance.prototype.toggle = function () {
    if (!this.audio) return;
    if (this.audio.paused) this.play(); else this.pause();
  };
  RadioPlayerInstance.prototype.setVolume = function (v) {
    v = Math.max(0, Math.min(1, v));
    this.state.volume = v;
    if (this.audio) this.audio.volume = v;
    this.storage.setItem(STORAGE_KEYS.volume, String(v));
    if (this.dom.volumeInput) this.dom.volumeInput.value = String(v);
  };

  // -- Visualizer selection & render loop -------------------------------

  RadioPlayerInstance.prototype._pickVisualizer = function (name, skipSave) {
    if (VISUALIZERS.indexOf(name) === -1) name = DEFAULTS.defaultVisualizer;
    this.state.visualizer = name;
    if (!skipSave) this.storage.setItem(STORAGE_KEYS.visualizer, name);
    if (this.dom.vizSelect) this.dom.vizSelect.value = name;
  };
  RadioPlayerInstance.prototype.setVisualizer = function (name) { this._pickVisualizer(name, false); };

  RadioPlayerInstance.prototype._renderLoop = function () {
    var self = this;
    var ctx = this.dom.canvas.getContext('2d');

    function frame() {
      var w = self.dom.canvas.width / (window.devicePixelRatio || 1);
      var h = self.dom.canvas.height / (window.devicePixelRatio || 1);
      var fn = Visualizers[self.state.visualizer] || Visualizers.spectrum;
      var isTimeDomain = self.state.visualizer === 'waveform';
      var data;

      if (self.analyser && self.usingCors) {
        var len = isTimeDomain ? self.analyser.fftSize : self.analyser.frequencyBinCount;
        data = new Uint8Array(len);
        if (isTimeDomain) self.analyser.getByteTimeDomainData(data);
        else self.analyser.getByteFrequencyData(data);

        var sum = 0;
        for (var i = 0; i < data.length; i++) sum += data[i];
        var silentLikely = isTimeDomain ? (sum / data.length > 126 && sum / data.length < 130) : sum === 0;

        if (self.state.playing && silentLikely) {
          self.corsBlockedFrames++;
        } else {
          self.corsBlockedFrames = 0;
        }
        self.simulatedViz = self.corsBlockedFrames > 90; // ~1.5s at 60fps of "no real data while playing"
      } else {
        self.simulatedViz = true;
      }

      if (self.simulatedViz || !self.state.playing) {
        data = simulatedBars(isTimeDomain ? 256 : 128);
        if (isTimeDomain) {
          // shift to look like a centered waveform rather than bars
          for (var k = 0; k < data.length; k++) data[k] = 128 + (data[k] - 128) * 0.4;
        }
      }

      var colors = {
        primary: getComputedStyle(self.dom.wrapper).getPropertyValue('--rp-primary').trim() || '#ff7b00',
        secondary: getComputedStyle(self.dom.wrapper).getPropertyValue('--rp-secondary').trim() || '#07cbf2'
      };
      fn(ctx, w, h, data, colors);

      self.dom.vizNote.textContent = self.simulatedViz ? 'visual mode: simulated (stream CORS not enabled)' : '';

      self._rafId = requestAnimationFrame(frame);
    }
    this._rafId = requestAnimationFrame(frame);
  };

  // -- Metadata polling ---------------------------------------------------

  RadioPlayerInstance.prototype._startMetadataPolling = function () {
    if (!this.cfg.apiBase) return;
    var self = this;
    var base = this.cfg.apiBase.replace(/\/$/, '');

    function fetchNowPlaying() {
      fetch(base + '/api/public/now-playing', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) { self._renderNowPlaying(data); })
        .catch(function () { /* keep showing last-known state */ });
    }
    function fetchHistory() {
      fetch(base + '/api/public/history', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) { self._renderHistory(data); })
        .catch(function () {});
    }
    function fetchSchedule() {
      fetch(base + '/api/public/schedule', { cache: 'no-store' })
        .then(function (r) { return r.json(); })
        .then(function (data) { self._renderSchedule(data); })
        .catch(function () {});
    }

    fetchNowPlaying(); fetchHistory(); fetchSchedule();
    this._pollTimers = [
      setInterval(fetchNowPlaying, this.cfg.pollNowPlayingMs),
      setInterval(fetchHistory, this.cfg.pollHistoryMs),
      setInterval(fetchSchedule, this.cfg.pollScheduleMs)
    ];
  };

  RadioPlayerInstance.prototype._renderNowPlaying = function (data) {
    var np = data.now_playing;
    var d = this.dom;
    if (np) {
      d.title.textContent = np.title || 'Unknown title';
      d.artist.textContent = np.artist || '';
      d.cover.src = resolveUrl(this.cfg.apiBase, np.coverArtUrl) || '';
      var elapsed = np.elapsed || 0;
      var duration = np.duration || 0;
      d.timeElapsed.textContent = fmtTime(elapsed);
      d.timeDuration.textContent = fmtTime(duration);
      d.progressBar.style.width = duration ? Math.min(100, (elapsed / duration) * 100) + '%' : '0%';
    }
    var live = !!data.live_dj_active;
    d.liveBadge.classList.toggle('rp-live-on', live);
    if (live) {
      // No dedicated DJ-name field exists in the current API response;
      // fall back to playoutSource as a label. Swap in a real field here
      // if/when the backend adds one (e.g. np.djName).
      d.artist.textContent = (np && np.playoutSource) ? np.playoutSource : 'Live now';
    }

    var upNext = data.up_next || [];
    if (upNext.length) {
      d.upNextBody.innerHTML = '';
      upNext.slice(0, 10).forEach(function (t) {
        d.upNextBody.appendChild(el('div', { class: 'rp-list-item' }, [
          el('span', { class: 'rp-list-title' }, [document.createTextNode(t.title + ' — ' + t.artist)])
        ]));
      });
    }
  };

  RadioPlayerInstance.prototype._renderHistory = function (list) {
    var d = this.dom;
    if (!list || !list.length) return;
    d.historyBody.innerHTML = '';
    list.slice(0, 20).forEach(function (t) {
      var time = t.playedAt ? new Date(t.playedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
      d.historyBody.appendChild(el('div', { class: 'rp-list-item' }, [
        el('span', { class: 'rp-list-title' }, [document.createTextNode(t.title + ' — ' + t.artist)]),
        el('span', { class: 'rp-list-sub' }, [document.createTextNode(time)])
      ]));
    });
  };

  RadioPlayerInstance.prototype._renderSchedule = function (list) {
    var d = this.dom;
    if (!list || !list.length) return;
    d.scheduleBody.innerHTML = '';
    list.forEach(function (s) {
      d.scheduleBody.appendChild(el('div', { class: 'rp-list-item' }, [
        el('span', { class: 'rp-list-title' }, [document.createTextNode(s.title || s.showName || 'Show')]),
        el('span', { class: 'rp-list-sub' }, [document.createTextNode(s.startTime || s.time || '')])
      ]));
    });
  };

  RadioPlayerInstance.prototype.destroy = function () {
    if (this._rafId) cancelAnimationFrame(this._rafId);
    (this._pollTimers || []).forEach(clearInterval);
    if (this.retryTimer) clearTimeout(this.retryTimer);
    if (this.audio) { this.audio.pause(); this.audio.src = ''; }
    if (this.hls) this.hls.destroy();
    if (this.audioCtx) this.audioCtx.close();
    if (this.dom.wrapper && this.dom.wrapper.parentNode) this.dom.wrapper.parentNode.removeChild(this.dom.wrapper);
  };

  // ---------------------------------------------------------------------
  // Public API (matches the embed shape from the spec)
  // ---------------------------------------------------------------------

  var lastInstance = null;

  var RadioPlayer = {
    init: function (config) {
      var merged = {};
      for (var k in DEFAULTS) merged[k] = DEFAULTS[k];
      for (var k2 in config) merged[k2] = config[k2];
      var instance = new RadioPlayerInstance(merged);
      instance.init();
      lastInstance = instance;
      return instance;
    },
    // Convenience top-level delegates to the most recently init'd instance,
    // matching the spec's example usage (RadioPlayer.setVisualizer(vis)).
    play: function () { if (lastInstance) lastInstance.play(); },
    pause: function () { if (lastInstance) lastInstance.pause(); },
    toggle: function () { if (lastInstance) lastInstance.toggle(); },
    setVolume: function (v) { if (lastInstance) lastInstance.setVolume(v); },
    setVisualizer: function (name) { if (lastInstance) lastInstance.setVisualizer(name); },
    setEQPreset: function (name) { if (lastInstance) lastInstance.setEQPreset(name); },
    VISUALIZERS: VISUALIZERS,
    EQ_PRESETS: Object.keys(EQ_PRESETS)
  };

  global.RadioPlayer = RadioPlayer;
})(window);
