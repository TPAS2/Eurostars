// Turns a form's <select data-segment> into a RubberSegment (React Bits) sliding control. The
// select stays in the form (hidden), so saving, autosave, drafts and the server's checks all work
// exactly as before; the control just sets its value. Nothing is chosen until the person picks.
import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import RubberSegment from './RubberSegment';

function SegmentField({ select, label }) {
  const options = [...select.options].filter((o) => o.value !== '').map((o) => ({ value: o.value, label: o.textContent.trim() }));
  const [value, setValue] = useState(select.value);
  useEffect(() => {
    const sync = () => setValue(select.value);
    select.addEventListener('change', sync);
    return () => select.removeEventListener('change', sync);
  }, [select]);
  const choose = (next) => {
    setValue(next);
    if (select.value === next) return;
    select.value = next;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
  };
  // With nothing chosen yet the slider shows no thumb; a tap on any choice (the first included) picks it.
  const pickWhenEmpty = (e) => {
    if (value) return;
    const btn = e.target.closest('button.rubber-segment__item');
    if (!btn) return;
    const i = [...btn.parentElement.querySelectorAll(':scope > button.rubber-segment__item')].indexOf(btn);
    if (i >= 0) choose(options[i].value);
  };
  return (
    <div className={`rs-field${value ? '' : ' rs-empty'}`} onClickCapture={pickWhenEmpty}>
      <RubberSegment
        items={options}
        value={value || options[0].value}
        onChange={(next) => choose(next)}
        trackColor="var(--surface-2)"
        thumbColor="var(--brand)"
        textColor="var(--text)"
        activeTextColor="var(--brand-ink)"
        size="md"
        radius={10}
        inset={3}
        equalSlots
        stretch={100}
        squash={3}
        speed={1}
        glide={75}
        draggable
        aria-label={label}
      />
    </div>
  );
}

function mountAll() {
  document.querySelectorAll('select[data-segment]').forEach((select) => {
    const field = select.closest('.field');
    const label = field ? (field.querySelector('label')?.textContent || '').replace('*', '').trim() : '';
    const host = document.createElement('div');
    select.insertAdjacentElement('afterend', host);
    select.classList.add('rs-native');
    select.tabIndex = -1;
    createRoot(host).render(<SegmentField select={select} label={label} />);
  });
}

// After app.js has put back any unsent draft, so the controls start from the right choice.
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
else mountAll();
