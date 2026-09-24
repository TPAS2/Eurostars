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
