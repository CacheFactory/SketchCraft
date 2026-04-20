// @archigraph core-units
// Unit conversion utilities. Internal unit is meters.

import type { LengthUnit } from './types';

/** Conversion factors: how many internal units (meters) per 1 display unit. */
const TO_METERS: Record<LengthUnit, number> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  inches: 0.0254,
  feet: 0.3048,
};

/** Convert from display units to internal (meters). */
export function toInternal(value: number, unit: LengthUnit): number {
  return value * TO_METERS[unit];
}

/** Convert from internal (meters) to display units. */
export function toDisplay(value: number, unit: LengthUnit): number {
  return value / TO_METERS[unit];
}

/** Format an internal value for display with unit label. At most 1 decimal place. */
export function formatDistance(internalValue: number, unit: LengthUnit): string {
  const display = toDisplay(internalValue, unit);
  // Show whole number if close enough, otherwise 1 decimal place
  const rounded = Math.round(display * 10) / 10;
  const text = rounded === Math.floor(rounded) ? rounded.toFixed(0) : rounded.toFixed(1);
  return `${text}${unitLabel(unit)}`;
}

/** Unit abbreviation for display. */
export function unitLabel(unit: LengthUnit): string {
  switch (unit) {
    case 'mm': return 'mm';
    case 'cm': return 'cm';
    case 'm': return 'm';
    case 'inches': return '"';
    case 'feet': return "'";
  }
}

/** Singleton current unit state, updated from preferences. */
let _currentUnit: LengthUnit = 'm';

export function setCurrentUnit(unit: LengthUnit): void {
  _currentUnit = unit;
}

export function getCurrentUnit(): LengthUnit {
  return _currentUnit;
}
