'use strict';

const gbp = new Intl.NumberFormat('en-GB', { style: 'currency', currency: 'GBP' });

function money(pence) {
  if (pence === null || pence === undefined || pence === '') return '';
  return gbp.format(Number(pence) / 100);
}

// "1,234.5" / "£1234.50" -> 123450. Returns NaN for anything that isn't a valid amount.
function parseMoney(input) {
  const s = String(input).replace(/[£,\s]/g, '');
  if (!/^\d+(\.\d{1,2})?$/.test(s)) return NaN;
  const [whole, frac = ''] = s.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

function penceToInput(pence) {
  if (pence === null || pence === undefined) return '';
  return (Number(pence) / 100).toFixed(2);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

function addDays(isoDate, days) {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function isIsoDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

function ukDate(iso) {
  if (!iso) return '';
  const s = String(iso).slice(0, 10);
  if (!isIsoDate(s)) return String(iso);
  const [y, m, d] = s.split('-');
  return `${d}/${m}/${y}`;
}

function ukDateTime(sqliteDateTime) {
  if (!sqliteDateTime) return 'Never';
  return `${ukDate(sqliteDateTime)} ${String(sqliteDateTime).slice(11, 16)}`;
}

function humanize(value) {
  return String(value ?? '').replace(/_/g, ' ');
}

module.exports = { money, parseMoney, penceToInput, today, addDays, isIsoDate, ukDate, ukDateTime, humanize };
