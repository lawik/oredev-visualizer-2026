# Threads & schedulers

A standalone, simulated visualisation of how work moves through a machine under different
threading models, drawn in a hand-sketched style. Open `index.html` in a browser; there is no build
step. The only dependency is rough.js, vendored in `vendor/rough.js` (v4.6.6 from unpkg).

The machine has cores, OS threads scheduled by the kernel (cooperative or preemptive, with a
time slice in ms), and optionally userspace threads on top scheduled by a runtime (cooperative or
preemptive, with its own time slice in ms, bounded or unlimited, shared run queue or pinned to one
OS thread). Work arrives as requests: CPU time, half before and half after one IO call. CPU and IO
each have a variance (0 is none; v means up to v× more) and a spikiness slider shapes that
randomness from even to a rare long tail. Presets: IO-bound, CPU-bound, mixed, spiky, quiet. Balls with a green round-rect hold a userspace thread; darker balls carry
more CPU. Stats live in a collapsed drawer under the canvas.

Time runs at least 10x slower than the machine it pretends to be, and can be slowed to 1000x.

Deep links for a talk: `index.html?model=beam&workload=spiky&t=800&speed=30&paused=1`
(`model`: bare, coopos, preemptos, pool, node, workers, vthreads, go, beam;
`workload`: io, cpu, mixed, spiky, quiet; `t`: ms to pre-run; `speed`: 0–100 slider position).

Keys: space pauses, `.` steps 1 ms, `r` restarts.
