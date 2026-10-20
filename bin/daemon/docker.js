'use strict';
// Docker: inventory (containers, images, volumes, networks, compose projects) and management.

const fs = require('fs');
const { run, clip, fail, NAME_RE } = require('./core');
const jobs = require('./jobs');

const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,250}$/;
const IMG_ID_RE = /^(sha256:)?[0-9a-f]{12,64}$/;
const ENV = { DOCKER_CONFIG: '/tmp' };
const dk = (args, o = {}) => run('docker', args, { env: ENV, ...o });
const lines = (s) => s.split('\n').map((l) => l.trim()).filter(Boolean);
const jsonLines = (s) => lines(s).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

const UNIT_MULT = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, KIB: 1024, MIB: 1024 ** 2, GIB: 1024 ** 3, TIB: 1024 ** 4 };
function parseSize(s) {
  const m = /^([\d.]+)\s*([A-Za-z]+)$/.exec(String(s || '').trim());
  return m ? Math.round(parseFloat(m[1]) * (UNIT_MULT[m[2].toUpperCase()] || 1)) : null;
}

async function names() { return lines((await dk(['ps', '-a', '--format', '{{.Names}}'], { timeout: 15_000 })).out); }
async function mustExist(name) {
  if (typeof name !== 'string' || !NAME_RE.test(name)) throw fail('Ungültiger Containername.');
  if (!(await names()).includes(name)) throw fail('Dieser Container existiert nicht.');
}

async function inspectAll() {
  const ids = lines((await dk(['ps', '-aq', '--no-trunc'], { timeout: 15_000 })).out);
  if (!ids.length) return [];
  const r = await dk(['inspect', ...ids], { timeout: 30_000, max: 64 << 20 });
  try { return JSON.parse(r.out); } catch { return []; }
}

function composeOf(c) {
  const l = (c.Config && c.Config.Labels) || {};
  return l['com.docker.compose.project'] ? { project: l['com.docker.compose.project'], dir: l['com.docker.compose.project.working_dir'] || '', files: (l['com.docker.compose.project.config_files'] || '').split(',').filter(Boolean), service: l['com.docker.compose.service'] || '' } : null;
}

const ops = {
  async 'docker.inventory'() {
    const [insp, imgIds, vols, nets, df, info, dfv] = await Promise.all([
      inspectAll(),
      dk(['images', '-aq', '--no-trunc'], { timeout: 20_000 }),
      dk(['volume', 'ls', '--format', '{{json .}}'], { timeout: 20_000 }),
      dk(['network', 'ls', '--no-trunc', '--format', '{{.ID}}'], { timeout: 20_000 }),
      dk(['system', 'df', '--format', '{{json .}}'], { timeout: 40_000 }),
      dk(['info', '--format', '{{json .}}'], { timeout: 20_000 }),
      dk(['system', 'df', '-v', '--format', '{{json .}}'], { timeout: 60_000, max: 32 << 20 }),
    ]);
    const usedImage = new Map(); const usedVol = new Map(); const usedNet = new Map();
    const containers = insp.map((c) => {
      const name = c.Name.replace(/^\//, '');
      usedImage.set(c.Image, [...(usedImage.get(c.Image) || []), name]);
      for (const m of c.Mounts || []) if (m.Type === 'volume') usedVol.set(m.Name, [...(usedVol.get(m.Name) || []), name]);
      for (const n of Object.keys((c.NetworkSettings && c.NetworkSettings.Networks) || {})) usedNet.set(n, [...(usedNet.get(n) || []), name]);
      const ports = [];
      for (const [k, v] of Object.entries((c.NetworkSettings && c.NetworkSettings.Ports) || {})) { if (v) for (const b of v) ports.push(`${b.HostIp === '0.0.0.0' || b.HostIp === '::' ? '' : `${b.HostIp}:`}${b.HostPort}→${k}`); else ports.push(k); }
      return {
        id: c.Id.slice(0, 12), name, image: c.Config.Image, imageId: c.Image.replace('sha256:', '').slice(0, 12), state: c.State.Status, status: c.State.Health ? `${c.State.Status} (${c.State.Health.Status})` : c.State.Status,
        health: c.State.Health ? c.State.Health.Status : null, created: Date.parse(c.Created), started: Date.parse(c.State.StartedAt) || null, exitCode: c.State.ExitCode, restarts: c.RestartCount,
        restartPolicy: c.HostConfig.RestartPolicy.Name || 'no', networks: Object.keys((c.NetworkSettings && c.NetworkSettings.Networks) || {}), ports: [...new Set(ports)], compose: composeOf(c), paused: !!c.State.Paused,
      };
    });
    const dfvO = (jsonLines(dfv.out)[0]) || {};
    const volSize = new Map((dfvO.Volumes || []).map((v) => [v.Name, parseSize(v.Size)]));
    const dfImg = new Map((dfvO.Images || []).map((i) => [`${i.Repository}:${i.Tag}`, i]));
    const ids = lines(imgIds.out);
    let images = [];
    if (ids.length) {
      const r = await dk(['image', 'inspect', ...ids], { timeout: 30_000, max: 32 << 20 });
      try {
        images = JSON.parse(r.out).map((i) => ({
          id: i.Id.replace('sha256:', '').slice(0, 12), fullId: i.Id, tags: i.RepoTags || [], digests: (i.RepoDigests || []).slice(0, 2), size: i.Size, created: Date.parse(i.Created), arch: `${i.Os}/${i.Architecture}`,
          usedBy: usedImage.get(i.Id) || [], dangling: !(i.RepoTags && i.RepoTags.length),
        }));
      } catch {}
    }
    const netIds = lines(nets.out);
    let networks = [];
    if (netIds.length) {
      const r = await dk(['network', 'inspect', ...netIds], { timeout: 30_000 });
      try {
        networks = JSON.parse(r.out).map((n) => ({
          id: n.Id.slice(0, 12), name: n.Name, driver: n.Driver, scope: n.Scope, internal: !!n.Internal, ipv6: !!n.EnableIPv6,
          subnets: ((n.IPAM && n.IPAM.Config) || []).map((c) => c.Subnet).filter(Boolean), containers: Object.values(n.Containers || {}).map((c) => c.Name), builtin: ['bridge', 'host', 'none'].includes(n.Name),
        }));
      } catch {}
    }
    const volumes = jsonLines(vols.out).map((v) => ({ name: v.Name, driver: v.Driver, mountpoint: v.Mountpoint, size: volSize.get(v.Name) ?? null, usedBy: usedVol.get(v.Name) || [] }));
    const projects = {};
    for (const c of containers) {
      if (!c.compose) continue;
      const p = (projects[c.compose.project] ||= { name: c.compose.project, dir: c.compose.dir, files: c.compose.files, services: new Set(), running: 0, total: 0 });
      p.total++; if (c.state === 'running') p.running++; p.services.add(c.compose.service);
    }
    let infoO = {};
    try { infoO = JSON.parse(info.out); } catch {}
    return {
      containers, images, volumes, networks,
      projects: Object.values(projects).map((p) => ({ ...p, services: [...p.services].sort() })),
      usage: jsonLines(df.out).map((d) => ({ type: d.Type, total: +d.TotalCount, active: +d.Active, size: parseSize(d.Size), reclaimable: parseSize(String(d.Reclaimable || '').replace(/\s*\(.*\)$/, '')), reclaimText: d.Reclaimable })),
      info: { version: infoO.ServerVersion, driver: infoO.Driver, root: infoO.DockerRootDir, cgroup: infoO.CgroupVersion, ncpu: infoO.NCPU, mem: infoO.MemTotal, os: infoO.OperatingSystem, kernel: infoO.KernelVersion, runtime: infoO.DefaultRuntime, logging: infoO.LoggingDriver },
    };
  },

  async 'docker.inspect'({ name }) {
    await mustExist(name);
    const r = await dk(['inspect', name], { timeout: 20_000, max: 8 << 20 });
    let c;
    try { c = JSON.parse(r.out)[0]; } catch { throw fail('Inspect fehlgeschlagen.'); }
    const hc = c.HostConfig || {}; const cf = c.Config || {};
    return {
      name, id: c.Id, image: cf.Image, imageId: c.Image, created: c.Created, started: c.State.StartedAt, finished: c.State.FinishedAt, state: c.State,
      cmd: cf.Cmd, entrypoint: cf.Entrypoint, workdir: cf.WorkingDir, user: cf.User, hostname: cf.Hostname,
      envKeys: (cf.Env || []).map((e) => e.split('=')[0]), labels: cf.Labels || {},
      mounts: (c.Mounts || []).map((m) => ({ type: m.Type, source: m.Source || m.Name, dest: m.Destination, rw: m.RW })),
      networks: Object.entries((c.NetworkSettings && c.NetworkSettings.Networks) || {}).map(([n, v]) => ({ name: n, ip: v.IPAddress, gateway: v.Gateway, aliases: v.Aliases || [] })),
      ports: (c.NetworkSettings && c.NetworkSettings.Ports) || {},
      restartPolicy: hc.RestartPolicy, memory: hc.Memory, memSwap: hc.MemorySwap, cpuShares: hc.CpuShares, nanoCpus: hc.NanoCpus, privileged: hc.Privileged, capAdd: hc.CapAdd, networkMode: hc.NetworkMode, logDriver: hc.LogConfig && hc.LogConfig.Type,
      health: c.State.Health ? { status: c.State.Health.Status, failing: c.State.Health.FailingStreak, log: (c.State.Health.Log || []).slice(-3).map((l) => ({ at: l.End, exit: l.ExitCode, out: String(l.Output || '').slice(0, 300) })) } : null,
      restartCount: c.RestartCount,
    };
  },

  async 'docker.control'({ name, action }) {
    if (!['start', 'stop', 'restart', 'pause', 'unpause', 'kill'].includes(action)) throw fail('Ungültige Aktion.');
    await mustExist(name);
    const args = action === 'stop' || action === 'restart' ? [action, '-t', '20', name] : [action, name];
    const r = await dk(args, { timeout: 90_000 });
    if (r.code !== 0) throw fail(`docker ${action} fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 400)}`);
    return { name, action };
  },

  async 'docker.remove'({ name, volumes }) {
    await mustExist(name);
    const r = await dk(['rm', '-f', ...(volumes ? ['-v'] : []), name], { timeout: 60_000 });
    if (r.code !== 0) throw fail(`Entfernen fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 400)}`);
    return { name };
  },

  async 'docker.rename'({ name, to }) {
    await mustExist(name);
    if (typeof to !== 'string' || !NAME_RE.test(to)) throw fail('Ungültiger neuer Name.');
    const r = await dk(['rename', name, to], { timeout: 20_000 });
    if (r.code !== 0) throw fail(`Umbenennen fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 300)}`);
    return { name, to };
  },

  async 'docker.restart-policy'({ name, policy }) {
    await mustExist(name);
    if (!['no', 'always', 'unless-stopped', 'on-failure'].includes(policy)) throw fail('Ungültige Neustart-Regel.');
    const r = await dk(['update', '--restart', policy, name], { timeout: 20_000 });
    if (r.code !== 0) throw fail(`Änderung fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 300)}`);
    return { name, policy };
  },

  async 'docker.image-pull'({ ref }) {
    if (typeof ref !== 'string' || !REF_RE.test(ref)) throw fail('Ungültiger Image-Name.');
    return jobs.start('pull', `Image laden: ${ref}`, 'docker', ['pull', ref], { env: ENV });
  },

  async 'docker.image-remove'({ id, force }) {
    if (typeof id !== 'string' || !(IMG_ID_RE.test(id) || REF_RE.test(id))) throw fail('Ungültige Image-Angabe.');
    const chk = await dk(['image', 'inspect', '--format', '{{.Id}}', '--', id], { timeout: 15_000 });
    if (chk.code !== 0) throw fail('Dieses Image existiert nicht.');
    const r = await dk(['rmi', ...(force ? ['-f'] : []), '--', id], { timeout: 60_000 });
    if (r.code !== 0) throw fail(`Entfernen fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 400)}`);
    return { id };
  },

  async 'docker.volume-remove'({ name }) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw fail('Ungültiger Volume-Name.');
    const r = await dk(['volume', 'rm', '--', name], { timeout: 60_000 });
    if (r.code !== 0) throw fail(`Entfernen fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 400)}`);
    return { name };
  },

  async 'docker.network-remove'({ name }) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) throw fail('Ungültiger Netzwerkname.');
    if (['bridge', 'host', 'none'].includes(name)) throw fail('Eingebaute Netzwerke lassen sich nicht entfernen.');
    const r = await dk(['network', 'rm', '--', name], { timeout: 30_000 });
    if (r.code !== 0) throw fail(`Entfernen fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 400)}`);
    return { name };
  },

  async 'docker.prune'({ kind }) {
    const map = {
      containers: ['container', 'prune', '-f'], images: ['image', 'prune', '-f'], 'images-all': ['image', 'prune', '-a', '-f'],
      networks: ['network', 'prune', '-f'], builder: ['builder', 'prune', '-f'], volumes: ['volume', 'prune', '-f'],
    };
    if (!map[kind]) throw fail('Unbekannte Aufräum-Art.');
    const r = await dk(map[kind], { timeout: 180_000 });
    if (r.code !== 0) throw fail(`Aufräumen fehlgeschlagen: ${(r.err || r.out).trim().slice(0, 400)}`);
    const m = /Total reclaimed space:\s*(.+)/.exec(r.out);
    return { reclaimed: m ? m[1].trim() : '0B', text: clip(r.out, 4000) };
  },

  async 'docker.compose'({ project, action }) {
    const allowed = { up: ['up', '-d'], down: ['down'], restart: ['restart'], pull: ['pull'], stop: ['stop'], start: ['start'] };
    if (!allowed[action]) throw fail('Ungültige Aktion.');
    if (typeof project !== 'string' || !NAME_RE.test(project)) throw fail('Ungültiger Projektname.');
    const inv = await inspectAll();
    const c = inv.map(composeOf).find((x) => x && x.project === project);
    if (!c) throw fail('Dieses Compose-Projekt existiert nicht.');
    if (!c.dir || !fs.existsSync(c.dir)) throw fail('Das Projektverzeichnis existiert nicht mehr.');
    const files = c.files.filter((f) => f.startsWith('/') && fs.existsSync(f));
    const args = ['compose', '-p', project, '--project-directory', c.dir, ...files.flatMap((f) => ['-f', f]), ...allowed[action]];
    return jobs.start('compose', `Compose ${action}: ${project}`, 'docker', args, { env: ENV, cwd: c.dir });
  },

  async 'logs.docker'({ name, lines: n }) {
    await mustExist(name);
    const r = await dk(['logs', '--tail', String(Math.min(2000, Math.max(10, Number.isInteger(n) ? n : 200))), '--timestamps', name], { timeout: 20_000 });
    return { text: clip(r.out + r.err) };
  },
};

module.exports = { ops };
