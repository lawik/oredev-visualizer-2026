// render.js — draws the simulator on a canvas in a hand-drawn style (rough.js). Black ink on
// white; the only colour is green, for userspace threads. Requests are balls that move between
// the places they can be: arriving, a run queue, a thread, waiting on IO, done.
'use strict';

const TAU = Math.PI * 2;
const INK = '#111';
const INK_SOFT = '#777';
const INK_FAINT = '#bbb';
const GREEN = '#1f9d55';
const TOKEN_R = 8;
const GLOW_MS = 350; // how long a thread/core keeps looking "just ran" after its last slice

class Renderer {
  constructor(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.rc = rough.canvas(canvas);
    this.gen = this.rc.generator;
    this.cache = new Map();
    this.W = 0; this.H = 0;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const r = this.cv.getBoundingClientRect();
    this.W = Math.max(300, r.width); this.H = Math.max(200, r.height);
    this.cv.width = Math.round(this.W * dpr); this.cv.height = Math.round(this.H * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // --- rough helpers: drawables are generated once at the origin, cached, then translated ------

  cached(key, make) {
    let d = this.cache.get(key);
    if (!d) {
      if (this.cache.size > 4000) this.cache.clear();
      d = make(this.gen);
      this.cache.set(key, d);
    }
    return d;
  }

  seedOf(key) { let h = 7; for (let i = 0; i < key.length; i++) h = (h * 31 + key.charCodeAt(i)) >>> 0; return h || 1; }

  at(x, y, d, alpha = 1) {
    const ctx = this.ctx;
    ctx.save(); ctx.translate(x, y); ctx.globalAlpha = alpha; this.rc.draw(d); ctx.restore();
  }

  sketchRect(x, y, w, h, o, id = '') {
    w = Math.round(w); h = Math.round(h);
    const key = `rect|${w}|${h}|${id}|${o.stroke}|${o.strokeWidth}|${o.dash || ''}|${o.fill || ''}`;
    const d = this.cached(key, g => g.rectangle(0, 0, w, h, {
      roughness: 1, bowing: 0.8, stroke: o.stroke, strokeWidth: o.strokeWidth, seed: this.seedOf(key),
      strokeLineDash: o.dash, fill: o.fill, fillStyle: 'hachure', hachureGap: 7, fillWeight: 0.6,
    }));
    this.at(x, y, d, o.alpha);
  }

  sketchRound(x, y, w, h, r, o, id = '') {
    w = Math.round(w); h = Math.round(h);
    const key = `round|${w}|${h}|${r}|${id}|${o.stroke}|${o.strokeWidth}`;
    const d = this.cached(key, g => g.path(
      `M${r} 0 H${w - r} A${r} ${r} 0 0 1 ${w} ${r} V${h - r} A${r} ${r} 0 0 1 ${w - r} ${h} H${r} A${r} ${r} 0 0 1 0 ${h - r} V${r} A${r} ${r} 0 0 1 ${r} 0 Z`,
      { roughness: 0.9, bowing: 0.6, stroke: o.stroke, strokeWidth: o.strokeWidth, seed: this.seedOf(key) }));
    this.at(x, y, d, o.alpha);
  }

  sketchBall(x, y, r, gap, alpha = 1) {
    const key = `ball|${r.toFixed(1)}|${gap}`;
    const d = this.cached(key, g => g.circle(0, 0, 2 * r, {
      roughness: 0.8, stroke: INK, strokeWidth: 1.1, seed: this.seedOf(key),
      fill: INK, fillStyle: gap === 0 ? 'solid' : 'hachure', hachureGap: gap, fillWeight: 0.8, hachureAngle: -41,
    }));
    this.at(x, y, d, alpha);
  }

  sketchArc(x, y, r, frac, o, alpha = 1) {
    const q = Math.round(frac * 36);
    if (q <= 0) return;
    const key = `arc|${r.toFixed(1)}|${q}|${o.stroke}|${o.dash || ''}`;
    const d = this.cached(key, g => g.arc(0, 0, 2 * r, 2 * r, -Math.PI / 2, -Math.PI / 2 + TAU * q / 36, false, {
      roughness: 0.5, stroke: o.stroke, strokeWidth: o.strokeWidth, seed: this.seedOf(key), strokeLineDash: o.dash,
      disableMultiStroke: true,
    }));
    this.at(x, y, d, alpha);
  }

  sketchLink(x1, y1, x2, y2, alpha) {
    const ctx = this.ctx;
    ctx.save(); ctx.globalAlpha = alpha;
    this.rc.curve([[x1, y1], [x1 + 30, y1], [x2 - 30, y2], [x2, y2]], { roughness: 0.6, stroke: INK, strokeWidth: 1.4, disableMultiStroke: true, seed: 3 });
    ctx.restore();
  }

  text(s, x, y, o = {}) {
    const ctx = this.ctx;
    ctx.fillStyle = o.color || INK;
    ctx.font = o.font || '13px system-ui, sans-serif';
    ctx.textAlign = o.align || 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(s, x, y);
  }

  clip(text, w) {
    const ctx = this.ctx;
    if (ctx.measureText(text).width <= w) return text;
    let lo = 0, hi = text.length;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(text.slice(0, mid) + '…').width <= w) lo = mid; else hi = mid - 1; }
    return text.slice(0, lo).trimEnd() + '…';
  }

  // --- layout -------------------------------------------------------------------------------

  pitch(sim) { return sim.cfg.us.on ? 34 : 26; }

  layout(sim) {
    const W = this.W, H = this.H, p = 22, hdr = 46;
    const ioH = Math.max(120, Math.min(190, H * 0.24));
    const top = p + hdr;
    const flowH = H - p - ioH - 30 - top;
    const us = sim.cfg.us.on;
    const inboxW = 134;
    const rqW = us ? Math.max(160, Math.min(280, W * 0.19)) : 0;
    const kqW = 110, coresW = 130, gap = 26;
    let x = p;
    const L = { hdr, p };
    L.inbox = { x, y: top, w: inboxW, h: flowH }; x += inboxW + gap;
    if (us) { L.rq = { x, y: top, w: rqW, h: flowH }; x += rqW + gap; }
    const threadsW = Math.max(120, W - p - x - gap - kqW - gap - coresW);
    L.threads = { x, y: top, w: threadsW, h: flowH }; x += threadsW + gap;
    L.kq = { x, y: top, w: kqW, h: flowH }; x += kqW + gap;
    L.cores = { x, y: top, w: coresW, h: flowH };
    L.io = { x: p, y: H - p - ioH + hdr - 10, w: W - 2 * p, h: ioH - hdr + 10 };

    const n = sim.threads.length;
    const pinnedRows = us && sim.cfg.us.pinned && n <= 16;
    let cols, rows;
    if (pinnedRows) { cols = 1; rows = n; }
    else {
      cols = Math.max(1, Math.round(Math.sqrt(n * L.threads.w / L.threads.h)));
      rows = Math.ceil(n / cols);
      while (cols > 1 && Math.ceil(n / (cols - 1)) === rows) cols--;
    }
    L.grid = { cols, rows, cellW: L.threads.w / cols, cellH: L.threads.h / rows, pinnedRows };
    return L;
  }

  threadBox(L, i) {
    const g = L.grid;
    const col = i % g.cols, row = Math.floor(i / g.cols);
    const maxW = g.pinnedRows ? 220 : 170, maxH = 96;
    const w = Math.min(g.cellW - 8, maxW), h = Math.min(g.cellH - 8, maxH);
    const x = L.threads.x + col * g.cellW + (g.pinnedRows ? 6 : (g.cellW - w) / 2);
    const y = L.threads.y + row * g.cellH + (g.pinnedRows ? (g.cellH - h) / 2 : 4);
    return { x, y, w, h };
  }

  coreBox(L, i, n) {
    const gap = 12;
    const h = Math.min(70, (L.cores.h - gap * (n - 1)) / n);
    return { x: L.cores.x, y: L.cores.y + i * (h + gap), w: L.cores.w, h };
  }

  gridSlot(region, i, pitch) {
    const cols = Math.max(1, Math.floor(region.w / pitch));
    const rows = Math.max(1, Math.floor(region.h / pitch));
    const cap = cols * rows;
    const k = Math.min(i, cap - 1);
    return { x: region.x + (k % cols) * pitch + pitch / 2, y: region.y + Math.floor(k / cols) * pitch + pitch / 2, over: i >= cap };
  }

  tokenRadiusFor(box) { return Math.max(2.5, Math.min(TOKEN_R, Math.min(box.w, box.h) * 0.26)); }

  assignTargets(sim, L) {
    const us = sim.cfg.us.on;
    const pitch = this.pitch(sim);
    const targets = new Map();
    const over = { inbox: 0, rq: 0, io: 0 };

    sim.inbox.forEach((r, i) => {
      const cap = Math.max(1, Math.floor(L.inbox.h / pitch));
      const k = Math.min(i, cap - 1);
      if (i >= cap) over.inbox++;
      targets.set(r, { x: L.inbox.x + L.inbox.w / 2, y: L.inbox.y + k * pitch + pitch / 2, r: TOKEN_R, snap: i >= cap });
    });

    if (us) {
      if (L.grid.pinnedRows) {
        sim.threads.forEach((th, ti) => {
          const b = this.threadBox(L, ti);
          const cols = Math.max(1, Math.floor(L.rq.w / pitch));
          th.queue.forEach((r, i) => {
            const k = Math.min(i, cols - 1);
            if (i >= cols) over.rq++;
            targets.set(r, { x: L.rq.x + L.rq.w - k * pitch - pitch / 2, y: b.y + b.h / 2, r: TOKEN_R, snap: i >= cols });
          });
        });
      } else {
        const q = sim.cfg.us.pinned ? sim.threads.flatMap(th => th.queue) : sim.rq;
        q.forEach((r, i) => {
          const s = this.gridSlot(L.rq, i, pitch);
          if (s.over) over.rq++;
          targets.set(r, { x: s.x, y: s.y, r: TOKEN_R, snap: s.over });
        });
      }
    }

    sim.threads.forEach((th, i) => {
      if (!th.req) return;
      const b = this.threadBox(L, i);
      const rad = this.tokenRadiusFor(b);
      targets.set(th.req, { x: b.x + b.w / 2, y: b.y + b.h / 2 + (b.h >= 40 ? 5 : 0), r: rad, snap: false });
    });

    sim.io.forEach((r, i) => {
      if (r.state === 'blocked') return; // it stays on its thread
      const s = this.gridSlot(L.io, i, pitch);
      if (s.over) over.io++;
      targets.set(r, { x: s.x, y: s.y, r: TOKEN_R, snap: s.over });
    });

    return { targets, over };
  }

  // --- drawing ---------------------------------------------------------------------------------

  draw(sim, realDt) {
    const ctx = this.ctx, W = this.W, H = this.H;
    const L = this.layout(sim);
    const us = sim.cfg.us.on;
    const now = performance.now();
    ctx.clearRect(0, 0, W, H);

    const { targets, over } = this.assignTargets(sim, L);
    const k = 1 - Math.exp(-realDt / 120);

    // afterglow bookkeeping: remember when a thread last held a core
    for (const th of sim.threads) if (th.state === 'running') { th.glow = now; th.glowCore = th.core; }

    // headings
    const tc = sim.threadCounts();
    this.heading(L.inbox, 'Arriving', `${sim.inbox.length} waiting for a thread`);
    if (us) this.heading(L.rq, 'Runtime run queue', `${sim.runtimeQueueLength()} waiting for an OS thread`);
    this.heading(L.threads, `OS threads · ${sim.threads.length}`, us
      ? `${tc.running} running · ${tc.runnable} waiting for a core · ${tc.parked} parked`
      : `${tc.running} running · ${tc.runnable} waiting for a core · ${tc.blocked} blocked on IO · ${tc.idle} idle`);
    this.heading(L.kq, 'Kernel run queue', `${sim.kq.length} waiting`);
    this.heading(L.cores, `Cores · ${sim.cores.length}`, `${Math.round(sim.busyFraction(200) * 100)}% busy`);
    this.heading(L.io, `Waiting on IO · ${sim.io.length}`, us
      ? 'parked userspace threads: the OS thread that carried them is free to run something else'
      : 'no userspace threads: a request waits on the OS thread it holds, shown dashed above');

    // threads, cores, kernel queue
    sim.threads.forEach((th, i) => this.drawThread(sim, L, th, i, now));
    sim.cores.forEach((core, i) => this.drawCore(sim, L, core, i, now));
    this.drawKernelQueue(sim, L);

    // balls
    for (const r of sim.live) {
      const t = targets.get(r);
      if (!t) continue;
      if (r.x == null) { r.x = L.inbox.x - 40; r.y = t.y; }
      if (t.snap) { r.x = t.x; r.y = t.y; continue; }
      r.x += (t.x - r.x) * k; r.y += (t.y - r.y) * k;
      this.drawToken(sim, r, r.x, r.y, t.r, 1);
    }
    for (let i = sim.gone.length - 1; i >= 0; i--) {
      const g = sim.gone[i];
      if (g.at == null) g.at = now;
      const age = now - g.at;
      if (age > 500 || g.r.x == null) { sim.gone.splice(i, 1); continue; }
      g.r.x += (W + 30 - g.r.x) * k * 1.4;
      this.drawToken(sim, g.r, g.r.x, g.r.y, TOKEN_R, 1 - age / 500);
    }

    // overflow labels
    if (over.inbox) this.text(`+${over.inbox} more`, L.inbox.x + L.inbox.w / 2, L.inbox.y + L.inbox.h - 8, { align: 'center', color: INK_SOFT });
    if (over.rq) this.text(`+${over.rq} more`, L.rq.x + L.rq.w / 2, L.rq.y + L.rq.h - 8, { align: 'center', color: INK_SOFT });
    if (over.io) this.text(`+${over.io} more`, L.io.x + L.io.w - 4, L.io.y + L.io.h - 8, { align: 'right', color: INK_SOFT });

    // legend
    const ly = H - 14;
    let lx = L.io.x;
    this.sketchBall(lx + 6, ly, 5, 4); this.text('request, darker = more CPU', lx + 16, ly, { color: INK_SOFT, font: '12px system-ui, sans-serif' }); lx += 190;
    if (us) { this.sketchRound(lx, ly - 7, 22, 14, 4, { stroke: GREEN, strokeWidth: 1.4 }, 'legend'); this.text('userspace thread', lx + 28, ly, { color: GREEN, font: '12px system-ui, sans-serif' }); }
  }

  heading(b, title, detail) {
    this.text(this.clip(title, b.w + 20), b.x, b.y - 30, { font: '600 14px system-ui, sans-serif' });
    this.text(this.clip(detail, b.w + 20), b.x, b.y - 13, { color: INK_SOFT, font: '12px system-ui, sans-serif' });
  }

  threadStyle(th, now) {
    const glowing = th.glow && now - th.glow < GLOW_MS;
    switch (th.state) {
      case 'running': return { stroke: INK, strokeWidth: 3 };
      case 'runnable': return { stroke: INK, strokeWidth: glowing ? 2.2 : 1.4 };
      case 'blocked': return { stroke: INK, strokeWidth: 1.4, dash: [6, 4] };
      case 'parked': return { stroke: INK_FAINT, strokeWidth: 1, dash: [3, 4] };
      default: return { stroke: INK_FAINT, strokeWidth: 1 };
    }
  }

  drawThread(sim, L, th, i, now) {
    const b = this.threadBox(L, i);
    const st = this.threadStyle(th, now);
    this.sketchRect(b.x, b.y, b.w, b.h, st, `t${th.id}|${th.state}`);
    if (b.h >= 30 && b.w >= 36) {
      this.text(`T${th.id}`, b.x + 7, b.y + 11, { color: th.state === 'idle' || th.state === 'parked' ? INK_FAINT : INK, font: '12px system-ui, sans-serif' });
      if (b.w >= 110) {
        let s = '';
        if (th.state === 'running') s = `on core ${th.core.id}`;
        else if (th.state === 'runnable') s = 'wants a core';
        else if (th.state === 'blocked') s = 'blocked on IO';
        else if (th.glow && now - th.glow < GLOW_MS * 2 && th.glowCore) s = `was on core ${th.glowCore.id}`;
        if (s) this.text(s, b.x + b.w - 7, b.y + 11, { align: 'right', color: th.state === 'running' ? INK : INK_SOFT, font: '12px system-ui, sans-serif' });
      }
    }
    const ctx = this.ctx;
    if (sim.cfg.osPreempt && th.state === 'running' && b.h >= 24) {
      const f = Math.min(1, th.slice / sim.cfg.osQuantum);
      ctx.fillStyle = INK; ctx.fillRect(b.x + 6, b.y + b.h - 7, (b.w - 12) * f, 2.5);
    }
    if (sim.cfg.us.on && sim.cfg.us.preempt && th.req && th.state === 'running' && b.h >= 30) {
      const f = Math.min(1, th.req.slice / sim.cfg.us.quantum);
      ctx.fillStyle = GREEN; ctx.fillRect(b.x + 6, b.y + b.h - 12, (b.w - 12) * f, 2.5);
    }
    if ((th.state === 'parked' || th.state === 'idle') && b.h >= 40 && b.w >= 80) {
      this.text(th.state, b.x + b.w / 2, b.y + b.h / 2 + 5, { align: 'center', color: INK_FAINT });
    }
  }

  drawCore(sim, L, core, i, now) {
    const n = sim.cores.length;
    const b = this.coreBox(L, i, n);
    const th = core.thread;
    if (th) { core.glow = now; core.glowThread = th; }
    const glowing = !th && core.glow && now - core.glow < GLOW_MS;
    const alpha = glowing ? 1 - (now - core.glow) / GLOW_MS : 1;
    this.sketchRect(b.x, b.y, b.w, b.h, th ? { stroke: INK, strokeWidth: 3 } : { stroke: INK, strokeWidth: 1.2 }, `c${core.id}|${!!th}`);
    this.text(`Core ${core.id}`, b.x + 9, b.y + 13, { font: '600 13px system-ui, sans-serif' });
    const shown = th || (glowing ? core.glowThread : null);
    if (b.h >= 30) {
      if (shown) {
        this.text(`T${shown.id}`, b.x + b.w - 9, b.y + 13, { align: 'right', color: th ? INK : INK_SOFT, font: '600 13px system-ui, sans-serif' });
      } else {
        this.text('idle', b.x + b.w - 9, b.y + 13, { align: 'right', color: INK_FAINT });
      }
    }
    if (shown) {
      const tb = this.threadBox(L, shown.id);
      this.sketchLink(tb.x + tb.w, tb.y + tb.h / 2, b.x, b.y + b.h / 2, th ? 1 : alpha);
    }
  }

  drawKernelQueue(sim, L) {
    const b = L.kq;
    const chipH = 22, pitch = 28, w = b.w - 6;
    const cap = Math.max(1, Math.floor(b.h / pitch) - 1);
    sim.kq.forEach((th, i) => {
      if (i >= cap) return;
      const y = b.y + i * pitch;
      this.sketchRect(b.x + 3, y, w, chipH, { stroke: INK, strokeWidth: 1.2 }, `kq${i}`);
      this.text(`T${th.id}`, b.x + 11, y + chipH / 2 + 1, { font: '12px system-ui, sans-serif' });
      if (th.req) this.drawMini(th.req, b.x + w - 8, y + chipH / 2 + 1);
    });
    if (sim.kq.length > cap) this.text(`+${sim.kq.length - cap} more`, b.x + b.w / 2, b.y + cap * pitch + 11, { align: 'center', color: INK_SOFT });
    if (sim.kq.length === 0) this.text('nobody waiting', b.x + b.w / 2, b.y + b.h / 2, { align: 'center', color: INK_FAINT });
  }

  drawMini(r, x, y) { this.sketchBall(x, y, 4, this.gapFor(r)); }

  // darker fill for heavier requests
  gapFor(r) { return r.cpuRatio >= 6 ? 0 : r.cpuRatio >= 2.5 ? 2 : 4; }

  drawToken(sim, r, x, y, rad, alpha) {
    const us = sim.cfg.us.on;
    const holdsUthread = us && r.state !== 'inbox';
    if (holdsUthread && rad >= 4) {
      const w = 2 * rad + 18, h = 2 * rad + 14;
      this.sketchRound(x - w / 2, y - h / 2, w, h, 6, { stroke: GREEN, strokeWidth: r.state === 'running' ? 2.2 : 1.5, alpha }, r.state === 'running' ? 'run' : '');
    }
    this.sketchBall(x, y, rad, this.gapFor(r), alpha);
    if (rad >= 4) {
      const frac = Math.min(1, r.progress / r.total);
      if (r.state === 'io' || r.state === 'blocked') {
        const ph = r.phases[r.pi];
        this.sketchArc(x, y, rad + 3.5, 1 - ph.left / ph.ms, { stroke: INK, strokeWidth: 1.2, dash: [2, 3] }, alpha);
      } else {
        this.sketchArc(x, y, rad + 3.5, frac, { stroke: INK, strokeWidth: 1.4 }, alpha);
      }
    }
  }

  // --- small charts in the stats drawer --------------------------------------------------------

  // request latency over the last few seconds of machine time: p50, p90 and p99 on one chart
  static latencyChart(canvas, samples, max) {
    const ctx = canvas.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.strokeStyle = INK_FAINT; ctx.lineWidth = 1; ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(0, h - 0.5); ctx.lineTo(w, h - 0.5); ctx.stroke();
    const N = 500;
    const s = samples.slice(-N);
    if (s.length < 2) return;
    const series = [
      { key: 'p50', stroke: INK, width: 1.2, dash: [3, 3] },
      { key: 'p90', stroke: INK_SOFT, width: 1.5, dash: [] },
      { key: 'p99', stroke: INK, width: 2, dash: [] },
    ];
    for (const ser of series) {
      ctx.beginPath();
      let pen = false;
      s.forEach((x, i) => {
        const v = x[ser.key];
        if (v == null) { pen = false; return; }
        const px = (i + (N - s.length)) / (N - 1) * w, py = h - 2 - (v / max) * (h - 6);
        pen ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
        pen = true;
      });
      ctx.strokeStyle = ser.stroke; ctx.lineWidth = ser.width; ctx.setLineDash(ser.dash); ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}
