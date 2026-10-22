import { STATUS_LABELS } from '../sections.js';

// A soft, tinted pill that is also the dropdown: the colour tells you the status at a glance.
export default function StatusSelect({ value, options, onChange, disabled }) {
  return (
    <label className={`status-select status-select--${value}`}>
      <span className="sr-only">Status</span>
      <select value={value} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {options.map((status) => (
          <option key={status} value={status}>
            {STATUS_LABELS[status]}
          </option>
        ))}
      </select>
    </label>
  );
}
