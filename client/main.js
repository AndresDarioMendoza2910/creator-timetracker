'use strict';

/*
 * Time tracker widget.
 *
 * Talks ONLY to Creator Custom APIs (scope: Portal users) via the widget SDK,
 * which run as the logged-in portal user (server-verified identity). No Catalyst
 * backend. Timers are timestamp-based and reconstructed from WidgetGetState:
 *   work timer  = continuous/gross (Time_In -> now), keeps counting through breaks
 *   break timer = parallel; runs only while on break
 * Persist happens server-side on state transitions only; the widget re-fetches
 * state after each action. localStorage gives an instant paint on load.
 */

var API = {
  getState: 'WidgetGetState',
  checkIn: 'WidgetCheckIn',
  goOnBreak: 'WidgetGoOnBreak',
  resume: 'WidgetResume',
  checkOut: 'WidgetCheckOut'
};

var SNAPSHOT_KEY = 'timetracker_snapshot';

var engine = {
  state: 'idle',          // idle | working | on_break | checked_out
  workBaseMs: 0,          // work elapsed at the anchor moment
  breakBaseMs: 0,         // break elapsed at the anchor moment
  anchorClientMs: 0,      // Date.now() when the base values were captured
  intervalId: null
};

var el = {};
var busy = false;

// ---------- formatting ----------
function pad(n) { return (n < 10 ? '0' : '') + n; }
function fmt(ms) {
  if (!ms || ms < 0) { ms = 0; }
  var s = Math.floor(ms / 1000);
  var h = Math.floor(s / 3600); s -= h * 3600;
  var m = Math.floor(s / 60); s -= m * 60;
  return pad(h) + ':' + pad(m) + ':' + pad(s);
}
// Custom APIs that return a Map come back as the object directly; string returns
// arrive wrapped as { result: "...", code: 3000 }. Normalize to the payload object.
function unwrap(res) {
  if (res && typeof res === 'object' && res.result && typeof res.result === 'object') { return res.result; }
  return res || {};
}

// ---------- rendering ----------
function show(node, on) {
  if (!node) { return; }
  if (on) {
    if (node.style.display === 'none' || node.style.display === '') {
      node.style.display = 'block';
      node.style.opacity = '0';
      requestAnimationFrame(function () { node.style.opacity = '1'; });
    }
  } else {
    node.style.display = 'none';
  }
}

function setButtons() {
  var s = engine.state;
  show(el.btnCheckIn, s === 'idle');
  show(el.btnBreak, s === 'working');
  show(el.btnCheckOut, s === 'working');
  show(el.btnResume, s === 'on_break');
  show(el.checkedOutLabel, s === 'checked_out');
}

function render() {
  var running = (engine.state === 'working' || engine.state === 'on_break');
  var delta = running ? (Date.now() - engine.anchorClientMs) : 0;
  var work = engine.workBaseMs + (running ? delta : 0);
  var brk = engine.breakBaseMs + (engine.state === 'on_break' ? delta : 0);
  el.workTime.textContent = fmt(work);
  el.breakTime.textContent = fmt(brk);
  if (engine.state === 'on_break') { el.breakTime.classList.remove('muted'); }
  else { el.breakTime.classList.add('muted'); }
  el.breakLabel.textContent = (engine.state === 'on_break' && engine.activeBreakType) ? engine.activeBreakType : 'Break';
  show(el.workBlock, engine.state !== 'on_break');   // hide Work while on break
  setButtons();
}

function startTick() {
  stopTick();
  if (engine.state === 'working' || engine.state === 'on_break') {
    engine.intervalId = setInterval(render, 1000);
  }
}
function stopTick() { if (engine.intervalId) { clearInterval(engine.intervalId); engine.intervalId = null; } }

// ---------- state application ----------
function applyState(data, captureClientMs) {
  var s = (data && data.state) || 'idle';
  engine.state = s;
  engine.anchorClientMs = captureClientMs;
  engine.activeBreakType = null;

  if (data && data.serverDate) { el.dateLabel.textContent = 'Today · ' + data.serverDate; }

  if (s === 'idle' || s === 'checked_out') {
    engine.workBaseMs = 0;
    engine.breakBaseMs = 0;
    stopTick();
    render();
    return;
  }

  var serverNow = Number(data.serverNowMs);
  var timeIn = Number(data.timeInMs);
  engine.workBaseMs = (serverNow && timeIn) ? (serverNow - timeIn) : 0;

  var brk = 0;
  var breaks = data.breaks || [];
  for (var i = 0; i < breaks.length; i++) {
    var bi = Number(breaks[i].breakInMs);
    if (breaks[i].breakOutMs) { brk += Number(breaks[i].breakOutMs) - bi; }
    else if (bi) { brk += serverNow - bi; engine.activeBreakType = breaks[i].type; }   // open break
  }
  engine.breakBaseMs = brk > 0 ? brk : 0;

  startTick();
  render();
}

// ---------- localStorage snapshot (instant paint) ----------
function saveSnapshot(data, captureClientMs) {
  try { localStorage.setItem(SNAPSHOT_KEY, JSON.stringify({ data: data, captureClientMs: captureClientMs })); } catch (e) {}
}
function loadSnapshot() {
  try { var raw = localStorage.getItem(SNAPSHOT_KEY); return raw ? JSON.parse(raw) : null; } catch (e) { return null; }
}
function clearSnapshot() { try { localStorage.removeItem(SNAPSHOT_KEY); } catch (e) {} }

// ---------- status line ----------
function showStatus(msg) { el.statusMsg.textContent = msg || ''; }
function clearStatus() { el.statusMsg.textContent = ''; }

// ---------- server calls ----------
function call(apiName, method, payload) {
  var cfg = { api_name: apiName, http_method: method || 'GET' };
  if (payload) { cfg.payload = payload; }
  return ZOHO.CREATOR.DATA.invokeCustomApi(cfg).then(unwrap);
}

function refresh() {
  return call(API.getState, 'GET').then(function (data) {
    var now = Date.now();
    applyState(data, now);
    saveSnapshot(data, now);
    clearStatus();
  });
}

function withBusy(fn) {
  if (busy) { return Promise.resolve(); }
  busy = true; el.card.classList.add('busy');
  return Promise.resolve()
    .then(fn)
    .catch(function () { showStatus('Something went wrong. Please try again.'); })
    .then(function () { busy = false; el.card.classList.remove('busy'); });
}

// ---------- actions ----------
function doCheckIn() {
  return withBusy(function () {
    return call(API.checkIn, 'POST').then(function (data) {
      if (data.status === 'remote_required' && data.formUrl) {
        ZOHO.CREATOR.UTIL.navigateParentURL(data.formUrl);
        return;
      }
      return refresh();
    });
  });
}

function doResume() {
  return withBusy(function () { return call(API.resume, 'POST').then(refresh); });
}

function doGoOnBreak(breakType, note) {
  return withBusy(function () {
    return call(API.goOnBreak, 'POST', { breakType: breakType, note: note || '' }).then(function () {
      hideBreakPanel();
      return refresh();
    });
  });
}

function doCheckOut() {
  return withBusy(function () {
    return call(API.checkOut, 'POST').then(function () {
      freezeCheckedOut();   // show frozen totals + "Checked Out"; reload yields fresh idle
    });
  });
}

function freezeCheckedOut() {
  var running = (engine.state === 'working' || engine.state === 'on_break');
  var delta = running ? (Date.now() - engine.anchorClientMs) : 0;
  engine.workBaseMs = engine.workBaseMs + (running ? delta : 0);
  engine.breakBaseMs = engine.breakBaseMs + (engine.state === 'on_break' ? delta : 0);
  engine.state = 'checked_out';
  stopTick();
  clearSnapshot();
  render();
}

// ---------- break panel ----------
function showBreakPanel() { el.card.classList.add('break-open'); }
function hideBreakPanel() { el.card.classList.remove('break-open'); el.breakNote.value = ''; }

// ---------- init ----------
function cacheEls() {
  ['card', 'dateLabel', 'workBlock', 'workTime', 'breakLabel', 'breakTime', 'actions',
   'btnCheckIn', 'btnBreak', 'btnResume', 'btnCheckOut', 'checkedOutLabel',
   'breakPanel', 'breakNote', 'breakCancel', 'statusMsg'].forEach(function (id) {
    el[id] = document.getElementById(id);
  });
}

function wireEvents() {
  el.btnCheckIn.addEventListener('click', doCheckIn);
  el.btnResume.addEventListener('click', doResume);
  el.btnCheckOut.addEventListener('click', doCheckOut);
  el.btnBreak.addEventListener('click', showBreakPanel);
  el.breakCancel.addEventListener('click', hideBreakPanel);
  var typeBtns = el.breakPanel.querySelectorAll('[data-break]');
  for (var i = 0; i < typeBtns.length; i++) {
    (function (btn) {
      btn.addEventListener('click', function () { doGoOnBreak(btn.getAttribute('data-break'), el.breakNote.value); });
    })(typeBtns[i]);
  }
}

// Size/mode diagnostic overlay — OFF by default; enable by adding ?debug=1 to the widget URL.
var DEBUG_SIZE = /[?&]debug=1/.test(location.search);
function setupDebug() {
  if (!DEBUG_SIZE) { return; }
  var d = document.createElement('div');
  d.style.cssText = 'position:fixed;top:4px;right:6px;z-index:9999;font:10px/1.3 monospace;color:#0E0E0C;background:rgba(244,239,230,0.92);border:1px solid rgba(14,14,12,0.3);padding:2px 6px;border-radius:3px;pointer-events:none;';
  document.body.appendChild(d);
  function upd() {
    var w = document.documentElement.clientWidth;
    var h = document.documentElement.clientHeight;
    var mode = 'portrait';
    if (window.matchMedia('(max-height: 200px)').matches) { mode = 'strip'; }
    else if (window.matchMedia('(min-aspect-ratio: 5/4) and (min-height: 201px)').matches) { mode = 'landscape'; }
    d.textContent = w + 'x' + h + ' · ' + mode;
  }
  upd();
  window.addEventListener('resize', upd);
}

function init() {
  cacheEls();
  wireEvents();
  setupDebug();

  // instant paint from last known snapshot
  var snap = loadSnapshot();
  if (snap && snap.data) { applyState(snap.data, snap.captureClientMs); }
  else { render(); }

  // authoritative state from Creator
  Promise.resolve()
    .then(function () { if (window.ZOHO && ZOHO.CREATOR && ZOHO.CREATOR.init) { return ZOHO.CREATOR.init(); } })
    .then(refresh)
    .catch(function () { showStatus('Offline. Showing last known state.'); });
}

init();
