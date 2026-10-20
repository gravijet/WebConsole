'use strict';
// Numeric fields kept in the history tiers. Everything is derived from the system at
// runtime; per-core fields (c0..cN) are generated from the actual core count.

const os = require('os');
const CORES = os.cpus().length;

const BASE = [
  // cpu (percent of all cores)
  'cpu', 'cu', 'cs', 'ci', 'cw', 'ct',
  // load, scheduler
  'l1', 'l5', 'l15', 'run', 'blk', 'proc', 'thr', 'ctx', 'intr', 'fork',
  // pressure stall information (percent of time stalled)
  'pc10', 'pc60', 'pc300', 'pm10', 'pm60', 'pm300', 'pmf10', 'pi10', 'pi60', 'pi300', 'pif10',
  // memory (bytes)
  'mu', 'mc', 'mb', 'mf', 'ma', 'msh', 'msl', 'mdirty', 'manon', 'mmap', 'mact', 'minact', 'mpt', 'mcommit', 'su', 'sc',
  // vm activity (per second)
  'pgf', 'pgmaj', 'swin', 'swout', 'pgin', 'pgout', 'scan',
  // network, primary interface (bytes or packets per second)
  'rx', 'tx', 'rxp', 'txp', 'rxe', 'txe', 'rxd', 'txd', 'vrx', 'vtx',
  // tcp / udp (per second) and connection states (count)
  'tIn', 'tOut', 'tRet', 'tAO', 'tPO', 'tRst', 'tFail', 'uIn', 'uOut', 'est', 'tw', 'cwt', 'lst', 'fw', 'syn',
  // web server
  'req', 'act', 'rdg', 'wrg', 'wtg',
  // disk (primary device)
  'dr', 'dw', 'dri', 'dwi', 'drl', 'dwl', 'dq', 'du', 'dsu', 'dsi',
  // system
  'fd', 'ent', 'usr',
  // internet latency (ms)
  'lat1', 'lat2', 'lat3', 'dns',
  // docker (sum over containers)
  'dcpu', 'dmem', 'dcnt',
];

const FIELDS = [...BASE, ...Array.from({ length: CORES }, (_, i) => `c${i}`)];
const MAXED = ['cpu', 'rx', 'tx', 'req', 'dr', 'dw', 'du', 'l1', 'mu', 'pc10', 'pm10', 'pi10'];

module.exports = { FIELDS, MAXED, CORES };
