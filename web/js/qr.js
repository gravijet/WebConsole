// QR code as an SVG element (black on white with a quiet zone, readable in light and dark mode).

import qrcode from './vendor/qrcode.js';
import { s } from './dom.js';

export function qrSvg(text, px = 220) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const quiet = 3;
  const size = n + quiet * 2;
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) d += `M${c + quiet} ${r + quiet}h1v1h-1z`;
  return s('svg', { viewBox: `0 0 ${size} ${size}`, width: px, height: px, role: 'img', 'aria-label': 'QR-Code', 'shape-rendering': 'crispEdges' },
    s('rect', { width: size, height: size, fill: '#ffffff' }), s('path', { d, fill: '#000000' }));
}
