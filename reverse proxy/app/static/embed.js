const EMBED_CFG = JSON.parse(document.getElementById('vault-embed-cfg').textContent);
const EP_ID = EMBED_CFG.episodeId;
const CATEGORY = EMBED_CFG.category;
const errEl = document.getElementById('err');
const v = document.getElementById('v');
const search = new URLSearchParams(location.search);
let autoSkipEnabled = search.get('autoskip') === '1';
const resumeSeconds = Math.max(0, Number(search.get('t') || '0') || 0);
let activeIntro = null;
let activeOutro = null;
let didResume = false;
let lastProgressPostAt = 0;

function fail(msg) {
  errEl.style.display = 'block';
  errEl.textContent = msg;
  v.style.display = 'none';
  try { parent.postMessage({ type: 'vaultceaser:player-error', message: msg }, '*'); } catch (e) {}
}
function post(type, extra) {
  try {
    parent.postMessage(Object.assign({
      type: type,
      currentTime: Number(v.currentTime || 0),
      duration: Number(v.duration || 0)
    }, extra || {}), '*');
  } catch (e) {}
}
function numeric(value) {
  var n = Number(value);
  return isFinite(n) ? n : null;
}
function rangeFrom(raw) {
  if (!raw || typeof raw !== 'object') return null;
  var start = numeric(raw.start);
  if (start === null) start = numeric(raw.from);
  if (start === null) start = numeric(raw.begin);
  var end = numeric(raw.end);
  if (end === null) end = numeric(raw.to);
  if (start === null || end === null || end <= start) return null;
  return { start: start, end: end };
}
function tryResume() {
  if (didResume || !resumeSeconds) return;
  if (v.duration && resumeSeconds >= v.duration - 4) return;
  try {
    v.currentTime = resumeSeconds;
    didResume = true;
    post('vaultceaser:player-resumed', { currentTime: resumeSeconds });
  } catch (e) {}
}
function applyAutoSkip() {
  if (!autoSkipEnabled || !v.duration || v.seeking) return;
  var t = Number(v.currentTime || 0);
  [activeIntro, activeOutro].forEach(function(r) {
    if (!r) return;
    if (t >= r.start - 0.35 && t < r.end - 0.5) {
      var next = Math.min(r.end + 0.05, Math.max(0, v.duration - 0.35));
      if (next > t) {
        v.currentTime = next;
        post('vaultceaser:player-skipped', { skippedTo: next });
      }
    }
  });
}
function attachTracks(videoEl, data) {
  (data.tracks || []).forEach(function(t, i) {
    var src = t.file || t.url;
    if (!src) return;
    var kind = String(t.kind || 'subtitles').toLowerCase();
    if (kind !== 'subtitles' && kind !== 'captions') return;
    var TK = document.createElement('track');
    TK.kind = (kind === 'captions') ? 'captions' : 'subtitles';
    TK.label = String(t.label || ('Subtitles ' + (i + 1))).replace(/</g, '');
    var lang = t.srclang || t.lang || '';
    if (lang) TK.srclang = String(lang).slice(0, 12);
    TK.src = src;
    if (t.default) TK.default = true;
    videoEl.appendChild(TK);
  });
}
function createHlsWithCdnBaseFix() {
  var Base = Hls.DefaultConfig && Hls.DefaultConfig.loader;
  if (!Base) return new Hls({ enableWorker: false });
  class FixUrlLoader extends Base {
    load(context, config, callbacks) {
      var oc = callbacks.onSuccess;
      var wrapped = Object.assign({}, callbacks, {
        onSuccess: function(response, stats, ctx, networkDetails) {
          try {
            if (response && response.url && response.url.indexOf('/api/cdn-hls') !== -1) {
              var pu = new URL(response.url, location.origin);
              var inner = pu.searchParams.get('u');
              if (inner) response = Object.assign({}, response, { url: decodeURIComponent(inner) });
            }
          } catch (e) {}
          oc(response, stats, ctx, networkDetails);
        },
      });
      super.load(context, config, wrapped);
    }
  }
  return new Hls({ enableWorker: false, loader: FixUrlLoader });
}
const qs = new URLSearchParams({ id: EP_ID });
const aid = new URLSearchParams(location.search).get('aid');
if (aid) qs.set('aid', aid);
qs.set('category', CATEGORY);
fetch(location.origin + '/api/mp/stream/getSources?' + qs.toString(), { credentials: 'omit' })
  .then(function(r) { if (!r.ok) throw new Error('getSources HTTP ' + r.status); return r.json(); })
  .then(function(data) {
    var file = (data.sources && data.sources[0] && data.sources[0].file) || '';
    if (!file) { fail('No stream in getSources response'); return; }
    activeIntro = rangeFrom(data.intro);
    activeOutro = rangeFrom(data.outro);
    attachTracks(v, data);
    var tracks = data.tracks || [];
    var preferHls = (file.indexOf('/api/cdn-hls') !== -1) || tracks.length > 0;
    if (!preferHls && v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = file;
      v.play().catch(function(){});
      return;
    }
    if (window.Hls && Hls.isSupported()) {
      var hls = createHlsWithCdnBaseFix();
      hls.loadSource(file);
      hls.attachMedia(v);
      hls.on(Hls.Events.MANIFEST_PARSED, function() { tryResume(); v.play().catch(function(){}); });
      hls.on(Hls.Events.ERROR, function(_, d) {
        if (d && d.fatal) fail('Playback error: ' + (d.type || '') + ' ' + (d.details || ''));
      });
      return;
    }
    if (v.canPlayType('application/vnd.apple.mpegurl')) {
      v.src = file;
      v.play().catch(function(){});
      return;
    }
    fail('HLS not supported in this browser');
  })
  .catch(function(e) { fail(e.message || String(e)); });
var endedSent = false;
function notifyEnded() {
  if (endedSent) return;
  endedSent = true;
  try { parent.postMessage({ type: 'vaultceaser:episode-ended' }, '*'); } catch (e) {}
}
window.addEventListener('message', function(event) {
  var data = event.data || {};
  if (data.type === 'vaultceaser:set-auto-skip') {
    autoSkipEnabled = !!data.enabled;
  }
  if (data.type === 'vaultceaser:seek' && isFinite(Number(data.seconds))) {
    v.currentTime = Math.max(0, Number(data.seconds));
  }
});
v.addEventListener('loadedmetadata', function() {
  tryResume();
  post('vaultceaser:player-ready');
});
v.addEventListener('ended', notifyEnded);
v.addEventListener('timeupdate', function() {
  applyAutoSkip();
  var now = Date.now();
  if (now - lastProgressPostAt >= 1000) {
    lastProgressPostAt = now;
    post('vaultceaser:timeupdate');
  }
  if (v.duration && !isNaN(v.duration) && v.currentTime >= v.duration - 1.5) notifyEnded();
});
