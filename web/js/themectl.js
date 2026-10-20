// Theme switch: 'light' (default), 'dark' or 'auto' (follows the system). Stored per browser.

import { store } from './store.js';

const KEY = 'sd.theme';
export const THEMES = [['light', 'Hell'], ['dark', 'Dunkel'], ['auto', 'Automatisch']];
const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;

export function getTheme() { try { return localStorage.getItem(KEY) || 'light'; } catch { return 'light'; } }
export const isDark = () => document.documentElement.getAttribute('data-theme') === 'dark';

function apply() {
  const mode = getTheme();
  const dark = mode === 'dark' || (mode === 'auto' && mq && mq.matches);
  const want = dark ? 'dark' : 'light';
  if (document.documentElement.getAttribute('data-theme') !== want) document.documentElement.setAttribute('data-theme', want);
  store.emit('theme', want);
}

export function setTheme(mode) {
  try { localStorage.setItem(KEY, mode); } catch {}
  apply();
}

/** light -> dark -> auto -> light */
export function cycleTheme() {
  const order = THEMES.map((t) => t[0]);
  setTheme(order[(order.indexOf(getTheme()) + 1) % order.length]);
}

if (mq) mq.addEventListener('change', () => { if (getTheme() === 'auto') apply(); });
