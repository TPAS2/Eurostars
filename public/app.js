'use strict';

document.addEventListener('DOMContentLoaded', () => {
  // Copies of unsent forms are kept on this device. They belong to whoever typed them: when
  // someone else signs in on the same browser, the previous person's copies are wiped first.
  (() => {
    const who = document.body && document.body.dataset.who;
    if (!who) return;
    try {
      const store = window.localStorage;
      if (store.getItem('rift:who') === who) return;
      for (let i = store.length - 1; i >= 0; i -= 1) {
        const k = store.key(i);
        if (/^(draft|keep|unsaved):/.test(k)) store.removeItem(k);
      }
      store.setItem('rift:who', who);
    } catch { /* storage blocked */ }
  })();

  // Confirm destructive actions.
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!window.confirm(form.dataset.confirm)) e.preventDefault();
    });
  });

  document.querySelectorAll('[data-print]').forEach((btn) => btn.addEventListener('click', () => window.print()));

  // Admin sign-up chart bar heights (set from JS so the CSP can forbid inline styles).
  document.querySelectorAll('.bar-fill[data-h]').forEach((el) => {
    el.style.height = `${Math.max(2, Number(el.dataset.h))}%`;
  });

  // Add-tenant form: switch between creating a new tenant and choosing an existing one.
  const radios = document.querySelectorAll('input[name="tenant_mode"]');
  if (radios.length) {
    const sync = () => {
      const mode = document.querySelector('input[name="tenant_mode"]:checked').value;
      document.querySelectorAll('[data-mode]').forEach((group) => {
        const on = group.dataset.mode === mode;
        group.hidden = !on;
        group.querySelectorAll('input, select, textarea').forEach((el) => { el.disabled = !on; });
      });
      const existing = document.getElementById('f-tenant_id');
      if (existing) existing.required = mode === 'existing';
    };
    radios.forEach((r) => r.addEventListener('change', sync));
    sync();
  }
});

// Whole-row click on invoice tables (links and buttons inside still work normally).
document.addEventListener('click', (e) => {
  const row = e.target.closest('tr[data-href]');
  if (!row || e.target.closest('a, button, input, select, form')) return;
  window.location.href = row.dataset.href;
});

// Long-running forms (AI generation): disable the button and show progress text.
document.addEventListener('submit', (e) => {
  const form = e.target;
  if (!form.dataset || !form.dataset.busy || e.defaultPrevented) return;
  const btn = form.querySelector('button[type="submit"]');
  if (btn) { btn.disabled = true; btn.textContent = form.dataset.busy; }
});

// ---------- Autosave ----------
// Edit forms ([data-autosave]) save to the server a moment after each change.
// Create forms ([data-draft]) keep a draft in this browser until they're submitted.
// Everything typed is kept: edit forms save to the server, and every form also keeps a copy
// in this browser until it's saved, so nothing is lost if the session ends or the page closes.
// window.riftFlush() saves everything right now (used before signing out for inactivity).
const flushers = [];
window.riftFlush = () => Promise.all(flushers.map((f) => Promise.resolve().then(f).catch(() => {})));
const DRAFT_DAYS = 7;

(() => {
  const DEBOUNCE_MS = 900;

  function formBody(form) {
    const body = new URLSearchParams();
    for (const [k, v] of new FormData(form)) if (typeof v === 'string') body.append(k, v);
    return body;
  }

  function setStatus(form, text, cls) {
    const el = form.querySelector('.save-status');
    if (!el) return;
    el.textContent = text;
    el.className = `save-status ${cls || ''}`;
  }

  function clearFieldErrors(form) {
    form.querySelectorAll('.field-err.live').forEach((e) => e.remove());
  }

  function showFieldErrors(form, errors) {
    clearFieldErrors(form);
    for (const [name, msg] of Object.entries(errors)) {
      const input = [...form.elements].find((el) => el.name === name);
      const field = input && input.closest('.field');
      if (!field) continue;
      const div = document.createElement('div');
      div.className = 'field-err live';
      div.textContent = msg;
      field.appendChild(div);
    }
  }

  function formValues(form) {
    const values = {};
    for (const [k, v] of new FormData(form)) {
      const el = [...form.elements].find((x) => x.name === k);
      // Never kept: passwords, one-time codes, and confirmations like "type the username to delete".
      if (el && (el.type === 'password' || el.autocomplete === 'one-time-code' || el.hasAttribute('data-no-keep'))) continue;
      if (typeof v === 'string' && k !== '_csrf') values[k] = v;
    }
    return values;
  }

  function applyValues(form, values) {
    for (const [name, value] of Object.entries(values)) {
      [...form.elements].filter((el) => el.name === name).forEach((el) => {
        if (el.type === 'radio' || el.type === 'checkbox') el.checked = el.value === value;
        else if (!['file', 'hidden', 'password'].includes(el.type)) el.value = value;
      });
    }
  }

  function sameValues(a, b) {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) if ((a[k] ?? '') !== (b[k] ?? '')) return false;
    return true;
  }

  function readDraft(store, key) {
    let saved = null;
    try { saved = JSON.parse(store.getItem(key) || 'null'); } catch { saved = null; }
    if (!saved || !saved.values || Date.now() - saved.at > DRAFT_DAYS * 86400000) return null;
    return saved;
  }

  function restoredNote(form, text, onDiscard) {
    const note = document.createElement('div');
    note.className = 'notice ok draft-note';
    note.textContent = `${text} `;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'link-btn inline';
    btn.textContent = 'Discard';
    btn.addEventListener('click', onDiscard);
    note.appendChild(btn);
    form.parentNode.insertBefore(note, form);
  }

  function setupAutosave(form) {
    let timer = null;
    let inFlight = null;
    let dirty = false;
    // A copy of unsaved changes on this device, cleared once the server has them.
    const store = storage();
    // Forms sharing one address (e.g. a notes box per row) each give their own key.
    const backupKey = `unsaved:${form.dataset.autosaveKey || new URL(form.action, location.href).pathname}`;
    const keepBackup = () => { if (store) try { store.setItem(backupKey, JSON.stringify({ at: Date.now(), values: formValues(form) })); } catch { /* full or blocked */ } };
    const dropBackup = () => { if (store) try { store.removeItem(backupKey); } catch { /* ignore */ } };

    async function save() {
      if (inFlight) { await inFlight; }
      if (!dirty) return;
      dirty = false;
      setStatus(form, 'Saving…', 'busy');
      inFlight = fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Autosave': '1', Accept: 'application/json' },
        body: formBody(form),
        credentials: 'same-origin',
      }).then(async (res) => {
        if (res.ok) {
          if (!dirty) dropBackup();
          clearFieldErrors(form);
          // The server can send back figures elsewhere on the page that changed (e.g. totals).
          const data = await res.json().catch(() => null);
          // The save moved something on the page (e.g. an entry ended): show the new page.
          if (data && typeof data.reload === 'string' && data.reload.startsWith('/app/')) { window.location.href = data.reload; return; }
          for (const u of (data && data.updates) || []) {
            const el = document.getElementById(u.id);
            if (!el) continue;
            el.textContent = u.text;
            if (u.className !== undefined) el.className = u.className;
          }
          setStatus(form, `All changes saved · ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`, 'ok');
        } else if (res.status === 422) {
          const data = await res.json().catch(() => ({ errors: {} }));
          showFieldErrors(form, data.errors || {});
          setStatus(form, 'Not saved: fix the highlighted field', 'err');
        } else if (res.status === 401 || res.status === 403 || res.redirected) {
          // Signed out: the changes stay on this device and are saved after signing back in.
          dirty = true;
          keepBackup();
          setStatus(form, 'Signed out: your changes are kept and will save after you sign in again.', 'err');
          if (res.status === 401 && window.riftSignedOut) window.riftSignedOut();
        } else {
          dirty = true;
          setStatus(form, 'Not saved: will retry…', 'err');
          timer = setTimeout(save, 5000);
        }
      }).catch(() => {
        dirty = true;
        setStatus(form, 'Offline: will retry…', 'err');
        timer = setTimeout(save, 5000);
      }).finally(() => { inFlight = null; });
      await inFlight;
    }

    const schedule = () => {
      dirty = true;
      keepBackup();
      setStatus(form, 'Unsaved changes…', 'busy');
      clearTimeout(timer);
      timer = setTimeout(save, DEBOUNCE_MS);
    };
    flushers.push(async () => { keepBackup(); if (dirty || inFlight) { clearTimeout(timer); dirty = true; await save(); } });

    // Changes kept from last time (e.g. signed out before they saved): put them back and save.
    const pending = store && readDraft(store, backupKey);
    if (pending && !sameValues(pending.values, formValues(form))) {
      applyValues(form, pending.values);
      restoredNote(form, 'Restored changes that hadn’t been saved yet. They’re being saved now.', () => { dropBackup(); window.location.reload(); });
      dirty = true;
      timer = setTimeout(save, 300);
    } else if (pending) dropBackup();
    form.addEventListener('input', schedule);
    form.addEventListener('change', schedule);
    // Fields placed elsewhere on the page but belonging to this form (form="…") save with it too.
    for (const el of form.elements) {
      if (form.contains(el)) continue;
      el.addEventListener('input', schedule);
      el.addEventListener('change', schedule);
    }
    form.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(timer); dirty = true; save(); });

    // Flush on leaving the page; warn if a save is still pending.
    window.addEventListener('beforeunload', (e) => {
      if (!dirty && !inFlight) return;
      clearTimeout(timer);
      // sendBeacon survives the page closing; only warn if the browser can't send it.
      const sent = navigator.sendBeacon && navigator.sendBeacon(form.action, formBody(form));
      if (!sent) { e.preventDefault(); e.returnValue = ''; }
    });
    if ((!pending || sameValues(pending.values, formValues(form))) && !form.hasAttribute('data-autosave-quiet')) setStatus(form, 'Changes save automatically', '');
  }

  function storage() {
    try { return window.localStorage; } catch { return null; }
  }

  function setupDraft(form) {
    const store = storage();
    if (!store) return;
    const key = `draft:${form.dataset.draft}`;
    const hasServerErrors = !!form.querySelector('.field-err');
    let saved = null;
    try { saved = JSON.parse(store.getItem(key) || 'null'); } catch { saved = null; }

    // Restore a draft unless the server just re-rendered the form with the user's input.
    if (saved && !hasServerErrors && Date.now() - saved.at < 7 * 86400000) {
      for (const [name, value] of Object.entries(saved.values)) {
        const inputs = form.querySelectorAll(`[name="${CSS.escape(name)}"]`);
        inputs.forEach((el) => {
          if (el.type === 'radio' || el.type === 'checkbox') el.checked = el.value === value;
          else if (el.type !== 'file' && el.type !== 'hidden') el.value = value;
        });
      }
      form.querySelectorAll('input[name="tenant_mode"]:checked').forEach((r) => r.dispatchEvent(new Event('change')));
      const note = document.createElement('div');
      note.className = 'notice ok draft-note';
      note.innerHTML = 'Restored your unsaved draft. <button type="button" class="link-btn inline">Discard draft</button>';
      note.querySelector('button').addEventListener('click', () => { store.removeItem(key); window.location.reload(); });
      form.parentNode.insertBefore(note, form);
    }

    let timer = null;
    const persist = () => {
      const values = {};
      for (const [k, v] of new FormData(form)) {
        if (typeof v === 'string' && k !== '_csrf') values[k] = v;
      }
      try { store.setItem(key, JSON.stringify({ at: Date.now(), values })); } catch { /* storage full or blocked */ }
      setStatus(form, 'Draft saved on this device', 'ok');
    };
    form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(persist, 500); });
    form.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(persist, 500); });
    form.addEventListener('submit', () => { try { store.removeItem(key); } catch { /* ignore */ } });
    flushers.push(() => { if (timer) { clearTimeout(timer); persist(); } });
  }

  // Every other form with something to type in (paying an invoice, the admin's forms, …)
  // also keeps a copy of what's typed on this device until it's submitted. Passwords never are.
  function setupKeeper(form) {
    const store = storage();
    if (!store) return;
    const key = `keep:${location.pathname}:${new URL(form.action, location.href).pathname}`;
    const initial = formValues(form);
    const saved = readDraft(store, key);
    if (saved && !form.querySelector('.field-err') && !sameValues(saved.values, initial)) {
      applyValues(form, saved.values);
      form.querySelectorAll('input[name="tenant_mode"]:checked').forEach((r) => r.dispatchEvent(new Event('change')));
      restoredNote(form, 'Restored what you’d typed here before.', () => { try { store.removeItem(key); } catch { /* ignore */ } window.location.reload(); });
    }
    let timer = null;
    const persist = () => {
      timer = null;
      const values = formValues(form);
      try {
        if (sameValues(values, initial)) store.removeItem(key);
        else store.setItem(key, JSON.stringify({ at: Date.now(), values }));
      } catch { /* full or blocked */ }
    };
    form.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(persist, 400); });
    form.addEventListener('change', () => { clearTimeout(timer); timer = setTimeout(persist, 400); });
    form.addEventListener('submit', () => { clearTimeout(timer); try { store.removeItem(key); } catch { /* ignore */ } });
    flushers.push(() => { if (timer) { clearTimeout(timer); persist(); } });
  }

  document.addEventListener('DOMContentLoaded', () => {
    // Tab access grid: the "All" box ticks or clears a whole row, and follows the row's boxes.
    document.querySelectorAll('tr[data-access-row]').forEach((row) => {
      const all = row.querySelector('[data-access-all]');
      const boxes = [...row.querySelectorAll('input[type=checkbox]:not([data-access-all])')];
      all.addEventListener('change', () => boxes.forEach((b) => { b.checked = all.checked; }));
      boxes.forEach((b) => b.addEventListener('change', () => { all.checked = boxes.every((x) => x.checked); }));
    });
    // Print a file (e.g. the saved payment template) without leaving the page.
    document.querySelectorAll('[data-print-frame]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const old = document.getElementById('print-frame');
        if (old) old.remove();
        const frame = document.createElement('iframe');
        frame.id = 'print-frame';
        frame.hidden = true;
        frame.src = btn.dataset.printFrame;
        frame.addEventListener('load', () => {
          try { frame.contentWindow.focus(); frame.contentWindow.print(); } catch { window.open(btn.dataset.printFrame, '_blank'); }
        });
        document.body.appendChild(frame);
      });
    });
    // Month pickers (and their filters) go straight to the chosen month; no button needed.
    document.querySelectorAll('form[data-autogo]').forEach((form) => {
      form.addEventListener('change', (e) => {
        const el = e.target;
        if (el.type === 'month' && !/^\d{4}-\d{2}$/.test(el.value)) return;
        form.submit();
      });
    });
    // A picture is uploaded as soon as one is chosen.
    document.querySelectorAll('input[type=file][data-autosubmit]').forEach((input) => {
      input.addEventListener('change', () => {
        if (!input.files.length) return;
        // Show that something is happening while large photos upload.
        const label = input.closest('label');
        if (label && input.form.dataset.busy) { label.classList.add('busy'); label.firstChild.textContent = `${input.form.dataset.busy} (${input.files.length}) `; }
        input.form.submit();
      });
    });
    document.querySelectorAll('form[data-autosave]').forEach(setupAutosave);
    document.querySelectorAll('form[data-draft]').forEach(setupDraft);
    if (document.body.dataset.idleMinutes) {
      document.querySelectorAll('form[method="post"]:not([data-autosave]):not([data-draft]):not([data-no-keep])').forEach((form) => {
        const typed = form.querySelector('input:not([type=hidden]):not([type=submit]):not([type=button]):not([type=file]):not([type=password]), textarea, select');
        if (typed) setupKeeper(form);
      });
    }
  });
})();

// Labels for the icon rail: shown beside the square (or below it on narrow screens)
// on hover and keyboard focus. Positioned here so the scrolling rail doesn't clip them.
(() => {
  let tip = null;
  const show = (el) => {
    if (!tip) { tip = document.createElement('div'); tip.className = 'rail-tip'; tip.setAttribute('role', 'tooltip'); document.body.appendChild(tip); }
    tip.textContent = el.dataset.tip;
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const narrow = window.matchMedia('(max-width: 900px)').matches;
    tip.classList.toggle('below', narrow);
    if (narrow) {
      const left = Math.min(Math.max(8, r.left + r.width / 2 - tip.offsetWidth / 2), window.innerWidth - tip.offsetWidth - 8);
      tip.style.left = `${left}px`;
      tip.style.top = `${r.bottom + 8}px`;
    } else {
      tip.style.left = `${r.right + 10}px`;
      tip.style.top = `${r.top + r.height / 2 - tip.offsetHeight / 2}px`;
    }
  };
  const hide = () => { if (tip) tip.hidden = true; };
  document.addEventListener('mouseover', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); });
  document.addEventListener('mouseout', (e) => { const el = e.target.closest('[data-tip]'); if (el && !el.contains(e.relatedTarget)) hide(); });
  document.addEventListener('focusin', (e) => { const el = e.target.closest('[data-tip]'); if (el) show(el); else hide(); });
  document.addEventListener('focusout', hide);
  window.addEventListener('scroll', hide, true);
})();

// "Suggest one": fill a password box with an easy-to-read random password.
document.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-generate]');
  if (!btn) return;
  const input = document.querySelector(btn.dataset.generate);
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const bytes = new Uint32Array(12);
  crypto.getRandomValues(bytes);
  const raw = [...bytes].map((n) => chars[n % chars.length]).join('');
  input.value = `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}`;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
});

// ---------- Sign out after a spell of no use ----------
// Activity (typing, clicking, scrolling) in any tab keeps everyone's tabs signed in. Five
// minutes before the limit a warning appears; at the limit everything typed is saved first,
// then the session ends and the sign-in page offers to carry on where things were left.
(() => {
  const minutes = Number(document.body && document.body.dataset.idleMinutes);
  if (!minutes) return;
  const LIMIT = minutes * 60000;
  const WARN = Math.min(5 * 60000, LIMIT / 2);
  const PING_EVERY = 60000;
  const KEY = 'rift:last-active';
  let store = null;
  try { store = window.localStorage; } catch { store = null; }

  let lastActive = Date.now();
  let lastPing = Date.now();
  let signingOut = false;
  const shared = () => { try { return Number(store && store.getItem(KEY)) || 0; } catch { return 0; } };
  const idleFor = () => Date.now() - Math.max(lastActive, shared());

  function goToSignIn(timedOut) {
    const next = location.pathname + location.search;
    const params = new URLSearchParams(timedOut ? { timeout: '1', next } : { next });
    location.href = `/login?${params}`;
  }

  async function signOut() {
    if (signingOut) return;
    signingOut = true;
    showWarning('Signing you out… saving your work first.', false);
    await Promise.race([window.riftFlush(), new Promise((r) => setTimeout(r, 8000))]);
    const csrf = document.querySelector('input[name="_csrf"]');
    const body = new URLSearchParams({ _csrf: csrf ? csrf.value : '', reason: 'idle', next: location.pathname + location.search });
    try { await fetch('/logout', { method: 'POST', body, credentials: 'same-origin', redirect: 'manual' }); } catch { /* signed out on the server anyway */ }
    goToSignIn(true);
  }

  // The server ended the session already (e.g. the computer was asleep): keep the work, go to sign in.
  window.riftSignedOut = async () => {
    if (signingOut) return;
    signingOut = true;
    await Promise.race([window.riftFlush(), new Promise((r) => setTimeout(r, 3000))]);
    goToSignIn(true);
  };

  let banner = null;
  function showWarning(text, withButton = true) {
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'idle-warning';
      banner.setAttribute('role', 'alert');
      banner.innerHTML = '<span></span><button type="button" class="btn small primary">Stay signed in</button>';
      banner.querySelector('button').addEventListener('click', () => activity(true));
      document.body.appendChild(banner);
    }
    banner.querySelector('span').textContent = text;
    banner.querySelector('button').hidden = !withButton;
    banner.hidden = false;
  }
  const hideWarning = () => { if (banner) banner.hidden = true; };

  async function ping() {
    lastPing = Date.now();
    try {
      const res = await fetch('/session/ping', { credentials: 'same-origin', headers: { Accept: 'application/json' }, cache: 'no-store' });
      if (res.status === 401) window.riftSignedOut();
    } catch { /* offline: try again later */ }
  }

  function activity(force = false) {
    if (signingOut) return;
    const now = Date.now();
    if (!force && idleFor() >= LIMIT) { signOut(); return; }
    if (!force && now - lastActive < 5000) return;
    lastActive = now;
    try { if (store) store.setItem(KEY, String(now)); } catch { /* ignore */ }
    hideWarning();
    if (force || now - lastPing > PING_EVERY) ping();
  }

  ['keydown', 'pointerdown', 'mousemove', 'wheel', 'scroll', 'touchstart', 'input', 'focus'].forEach((ev) => {
    window.addEventListener(ev, () => activity(), { passive: true, capture: true });
  });
  try { if (store) store.setItem(KEY, String(Date.now())); } catch { /* ignore */ }

  function check() {
    if (signingOut) return;
    const idle = idleFor();
    if (idle >= LIMIT) { signOut(); return; }
    if (idle >= LIMIT - WARN) {
      const left = Math.ceil((LIMIT - idle) / 60000);
      showWarning(`You'll be signed out in ${left} minute${left === 1 ? '' : 's'} because the site hasn't been used. Your work is saved.`);
    } else hideWarning();
  }
  setInterval(check, 15000);
  // Timers pause while a computer sleeps, so check as soon as the page is looked at again.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
  window.addEventListener('focus', check);
})();

// Welcome animation after signing in: click or press any key to skip; removed once finished.
(function () {
  document.addEventListener('DOMContentLoaded', () => {
    const intro = document.querySelector('[data-intro]');
    if (!intro) return;
    const done = () => intro.remove();
    const skip = () => { intro.classList.add('skip'); setTimeout(done, 320); };
    intro.addEventListener('click', skip);
    document.addEventListener('keydown', skip, { once: true });
    setTimeout(done, 3200);
  });
})();

// A link to a folded section (e.g. #activity) opens it.
(function () {
  const openTarget = () => {
    const el = location.hash && document.getElementById(location.hash.slice(1));
    if (el && el.tagName === 'DETAILS') el.open = true;
  };
  document.addEventListener('DOMContentLoaded', openTarget);
  window.addEventListener('hashchange', openTarget);
})();

// A button with data-toggle="#id" shows and hides that element.
(function () {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-toggle]');
    if (!btn) return;
    const el = document.querySelector(btn.getAttribute('data-toggle'));
    if (!el) return;
    el.hidden = !el.hidden;
    btn.setAttribute('aria-expanded', String(!el.hidden));
    if (!el.hidden) { const f = el.querySelector('input:not([type=hidden])'); if (f) f.focus(); }
  });
})();

// Contractor invoice form: profit = price to landlord − price to us, as you type.
(function () {
  const pence = (v) => { const n = Number(String(v || '').replace(/[£,\s]/g, '')); return Number.isFinite(n) ? Math.round(n * 100) : NaN; };
  const money = (p) => `${p < 0 ? '−' : ''}£${(Math.abs(p) / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  document.addEventListener('DOMContentLoaded', () => {
    for (const box of document.querySelectorAll('[data-profit]')) {
      const cost = box.querySelector('[data-profit-cost]');
      const price = box.querySelector('[data-profit-price]');
      const out = box.querySelector('[data-profit-out]');
      const charge = box.querySelector('[data-profit-charge]');
      const update = () => {
        const charged = !charge || charge.value !== 'no';
        price.disabled = !charged;
        if (!charged) { out.textContent = 'Not charged'; out.className = 'profit-out muted'; return; }
        const c = pence(cost.value);
        const p = pence(price.value);
        if (!cost.value.trim() || !price.value.trim() || Number.isNaN(c) || Number.isNaN(p)) { out.textContent = '—'; out.className = 'profit-out'; return; }
        out.textContent = money(p - c);
        out.className = `profit-out ${p - c > 0 ? 'ok-text' : p - c < 0 ? 'bad-text' : ''}`;
      };
      cost.addEventListener('input', update);
      price.addEventListener('input', update);
      if (charge) charge.addEventListener('change', update);
      update();
    }
  });
})();

// Contractor invoice form: choosing a property fills in its landlord (unless one was picked by hand).
document.addEventListener('DOMContentLoaded', () => {
  const pick = document.querySelector('[data-landlord-pick]');
  const property = pick && pick.form && pick.form.querySelector('select[name="property_id"]');
  if (!property) return;
  const ownerOf = () => (property.selectedOptions[0] && property.selectedOptions[0].dataset.landlord) || '';
  let auto = !pick.value || pick.value === ownerOf();
  pick.addEventListener('change', () => { auto = !pick.value || pick.value === ownerOf(); });
  const fill = () => { if (auto && [...pick.options].some((o) => o.value === ownerOf())) pick.value = ownerOf(); };
  property.addEventListener('change', fill);
  fill();
});

// Landlord invoice form: "£x a month" hint when paying over several months.
(function () {
  document.addEventListener('DOMContentLoaded', () => {
    const sel = document.querySelector('[data-instalments]');
    const amount = document.getElementById('f-amount');
    const help = document.querySelector('[data-instalment-help]');
    if (!sel || !amount || !help) return;
    const base = help.textContent;
    const update = () => {
      const n = Number(sel.value) || 1;
      const pence = Math.round(Number(String(amount.value).replace(/[£,\s]/g, '')) * 100);
      if (n < 2 || !Number.isFinite(pence) || pence <= 0) { help.textContent = base; return; }
      const each = Math.floor(pence / n);
      help.textContent = `£${(each / 100).toFixed(2)} a month for ${n} months${pence - each * n ? ` (first month £${((each + pence - each * n) / 100).toFixed(2)})` : ''}.`;
    };
    sel.addEventListener('change', update);
    amount.addEventListener('input', update);
    update();
  });
})();

// Rent run step 5: "Fill in" copies the chosen preset into the boxes.
(function () {
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preset-fill]');
    if (!btn) return;
    const pick = document.querySelector('[data-preset-pick]');
    const opt = pick && pick.selectedOptions[0];
    if (!opt || !opt.dataset.preset) { if (pick) pick.focus(); return; }
    const data = JSON.parse(opt.dataset.preset);
    const form = document.getElementById('step5-form');
    for (const [k, v] of Object.entries(data)) {
      const el = form && form.elements[k];
      if (el && v) el.value = v;
    }
  });
})();

// Rent run step 5: the total in figures always reads like £5,000-00, and typing it fills in
// the total in words.
document.addEventListener('DOMContentLoaded', () => {
  const box = document.querySelector('[data-money-figures]');
  const wordsBox = box && document.querySelector(box.dataset.moneyFigures);
  if (!box || !wordsBox) return;
  const ONES = ['', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
  const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];
  const under1000 = (n) => {
    const parts = [];
    if (n >= 100) { parts.push(`${ONES[Math.floor(n / 100)]} hundred`); n %= 100; if (n) parts.push('and'); }
    if (n >= 20) parts.push(TENS[Math.floor(n / 10)] + (n % 10 ? `-${ONES[n % 10]}` : ''));
    else if (n) parts.push(ONES[n]);
    return parts.join(' ');
  };
  const whole = (n) => {
    if (n === 0) return 'zero';
    const parts = [];
    for (const [size, name] of [[1e9, 'billion'], [1e6, 'million'], [1e3, 'thousand']]) {
      if (n >= size) { parts.push(`${under1000(Math.floor(n / size))} ${name}`); n %= size; }
    }
    if (n) parts.push((parts.length && n < 100 ? 'and ' : '') + under1000(n));
    return parts.join(' ');
  };
  const inWords = (pence) => {
    const pounds = Math.floor(pence / 100);
    const p = pence % 100;
    let w = `${whole(pounds)} pound${pounds === 1 ? '' : 's'}`;
    w += p ? ` and ${whole(p)} ${p === 1 ? 'penny' : 'pence'}` : ' only';
    return w.toUpperCase();
  };
  // "5000", "£5,000.5", "5000-50" → pence; anything else → null.
  const toPence = (v) => {
    const m = String(v).replace(/[£,\s]/g, '').match(/^(\d+)(?:[.\-](\d{0,2}))?$/);
    if (!m) return null;
    return Number(m[1]) * 100 + Number((m[2] || '').padEnd(2, '0'));
  };
  const figures = (pence) => `£${Math.floor(pence / 100).toLocaleString('en-GB')}-${String(pence % 100).padStart(2, '0')}`;
  box.addEventListener('input', () => {
    // Always starts with £ …
    const raw = box.value.replace(/£/g, '');
    if (raw && box.value !== `£${raw}`) box.value = `£${raw}`;
    // … and the words follow what's typed.
    const pence = toPence(box.value);
    wordsBox.value = pence === null || !raw ? '' : inWords(pence);
  });
  // Tidied up when you leave the box: commas and a dash before the pence.
  box.addEventListener('change', () => {
    const pence = toPence(box.value);
    if (pence !== null) box.value = figures(pence);
  });
});
