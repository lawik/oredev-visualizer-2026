// sim.js — a small discrete-time scheduling simulator.
// Everything here is simulated milliseconds. No DOM, so it can be run under node for checks.
'use strict';

const DT = 0.1; // simulated ms per tick

// cfg = { cores, threads, osPreempt, osQuantum, us: { on, preempt, quantum, limit, pinned } }
// wl  = { rate, cpuMs, cpuVar, ioMs, ioVar, spikiness }
//   a request does cpuMs of CPU (half before, half after) around one IO call of ioMs.
//   variance v >= 0: the time is multiplied by 1 + v * x, with x drawn in [0, 1].
//   spikiness in [0, 1] shapes x: 0 is even (uniform), 1 is spiky (almost always ~0, rarely near 1).
class Sim {
  constructor(cfg, wl) { this.reset(cfg, wl); }

  reset(cfg, wl) {
    this.cfg = cfg;
    this.wl = wl;
    this.t = 0;
    this.nextId = 1;
    this.seed = 20261103;
    this.cores = Array.from({ length: cfg.cores }, (_, i) => ({ id: i, thread: null }));
    this.threads = Array.from({ length: cfg.threads }, (_, i) => ({
      id: i, state: cfg.us.on ? 'parked' : 'idle', req: null, core: null, slice: 0, queue: [],
    }));
    this.kq = [];     // kernel run queue: threads that want a core
    this.rq = [];     // runtime run queue (shared): requests that want a carrier
    this.inbox = [];  // arrived, no thread yet
    this.io = [];     // requests in an IO phase (parked, or blocking their thread)
    this.live = [];   // every request not yet finished
    this.gone = [];   // recently finished, for the renderer to fade out
    this.uInUse = 0;
    this.rr = 0;
    this.arrAcc = 0;
    this.stats = {
      busy: 0, busyAcc: 0, osPreempts: 0, usPreempts: 0, done: 0,
      lat: { plain: [] },
      completions: [], samples: [], sampleAt: 0,
    };
  }

  setWorkload(wl) { this.wl = wl; }
  setConfig(cfg) { this.cfg = cfg; }

  rand() { this.seed = (Math.imul(this.seed, 1103515245) + 12345) >>> 0; return this.seed / 4294967296; }

  // --- arrivals ------------------------------------------------------------

  // x in [0, 1]: uniform at spikiness 0, pushed towards 0 with a rare long tail at spikiness 1
  skew() {
    const k = Math.pow(16, Math.min(1, Math.max(0, this.wl.spikiness)));
    return Math.pow(this.rand(), k);
  }

  spawn() {
    const wl = this.wl;
    const cpu = Math.max(DT, wl.cpuMs * (1 + Math.max(0, wl.cpuVar) * this.skew()));
    const io = wl.ioMs > 0 ? Math.max(DT, wl.ioMs * (1 + Math.max(0, wl.ioVar) * this.skew())) : 0;
    const cpuRatio = cpu / Math.max(DT, wl.cpuMs);
    const phases = io > 0
      ? [{ type: 'cpu', ms: Math.max(DT, cpu / 2) }, { type: 'io', ms: io }, { type: 'cpu', ms: Math.max(DT, cpu / 2) }]
      : [{ type: 'cpu', ms: cpu }];
    for (const p of phases) p.left = p.ms;
    const total = phases.reduce((a, p) => a + p.ms, 0);
    const r = {
      id: this.nextId++, phases, pi: 0, total, progress: 0, cpuRatio,
      arrived: this.t, done: null, state: 'inbox', slice: 0,
      thread: null, carrier: null, home: null, x: null, y: null,
    };
    this.inbox.push(r);
    this.live.push(r);
    return r;
  }

  arrive() {
    const wl = this.wl;
    this.arrAcc += wl.rate * DT / 1000;
    while (this.arrAcc >= 1) {
      this.arrAcc -= 1;
      this.spawn();
    }
  }

  // --- runtime (userspace) helpers ----------------------------------------

  queueFor(th) { return this.cfg.us.pinned ? th.queue : this.rq; }

  enqueueRuntime(r) {
    r.state = 'runq';
    r.slice = 0;
    r.carrier = null;
    if (this.cfg.us.pinned) {
      if (!r.home) r.home = this.threads[this.rr++ % this.threads.length];
      r.home.queue.push(r);
    } else {
      this.rq.push(r);
    }
  }

  wakeCarriers() {
    if (this.cfg.us.pinned) {
      for (const th of this.threads) {
        if (th.state === 'parked' && th.queue.length) { th.state = 'runnable'; th.slice = 0; this.kq.push(th); }
      }
    } else {
      let awakeIdle = 0;
      for (const th of this.threads) if (th.state !== 'parked' && !th.req) awakeIdle++;
      let avail = this.rq.length - awakeIdle;
      for (const th of this.threads) {
        if (avail <= 0) break;
        if (th.state === 'parked') { th.state = 'runnable'; th.slice = 0; this.kq.push(th); avail--; }
      }
    }
  }

  // --- one tick -----------------------------------------------------------

  step() {
    const c = this.cfg;
    this.t += DT;

    // 1. work arrives
    this.arrive();

    // 2. admission: work gets a thread
    if (!c.us.on) {
      for (const th of this.threads) {
        if (!this.inbox.length) break;
        if (th.state === 'idle') {
          const r = this.inbox.shift();
          th.req = r; r.thread = th; r.state = 'runq';
          th.state = 'runnable'; th.slice = 0;
          this.kq.push(th);
        }
      }
    } else {
      while (this.inbox.length && this.uInUse < c.us.limit) {
        const r = this.inbox.shift();
        this.uInUse++;
        this.enqueueRuntime(r);
      }
      this.wakeCarriers();
    }

    // 3. the kernel hands cores to threads
    for (const core of this.cores) {
      let th = core.thread;
      if (th) {
        if (th.state !== 'running') { core.thread = null; th.core = null; th = null; }
        else if (c.osPreempt && th.slice >= c.osQuantum - 1e-9 && this.kq.length) {
          th.slice = 0; th.state = 'runnable'; th.core = null;
          this.kq.push(th); core.thread = null; th = null;
          this.stats.osPreempts++;
        }
      }
      if (!th && this.kq.length) {
        th = this.kq.shift();
        th.state = 'running'; th.core = core; th.slice = 0; core.thread = th;
      }
    }

    // 4. the runtime hands carriers to userspace threads
    if (c.us.on) {
      for (const core of this.cores) {
        const th = core.thread;
        if (!th) continue;
        let r = th.req;
        const q = this.queueFor(th);
        if (r && c.us.preempt && r.slice >= c.us.quantum - 1e-9 && q.length) {
          th.req = null;
          this.enqueueRuntime(r);
          r = null;
          this.stats.usPreempts++;
        }
        if (!r) {
          if (q.length) {
            r = q.shift();
            r.state = 'running'; r.carrier = th; r.slice = 0; th.req = r;
          } else {
            th.state = 'parked'; th.core = null; core.thread = null;
          }
        }
      }
    }

    // 5. time passes: CPU on cores, IO in parallel
    for (const core of this.cores) {
      const th = core.thread;
      if (!th || !th.req) continue;
      const r = th.req;
      const ph = r.phases[r.pi];
      ph.left -= DT; r.slice += DT; th.slice += DT; r.progress += DT;
      this.stats.busyAcc += DT;
      if (ph.left <= 1e-9) this.phaseDone(r, th);
    }
    for (let i = this.io.length - 1; i >= 0; i--) {
      const r = this.io[i];
      const ph = r.phases[r.pi];
      ph.left -= DT; r.progress += DT;
      if (ph.left <= 1e-9) { this.io.splice(i, 1); this.phaseDone(r, r.thread); }
    }

    // 6. bookkeeping
    if (this.t >= this.stats.sampleAt) {
      const s = this.stats;
      const lat = s.completions.map(x => x.lat).sort((a, b) => a - b);
      const pct = p => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p / 100))] : null;
      s.samples.push({ t: this.t, inflight: this.live.length, busy: s.busyAcc / (10 * c.cores), inbox: this.inbox.length,
        p50: pct(50), p90: pct(90), p99: pct(99) });
      if (s.samples.length > 600) s.samples.shift();
      s.busyAcc = 0;
      s.sampleAt += 10;
    }
  }

  phaseDone(r, th) {
    const c = this.cfg;
    r.pi++;
    if (r.pi >= r.phases.length) {
      r.state = 'done'; r.done = this.t;
      this.finish(r);
      if (!c.us.on) {
        th.req = null; th.state = 'idle';
        if (th.core) { th.core.thread = null; th.core = null; }
      } else {
        this.uInUse--;
        if (th) th.req = null;
        r.carrier = null;
      }
      return;
    }
    const ph = r.phases[r.pi];
    if (ph.type === 'io') {
      if (!c.us.on) {
        r.state = 'blocked'; th.state = 'blocked';
        if (th.core) { th.core.thread = null; th.core = null; }
      } else {
        r.state = 'io'; r.carrier = null;
        if (th) th.req = null;
      }
      this.io.push(r);
    } else {
      if (!c.us.on) {
        r.state = 'runq'; r.slice = 0; th.state = 'runnable'; th.slice = 0;
        this.kq.push(th);
      } else {
        this.enqueueRuntime(r);
      }
    }
  }

  finish(r) {
    const s = this.stats;
    s.done++;
    const i = this.live.indexOf(r);
    if (i >= 0) this.live.splice(i, 1);
    this.gone.push({ r, at: null });
    if (this.gone.length > 150) this.gone.shift();
    const lat = r.done - r.arrived;
    const arr = s.lat.plain;
    arr.push(lat);
    if (arr.length > 300) arr.shift();
    s.completions.push({ t: this.t, lat });
    while (s.completions.length && s.completions[0].t < this.t - 1000) s.completions.shift();
  }

  // --- derived numbers ------------------------------------------------------

  percentile(kind, p) {
    const a = this.stats.lat[kind];
    if (!a.length) return null;
    const sorted = a.slice().sort((x, y) => x - y);
    return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p / 100))];
  }

  throughput() {
    const s = this.stats;
    const span = Math.min(1000, Math.max(100, this.t));
    return s.completions.length * 1000 / span;
  }

  busyFraction(windowMs = 200) {
    const s = this.stats.samples;
    if (!s.length) return 0;
    const n = Math.max(1, Math.min(s.length, Math.round(windowMs / 10)));
    let sum = 0;
    for (let i = s.length - n; i < s.length; i++) sum += s[i].busy;
    return sum / n;
  }

  threadCounts() {
    const n = { idle: 0, runnable: 0, running: 0, blocked: 0, parked: 0 };
    for (const th of this.threads) n[th.state]++;
    return n;
  }

  runtimeQueueLength() {
    if (!this.cfg.us.on) return 0;
    if (this.cfg.us.pinned) return this.threads.reduce((a, th) => a + th.queue.length, 0);
    return this.rq.length;
  }
}

if (typeof module !== 'undefined') module.exports = { Sim, DT };
