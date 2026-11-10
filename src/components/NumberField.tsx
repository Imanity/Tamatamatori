import { useEffect, useId, useState } from "react";
import type { ClipboardEvent } from "react";

/**
 * Numeric input that keeps the typed draft while it is out of range and only
 * reports valid values, so an error never silently replaces the plan.
 */
export function NumberField({
  label,
  value,
  min,
  max,
  step = 1,
  unit,
  title,
  className = "",
  onChange,
  onPaste,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  unit?: string;
  title?: string;
  className?: string;
  onChange: (value: number) => void;
  onPaste?: (event: ClipboardEvent<HTMLInputElement>) => void;
}) {
  const id = useId();
  const [draft, setDraft] = useState(String(value));
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(String(value));
    setError("");
  }, [value]);
  return (
    <label className={`field ${className}`} htmlFor={id} title={title}>
      <span className="field-label">{label}</span>
      <span className={`number-wrap ${error ? "has-error" : ""}`}>
        <input
          id={id}
          type="number"
          value={draft}
          min={min}
          max={max}
          step={step}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
          onPaste={onPaste}
          onChange={(event) => {
            const text = event.target.value;
            setDraft(text);
            const number = Number(text);
            if (
              text.trim() === "" ||
              !Number.isFinite(number) ||
              number < min ||
              number > max
            ) {
              setError(`请输入 ${min} 至 ${max}${unit ? ` ${unit}` : ""}`);
            } else {
              setError("");
              onChange(number);
            }
          }}
        />
        {unit && <span className="input-unit">{unit}</span>}
      </span>
      {error && (
        <span className="field-error" id={`${id}-error`}>
          {error}
        </span>
      )}
    </label>
  );
}
