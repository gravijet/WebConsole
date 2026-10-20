#!/usr/bin/node
'use strict';
// Runs as root (systemd timer). Reads container facts via the docker CLI and writes a small,
// whitelisted JSON file that the unprivileged dashboard can read. No env vars, no labels,
// no command lines, no mounts: only names, states and resource numbers.

const { execFile } = require('child_process');
const fs = require('fs');

const OUT = process.argv[2] || '/var/lib/server-dash/docker.json';

const run = (args) => new Promise((resolve) => {
  execFile('docker', args, { timeout: 20000, maxBuffer: 8 << 20 }, (err, stdout) => resolve(err ? '' : String(stdout)));
});

const UNIT = { b: 1, kb: 1e3, mb: 1e6, gb: 1e9, tb: 1e12, kib: 1024, mib: 1024 ** 2, gib: 1024 ** 3, tib: 1024 ** 4 };
function bytes(s) {
  const m = /^([\d.]+)\s*([a-zA-Z]*)/.exec(String(s || '').trim());
  if (!m) return 0;
  return Math.round(parseFloat(m[1]) * (UNIT[(m[2] || 'b').toLowerCase()] || 1));
}
const pair = (s) => String(s || '').split('/').map((x) => bytes(x));

(async () => {
  const [ps, stats, inspect] = await Promise.all([
    run(['ps', '-a', '--no-trunc', '--format', '{{.ID}}\t{{.Names}}\t{{.Image}}\t{{.State}}\t{{.Status}}\t{{.CreatedAt}}\t{{.Ports}}']),
    run(['stats', '--no-stream', '--no-trunc', '--format', '{{json .}}']),
    run(['ps', '-aq', '--no-trunc']).then((ids) => {
      const list = ids.split('\n').filter(Boolean);
      return list.length ? run(['inspect', '--format', '{{.Id}}\t{{.State.StartedAt}}\t{{.RestartCount}}\t{{if .State.Health}}{{.State.Health.Status}}{{end}}\t{{.HostConfig.RestartPolicy.Name}}', ...list]) : '';
    }),
  ]);

  const st = new Map();
  for (const l of stats.split('\n').filter(Boolean)) {
    try {
      const j = JSON.parse(l);
      const [memUsage, memLimit] = pair(j.MemUsage);
      const [netRx, netTx] = pair(j.NetIO);
      const [blkR, blkW] = pair(j.BlockIO);
      st.set(String(j.ID || j.Container).slice(0, 12), {
        cpu: parseFloat(j.CPUPerc) || 0, memUsage, memLimit, memPct: parseFloat(j.MemPerc) || 0, netRx, netTx, blkR, blkW, pids: parseInt(j.PIDs, 10) || 0,
      });
    } catch {}
  }
  const ins = new Map();
  for (const l of inspect.split('\n').filter(Boolean)) {
    const p = l.split('\t');
    ins.set(p[0].slice(0, 12), { startedAt: p[1] || null, restarts: parseInt(p[2], 10) || 0, health: p[3] || null, restartPolicy: p[4] || null });
  }

  const containers = ps.split('\n').filter(Boolean).map((l) => {
    const p = l.split('\t');
    const id = p[0].slice(0, 12);
    return {
      id, name: p[1], image: p[2], state: p[3], status: p[4], created: p[5], ports: (p[6] || '').split(', ').filter(Boolean).slice(0, 10),
      ...(st.get(id) || { cpu: 0, memUsage: 0, memLimit: 0, memPct: 0, netRx: 0, netTx: 0, blkR: 0, blkW: 0, pids: 0 }),
      ...(ins.get(id) || {}),
    };
  });

  const tmp = `${OUT}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ t: Date.now(), containers }), { mode: 0o644 });
  fs.renameSync(tmp, OUT);
})();
