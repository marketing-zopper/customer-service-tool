import { useEffect, useRef } from 'react';
import { Search, X } from 'lucide-react';

/**
 * Sleek, translucent search field. Press "/" anywhere to jump into it, Esc to clear it.
 * Fully controlled: the dashboard owns the text and does the searching.
 */
export default function SearchBox({ value, onChange, placeholder, label = placeholder }) {
  const inputRef = useRef(null);

  useEffect(() => {
    const onKey = (event) => {
      const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName) || document.activeElement?.isContentEditable;
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="search" role="search">
      <Search size={17} className="search-icon" aria-hidden="true" />
      <input
        ref={inputRef}
        type="search"
        className="search-input"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && value) {
            event.preventDefault();
            onChange('');
          }
        }}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="off"
        spellCheck="false"
        maxLength={100}
      />
      {value ? (
        <button type="button" className="search-clear" onClick={() => { onChange(''); inputRef.current?.focus(); }} aria-label="Clear search">
          <X size={15} />
        </button>
      ) : (
        <kbd className="search-key" aria-hidden="true">/</kbd>
      )}
    </div>
  );
}
