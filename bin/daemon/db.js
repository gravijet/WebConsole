'use strict';
// Database servers on the host: MariaDB/MySQL, Redis, PostgreSQL. Read-only overview, plus killing a MySQL query.

const { run, fail, int } = require('./core');

const sqlRows = (out) => out.split('\n').filter(Boolean).map((l) => l.split('\t'));
const kvInfo = (text) => { const o = {}; for (const l of text.split(/\r?\n/)) { if (!l || l.startsWith('#')) continue; const i = l.indexOf(':'); if (i > 0) o[l.slice(0, i)] = l.slice(i + 1); } return o; };

async function active(unit) { return (await run('systemctl', ['is-active', unit], { timeout: 8000 })).out.trim(); }

async function mariadb() {
  const unit = (await active('mariadb')) === 'active' ? 'mariadb' : (await active('mysql')) === 'active' ? 'mysql' : null;
  const state = unit ? 'active' : await active('mariadb');
  const base = { unit: unit || 'mariadb', state };
  if (!unit) return { ...base, available: false };
  const q = (sql) => run('mariadb', ['-N', '-B', '-e', sql], { timeout: 20_000 });
  const status = await q("SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Threads_connected','Threads_running','Questions','Slow_queries','Connections','Aborted_connects','Aborted_clients','Bytes_received','Bytes_sent','Innodb_buffer_pool_reads','Innodb_buffer_pool_read_requests','Created_tmp_disk_tables','Open_tables','Max_used_connections')");
  if (status.code !== 0) return { ...base, available: false, error: (status.err || status.out).trim().slice(0, 300) };
  const vars = await q("SHOW GLOBAL VARIABLES WHERE Variable_name IN ('version','version_comment','max_connections','innodb_buffer_pool_size','datadir','character_set_server','bind_address','slow_query_log','long_query_time')");
  const dbs = await q('SELECT table_schema, COUNT(*), COALESCE(SUM(data_length),0), COALESCE(SUM(index_length),0), COALESCE(SUM(data_free),0) FROM information_schema.tables GROUP BY table_schema ORDER BY SUM(data_length+index_length) DESC');
  const procs = await q('SELECT id, user, host, COALESCE(db,\'\'), command, time, COALESCE(state,\'\'), COALESCE(LEFT(info,300),\'\') FROM information_schema.processlist ORDER BY time DESC');
  const users = await q('SELECT user, host, IF(authentication_string=\'\' AND plugin IN (\'mysql_native_password\',\'\'), 1, 0) FROM mysql.user ORDER BY user, host');
  return {
    ...base, available: true,
    status: Object.fromEntries(sqlRows(status.out).map((r) => [r[0], +r[1]])),
    vars: Object.fromEntries(sqlRows(vars.out).map((r) => [r[0], r[1]])),
    databases: sqlRows(dbs.out).map((r) => ({ name: r[0], tables: +r[1], data: +r[2], index: +r[3], free: +r[4] })),
    processes: sqlRows(procs.out).map((r) => ({ id: +r[0], user: r[1], host: r[2], db: r[3], command: r[4], time: +r[5], state: r[6], info: r[7] })),
    users: sqlRows(users.out).map((r) => ({ user: r[0], host: r[1], noPassword: r[2] === '1' })),
  };
}

async function redis() {
  const state = await active('redis-server');
  const base = { unit: 'redis-server', state };
  if (state !== 'active') return { ...base, available: false };
  const r = await run('redis-cli', ['-h', '127.0.0.1', '--no-auth-warning', 'INFO'], { timeout: 10_000 });
  if (r.code !== 0 || /^(NOAUTH|-NOAUTH|\(error\))/m.test(r.out) || !/redis_version/.test(r.out)) return { ...base, available: false, error: /NOAUTH|requires/i.test(r.out + r.err) ? 'Redis verlangt ein Passwort. Das Dashboard kennt es nicht und liest es bewusst nicht aus Konfigurationsdateien.' : (r.err || r.out).trim().slice(0, 300) };
  const i = kvInfo(r.out);
  const ks = Object.entries(i).filter(([k]) => /^db\d+$/.test(k)).map(([k, v]) => { const m = /keys=(\d+),expires=(\d+)/.exec(v) || []; return { db: k, keys: +m[1] || 0, expires: +m[2] || 0 }; });
  return { ...base, available: true, info: i, keyspace: ks };
}

async function postgres() {
  const units = (await run('systemctl', ['list-units', 'postgresql*', '--all', '--no-legend', '--plain', '--no-pager'], { timeout: 10_000 })).out.split('\n').filter(Boolean).map((l) => l.split(/\s+/).slice(0, 4));
  const cluster = units.find((u) => /^postgresql@/.test(u[0]));
  const state = cluster ? cluster[2] : 'inactive';
  const base = { unit: cluster ? cluster[0] : 'postgresql@15-main.service', state };
  if (state !== 'active') return { ...base, available: false };
  const q = (sql) => run('runuser', ['-u', 'postgres', '--', 'psql', '-At', '-F', '\t', '-c', sql], { timeout: 20_000 });
  const dbs = await q('SELECT datname, pg_database_size(datname), numbackends FROM pg_stat_database WHERE datname IS NOT NULL ORDER BY 2 DESC');
  if (dbs.code !== 0) return { ...base, available: false, error: (dbs.err || dbs.out).trim().slice(0, 300) };
  const ver = await q('SHOW server_version');
  const act = await q("SELECT pid, usename, COALESCE(datname,''), state, EXTRACT(EPOCH FROM (now()-query_start))::int, LEFT(query,200) FROM pg_stat_activity WHERE pid <> pg_backend_pid() AND backend_type='client backend' ORDER BY query_start NULLS LAST");
  return {
    ...base, available: true, version: ver.out.trim(),
    databases: sqlRows(dbs.out).map((r) => ({ name: r[0], size: +r[1], connections: +r[2] })),
    activity: sqlRows(act.out).map((r) => ({ pid: +r[0], user: r[1], db: r[2], state: r[3], seconds: +r[4], query: r[5] })),
  };
}

const ops = {
  async 'db.overview'() {
    const [m, r, p] = await Promise.all([mariadb(), redis(), postgres()]);
    return { mariadb: m, redis: r, postgres: p };
  },

  async 'db.mysql-kill'({ id }) {
    int(id, 1, 2_000_000_000, 'Die Verbindungs-ID');
    const r = await run('mariadb', ['-N', '-B', '-e', `KILL ${id}`], { timeout: 15_000 });
    if (r.code !== 0) throw fail(`MariaDB: ${(r.err || r.out).trim().slice(0, 200)}`);
    return { id };
  },
};

module.exports = { ops };
