const $ = (s) => document.querySelector(s);
const post = async (url, body) => {
  const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-SD': '1' }, body: JSON.stringify(body), credentials: 'same-origin' });
  let j = {};
  try { j = await r.json(); } catch {}
  return { ok: r.ok, status: r.status, ...j };
};

function strength(pw) {
  if (pw.length === 0) return { pct: 0, text: 'Mindestens 12 Zeichen.', color: 'var(--crit)' };
  let score = 0;
  if (pw.length >= 12) score += 1;
  if (pw.length >= 16) score += 1;
  if (pw.length >= 20) score += 1;
  const classes = [/[a-zäöüß]/, /[A-ZÄÖÜ]/, /\d/, /[^A-Za-zäöüÄÖÜß\d]/].filter((r) => r.test(pw)).length;
  score += Math.max(0, classes - 1);
  if (new Set(pw).size < 6) score = 0;
  if (pw.length < 12) return { pct: Math.min(30, (pw.length / 12) * 30), text: `Noch ${12 - pw.length} Zeichen bis zum Minimum.`, color: 'var(--crit)' };
  const pct = Math.min(100, 35 + score * 13);
  return pct < 60 ? { pct, text: 'Geht, aber länger oder gemischter ist besser.', color: 'var(--warn)' } : { pct, text: pct < 85 ? 'Gut.' : 'Sehr gut.', color: 'var(--ok)' };
}

function countdown(el, secs) {
  const end = Date.now() + secs * 1000;
  const tick = () => {
    const left = Math.max(0, Math.ceil((end - Date.now()) / 1000));
    el.textContent = `Zu viele Versuche. Bitte warte ${left > 90 ? `${Math.ceil(left / 60)} Min` : `${left} s`}.`;
    if (left > 0) setTimeout(tick, 1000); else el.textContent = '';
  };
  tick();
}

for (const b of document.querySelectorAll('.eye')) {
  b.addEventListener('click', () => {
    const i = document.getElementById(b.dataset.for);
    const show = i.type === 'password';
    i.type = show ? 'text' : 'password';
    b.textContent = show ? 'verbergen' : 'anzeigen';
  });
}

async function submit(form, errEl, url, body) {
  const btn = form.querySelector('button.primary');
  btn.disabled = true;
  errEl.textContent = '';
  try {
    const r = await post(url, body);
    if (r.ok) { location.replace('/'); return; }
    if (r.status === 401 && r.error === 'totp_required') {
      $('#l-code-box').classList.remove('hidden');
      $('#l-code').focus();
      errEl.textContent = 'Passwort richtig. Bitte jetzt den Code aus deiner Authenticator-App eingeben.';
    } else if (r.status === 429 && r.retry) countdown(errEl, r.retry);
    else if (r.status === 409 && r.error === 'setup_required') { location.reload(); }
    else errEl.textContent = r.error || 'Das hat nicht geklappt.';
  } catch {
    errEl.textContent = 'Keine Verbindung zum Server.';
  }
  btn.disabled = false;
}

(async function init() {
  let st = { setup: false, authed: false };
  try { st = await (await fetch('/auth/status', { credentials: 'same-origin' })).json(); } catch {}
  if (st.authed) { location.replace('/'); return; }
  $('#loading').classList.add('hidden');
  if (st.setup) {
    const f = $('#setup');
    f.classList.remove('hidden');
    $('#s-email').focus();
    const meter = $('#meter');
    const hint = $('#s-hint');
    $('#s-pw').addEventListener('input', (e) => {
      const s = strength(e.target.value);
      meter.style.width = `${s.pct}%`;
      meter.style.background = s.color;
      hint.textContent = s.text;
    });
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      const err = $('#s-err');
      if ($('#s-pw').value !== $('#s-pw2').value) { err.textContent = 'Die Passwörter stimmen nicht überein.'; return; }
      submit(f, err, '/auth/setup', { email: $('#s-email').value, code: $('#s-code').value, password: $('#s-pw').value });
    });
  } else {
    const f = $('#login');
    f.classList.remove('hidden');
    $('#l-email').focus();
    f.addEventListener('submit', (e) => {
      e.preventDefault();
      submit(f, $('#l-err'), '/auth/login', { email: $('#l-email').value, password: $('#l-pw').value, code: $('#l-code').value.trim() || undefined });
    });
  }
})();
