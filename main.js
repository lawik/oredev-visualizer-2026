// main.js — controls, presets, the real-time loop and the metrics bar.
'use strict';

const $ = id => document.getElementById(id);

const MODEL_PRESETS = {
  bare:      { label: '1 core, 1 OS thread', cores: 1, threads: 1, osPreempt: false, osQuantum: 5, us: { on: false, preempt: false, quantum: 1, limit: '', pinned: false } },
  coopos:    { label: 'Cooperative OS, 8 threads', cores: 1, threads: 8, osPreempt: false, osQuantum: 5, us: { on: false, preempt: false, quantum: 1, limit: '', pinned: false } },
  preemptos: { label: 'Preemptive OS, 8 threads', cores: 4, threads: 8, osPreempt: true, osQuantum: 5, us: { on: false, preempt: false, quantum: 1, limit: '', pinned: false } },
  pool:      { label: 'Thread pool of 200 (Tomcat default)', cores: 4, threads: 200, osPreempt: true, osQuantum: 5, us: { on: false, preempt: false, quantum: 1, limit: '', pinned: false } },
  node:      { label: 'One event loop (Node)', cores: 4, threads: 1, osPreempt: true, osQuantum: 5, us: { on: true, preempt: false, quantum: 1, limit: '', pinned: false } },
  workers:   { label: 'Event loop per core (Node workers)', cores: 4, threads: 4, osPreempt: true, osQuantum: 5, us: { on: true, preempt: false, quantum: 1, limit: '', pinned: true } },
  vthreads:  { label: 'Virtual threads / async tasks (JVM, .NET)', cores: 4, threads: 4, osPreempt: true, osQuantum: 5, us: { on: true, preempt: false, quantum: 1, limit: '', pinned: false } },
  go:        { label: 'Goroutines (Go, 10 ms budget)', cores: 4, threads: 4, osPreempt: true, osQuantum: 5, us: { on: true, preempt: true, quantum: 10, limit: '', pinned: false } },
  beam:      { label: 'Processes (BEAM, ~1 ms budget)', cores: 4, threads: 4, osPreempt: true, osQuantum: 5, us: { on: true, preempt: true, quantum: 1, limit: '', pinned: false } },
};

const WORKLOAD_PRESETS = {
  io:    { label: 'IO-bound',  rate: 300, cpuMs: 0.2, cpuVar: 0,   ioMs: 20, ioVar: 0.5, spikiness: 0 },
  cpu:   { label: 'CPU-bound', rate: 150, cpuMs: 10,  cpuVar: 1,   ioMs: 0,  ioVar: 0,   spikiness: 0 },
  mixed: { label: 'Mixed',     rate: 400, cpuMs: 0.5, cpuVar: 6,   ioMs: 20, ioVar: 1,   spikiness: 0.6 },
  spiky: { label: 'Spiky',     rate: 200, cpuMs: 0.3, cpuVar: 150, ioMs: 20, ioVar: 0.5, spikiness: 1 },
  quiet: { label: 'Quiet', rate: 0, cpuMs: 0.2, cpuVar: 0, ioMs: 20, ioVar: 0, spikiness: 0 },
};

// --- read and write the controls ------------------------------------------------

function readCfg() {
  const limitRaw = $('usLimit').value.trim();
  const limit = limitRaw === '' || Number(limitRaw) <= 0 ? Infinity : Math.floor(Number(limitRaw));
  return {
    cores: clampInt($('cores'), 1, 32),
    threads: clampInt($('threads'), 1, 5000),
    osPreempt: $('osPreempt').checked,
    osQuantum: clampNum($('osQuantum'), 0.1, 1000),
    us: {
      on: $('usOn').checked,
      preempt: $('usPreempt').checked,
      quantum: clampNum($('usQuantum'), 0.1, 1000),
      limit,
      pinned: $('usPinned').checked,
    },
  };
}

function readWorkload() {
  return {
    rate: clampNum($('rate'), 0, 20000),
    cpuMs: clampNum($('cpuMs'), 0.1, 10000),
    cpuVar: clampNum($('cpuVar'), 0, 100000),
    ioMs: clampNum($('ioMs'), 0, 100000),
    ioVar: clampNum($('ioVar'), 0, 100000),
    spikiness: clampNum($('spikiness'), 0, 1),
  };
}

function clampNum(el, lo, hi) {
  let v = Number(el.value);
  if (!Number.isFinite(v)) v = lo;
  v = Math.min(hi, Math.max(lo, v));
  return v;
}
function clampInt(el, lo, hi) { return Math.round(clampNum(el, lo, hi)); }

function writeCfg(p) {
  $('cores').value = p.cores; $('threads').value = p.threads;
  $('osPreempt').checked = p.osPreempt; $('osCoop').checked = !p.osPreempt;
  $('osQuantum').value = p.osQuantum;
  $('usOn').checked = p.us.on;
  $('usPreempt').checked = p.us.preempt; $('usCoop').checked = !p.us.preempt;
  $('usQuantum').value = p.us.quantum;
  $('usLimit').value = p.us.limit;
  $('usPinned').checked = p.us.pinned;
}

function writeWorkload(p) {
  $('rate').value = p.rate; $('cpuMs').value = p.cpuMs; $('cpuVar').value = p.cpuVar;
  $('ioMs').value = p.ioMs; $('ioVar').value = p.ioVar; $('spikiness').value = p.spikiness;
  updateSpikinessLabel();
}

function updateSpikinessLabel() {
  const v = Number($('spikiness').value);
  $('spikinessLabel').textContent = v < 0.15 ? 'even' : v < 0.5 ? 'mostly even, some tail' : v < 0.85 ? 'skewed, rare big ones' : 'spiky: a few very big ones';
}

// --- explanation line -----------------------------------------------------------

function explain(cfg) {
  const s = n => n === 1 ? '' : 's';
  const out = [];
  if (!cfg.us.on) {
    out.push(`Each request takes one of ${cfg.threads} OS thread${s(cfg.threads)} and keeps it until it is done, IO waits included. A thread waiting on IO is blocked: it holds the slot and does nothing. When every thread is taken, new work queues at the door.`);
  } else {
    const lim = cfg.us.limit === Infinity ? 'a userspace thread, as many as there are requests' : `one of at most ${cfg.us.limit} userspace threads`;
    out.push(`Each request becomes ${lim}. ${cfg.threads} OS thread${s(cfg.threads)} carr${cfg.threads === 1 ? 'ies' : 'y'} them. When a userspace thread waits on IO it parks, and its OS thread picks up the next one.`);
    out.push(cfg.us.preempt
      ? `The runtime is preemptive: after ${cfg.us.quantum} ms of CPU a userspace thread is swapped out and goes to the back of the runtime run queue, whatever it was doing.`
      : `The runtime is cooperative: a userspace thread keeps its OS thread until it waits on IO or finishes. A long computation stalls everything queued behind it.`);
    if (cfg.us.pinned) out.push(`Each userspace thread is pinned to one OS thread for life. Nobody steals work, so one busy thread cannot be helped by idle ones.`);
  }
  out.push(cfg.osPreempt
    ? `The kernel is preemptive: ${cfg.cores} core${s(cfg.cores)} are shared between runnable OS threads, and a thread is moved to the back of the kernel run queue after ${cfg.osQuantum} ms if anyone is waiting.`
    : `The kernel is cooperative: an OS thread keeps its core until it blocks on IO or finishes. Nothing can interrupt it.`);
  return out.join(' ');
}

// --- app state -----------------------------------------------------------------

let cfg = readCfgSafe();
let wl;
let sim;
let paused = false;
let slowdown = 10;
let acc = 0;
let lastFrame = performance.now();
let lastMetrics = 0;
const renderer = new Renderer($('stage'));

function readCfgSafe() { try { return readCfg(); } catch (e) { return null; } }

function resetSim() {
  cfg = readCfg();
  wl = readWorkload();
  sim = new Sim(cfg, wl);
  acc = 0;
  $('explain').textContent = explain(cfg);
  syncDisabled();
}

function applyLive() {
  cfg = readCfg();
  wl = readWorkload();
  sim.setConfig(cfg);
  sim.setWorkload(wl);
  $('explain').textContent = explain(cfg);
  syncDisabled();
}

function syncDisabled() {
  const us = $('usOn').checked;
  $('usBox').classList.toggle('off', !us);
  $('osQuantum').disabled = !$('osPreempt').checked;
  $('usQuantum').disabled = !us || !$('usPreempt').checked;
  $('modelPreset').value = currentModelPreset() || 'custom';
  $('workloadPreset').value = currentWorkloadPreset() || 'custom';
}

function currentModelPreset() {
  const c = readCfg();
  for (const [k, p] of Object.entries(MODEL_PRESETS)) {
    const lim = p.us.limit === '' ? Infinity : p.us.limit;
    if (p.cores === c.cores && p.threads === c.threads && p.osPreempt === c.osPreempt && p.osQuantum === c.osQuantum &&
        p.us.on === c.us.on && (!c.us.on || (p.us.preempt === c.us.preempt && (!c.us.preempt || p.us.quantum === c.us.quantum) && lim === c.us.limit && p.us.pinned === c.us.pinned))) return k;
  }
  return null;
}

function currentWorkloadPreset() {
  const w = readWorkload();
  for (const [k, p] of Object.entries(WORKLOAD_PRESETS)) {
    if (p.rate === w.rate && p.cpuMs === w.cpuMs && p.cpuVar === w.cpuVar && p.ioMs === w.ioMs && p.ioVar === w.ioVar &&
        p.spikiness === w.spikiness) return k;
  }
  return null;
}

// --- wiring ----------------------------------------------------------------------

function fillSelect(sel, presets) {
  for (const [k, p] of Object.entries(presets)) {
    const o = document.createElement('option'); o.value = k; o.textContent = p.label; sel.appendChild(o);
  }
  const o = document.createElement('option'); o.value = 'custom'; o.textContent = 'Custom'; sel.appendChild(o);
}

fillSelect($('modelPreset'), MODEL_PRESETS);
fillSelect($('workloadPreset'), WORKLOAD_PRESETS);

$('modelPreset').addEventListener('change', e => {
  const p = MODEL_PRESETS[e.target.value];
  if (!p) return;
  writeCfg(p);
  resetSim();
});
$('workloadPreset').addEventListener('change', e => {
  const p = WORKLOAD_PRESETS[e.target.value];
  if (!p) return;
  writeWorkload(p);
  applyLive();
});

// structural changes restart the simulation, everything else applies live
for (const id of ['cores', 'threads', 'usOn', 'usPinned', 'usLimit']) $(id).addEventListener('change', resetSim);
for (const id of ['osPreempt', 'osCoop', 'osQuantum', 'usPreempt', 'usCoop', 'usQuantum',
  'rate', 'cpuMs', 'cpuVar', 'ioMs', 'ioVar', 'spikiness']) {
  $(id).addEventListener('change', applyLive);
  $(id).addEventListener('input', () => { if ($(id).type === 'number' || $(id).type === 'range') applyLive(); });
}
$('spikiness').addEventListener('input', updateSpikinessLabel);

const speed = $('speed');
function updateSpeed() {
  slowdown = Math.round(Math.pow(10, 1 + speed.value / 100 * 2)); // 10x .. 1000x
  $('speedLabel').textContent = `${slowdown}× slower  (10 ms of machine time takes ${(slowdown / 100).toFixed(slowdown < 100 ? 1 : 0)} s on screen)`;
}
speed.addEventListener('input', updateSpeed);
updateSpeed();

$('pause').addEventListener('click', togglePause);
$('stepBtn').addEventListener('click', () => { if (!paused) togglePause(); for (let i = 0; i < 10; i++) sim.step(); });
$('reset').addEventListener('click', resetSim);
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
  if (e.code === 'Space') { e.preventDefault(); togglePause(); }
  if (e.key === 'r') resetSim();
  if (e.key === '.') { if (!paused) togglePause(); for (let i = 0; i < 10; i++) sim.step(); }
});
function togglePause() { paused = !paused; document.body.classList.toggle('paused', paused); }

window.addEventListener('resize', () => renderer.resize());

// --- metrics bar -----------------------------------------------------------------

function fmtMs(v) { if (v == null) return '–'; return v < 1000 ? `${v.toFixed(v < 10 ? 1 : 0)} ms` : `${(v / 1000).toFixed(2)} s`; }

function updateMetrics() {
  const samples = sim.stats.samples.slice(-500);
  let max = 1;
  for (const x of samples) if (x.p99 != null && x.p99 > max) max = x.p99;
  max *= 1.1;
  const last = samples[samples.length - 1] || {};
  Renderer.latencyChart($('chart'), samples, max);
  for (const key of ['p50', 'p90', 'p99']) $('val_' + key).textContent = last[key] == null ? '–' : fmtMs(last[key]);
  $('scale').textContent = `0 – ${fmtMs(max)} · last 5 s of machine time · request latency over a 1 s window`;
}

// --- loop ------------------------------------------------------------------------

function frame(now) {
  const realDt = Math.min(50, now - lastFrame);
  lastFrame = now;
  if (!paused) {
    acc += realDt / slowdown;
    let ticks = Math.floor(acc / DT);
    acc -= ticks * DT;
    if (ticks > 400) ticks = 400;
    for (let i = 0; i < ticks; i++) sim.step();
  }
  renderer.draw(sim, realDt);
  if (now - lastMetrics > 100) { updateMetrics(); lastMetrics = now; }
  requestAnimationFrame(frame);
}

// deep links: ?model=beam&workload=spiky&t=800&speed=50&paused=1
const params = new URLSearchParams(location.search);
const model = MODEL_PRESETS[params.get('model')] || MODEL_PRESETS.bare;
const workload = WORKLOAD_PRESETS[params.get('workload')] || WORKLOAD_PRESETS.io;
writeCfg(model);
writeWorkload(workload);
resetSim();
if (params.has('speed')) { speed.value = Math.min(100, Math.max(0, Number(params.get('speed')) || 0)); updateSpeed(); }
const pre = Math.min(60000, Math.max(0, Number(params.get('t')) || 0));
for (let i = 0; i < pre / DT; i++) sim.step();
if (params.get('paused') === '1') togglePause();
renderer.resize();
requestAnimationFrame(frame);
