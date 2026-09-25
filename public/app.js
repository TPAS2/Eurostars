'use strict';

document.addEventListener('DOMContentLoaded', () => {
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
      const input = form.querySelector(`[name="${CSS.escape(name)}"]`);
      const field = input && input.closest('.field');
      if (!field) continue;
      const div = document.createElement('div');
      div.className = 'field-err live';
      div.textContent = msg;
      field.appendChild(div);
    }
  }

  function setupAutosave(form) {
    let timer = null;
    let inFlight = null;
    let dirty = false;

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
          clearFieldErrors(form);
          setStatus(form, `All changes saved · ${new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`, 'ok');
        } else if (res.status === 422) {
          const data = await res.json().catch(() => ({ errors: {} }));
          showFieldErrors(form, data.errors || {});
          setStatus(form, 'Not saved: fix the highlighted field', 'err');
        } else if (res.status === 403 || res.redirected) {
          setStatus(form, 'Not saved: your session expired. Refresh the page and sign in.', 'err');
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
      setStatus(form, 'Unsaved changes…', 'busy');
      clearTimeout(timer);
      timer = setTimeout(save, DEBOUNCE_MS);
    };
    form.addEventListener('input', schedule);
    form.addEventListener('change', schedule);
    form.addEventListener('submit', (e) => { e.preventDefault(); clearTimeout(timer); dirty = true; save(); });

    // Flush on leaving the page; warn if a save is still pending.
    window.addEventListener('beforeunload', (e) => {
      if (!dirty && !inFlight) return;
      clearTimeout(timer);
      // sendBeacon survives the page closing; only warn if the browser can't send it.
      const sent = navigator.sendBeacon && navigator.sendBeacon(form.action, formBody(form));
      if (!sent) { e.preventDefault(); e.returnValue = ''; }
    });
    setStatus(form, 'Changes save automatically', '');
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
  }

  document.addEventListener('DOMContentLoaded', () => {
    // A picture is uploaded as soon as one is chosen.
    document.querySelectorAll('input[type=file][data-autosubmit]').forEach((input) => {
      input.addEventListener('change', () => { if (input.files.length) input.form.submit(); });
    });
    document.querySelectorAll('form[data-autosave]').forEach(setupAutosave);
    document.querySelectorAll('form[data-draft]').forEach(setupDraft);
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
