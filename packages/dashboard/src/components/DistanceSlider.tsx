"use client";

import {
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";

import { formatDistance } from "../lib/format";

export const DEFAULT_MAX_DISTANCE = 1.0;
export const DISTANCE_STEP = 0.01;
export const DISTANCE_DEBOUNCE_MS = 300;

export interface DistanceSliderProps {
  onChange: (maxDistance: number) => void;
  defaultValue?: number;
  disabled?: boolean;
  debounceMs?: number;
  label?: string;
}

export function DistanceSlider({
  onChange,
  defaultValue = DEFAULT_MAX_DISTANCE,
  disabled = false,
  debounceMs = DISTANCE_DEBOUNCE_MS,
  label = "Max distance",
}: DistanceSliderProps) {
  const [value, setValue] = useState<number>(defaultValue);

  const onChangeRef = useRef(onChange);
  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  const isFirstRender = useRef(true);

  useEffect(() => {
    if (isFirstRender.current) {
      isFirstRender.current = false;
      return;
    }
    const handle = setTimeout(() => {
      onChangeRef.current(value);
    }, debounceMs);
    return () => {
      clearTimeout(handle);
    };
  }, [value, debounceMs]);

  const handleChange = (event: ChangeEvent<HTMLInputElement>) => {
    setValue(Number(event.currentTarget.value));
  };

  // Compute fill percentage for track visualization
  const fillPct = Math.round(value * 100);

  return (
    <div className="flex w-full items-center gap-4">
      <span className="flex-shrink-0 text-xs font-medium text-muted">{label}</span>
      <div className="relative flex flex-1 items-center">
        <input
          type="range"
          min={0}
          max={1}
          step={DISTANCE_STEP}
          value={value}
          onChange={handleChange}
          disabled={disabled}
          aria-label={label}
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={value}
          style={{
            background: `linear-gradient(to right, #111111 0%, #111111 ${fillPct}%, #EAEAEA ${fillPct}%, #EAEAEA 100%)`,
          }}
          className={[
            "h-1 w-full cursor-pointer appearance-none rounded-full",
            "transition-opacity duration-150",
            "[&::-webkit-slider-thumb]:h-3.5 [&::-webkit-slider-thumb]:w-3.5",
            "[&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full",
            "[&::-webkit-slider-thumb]:bg-ink",
            "[&::-webkit-slider-thumb]:transition-transform [&::-webkit-slider-thumb]:duration-100",
            "[&::-webkit-slider-thumb]:hover:scale-110",
            "[&::-moz-range-thumb]:h-3.5 [&::-moz-range-thumb]:w-3.5",
            "[&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-0",
            "[&::-moz-range-thumb]:bg-ink",
            disabled ? "cursor-not-allowed opacity-40" : "",
          ].join(" ")}
        />
      </div>
      <span
        aria-live="polite"
        className="w-10 flex-shrink-0 text-right font-mono text-xs tabular-nums text-muted"
      >
        {formatDistance(value)}
      </span>
    </div>
  );
}

export default DistanceSlider;
