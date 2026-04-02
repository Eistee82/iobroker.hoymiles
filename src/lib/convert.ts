/**
 * Convert Wh string (from Cloud API) to kWh number, rounded to 2 decimals.
 *
 * @param wh - Watt-hours value as string
 */
export const toKwh = (wh: string): number => Math.round((parseFloat(wh) || 0) / 10) / 100;

/**
 * Round a number to 1 decimal place.
 *
 * @param v - Number to round
 */
export const round1 = (v: number): number => Math.round(v * 10) / 10;

/**
 * Convert Wh (number) to kWh, rounded to 3 decimal places.
 *
 * @param wh - Energy in watt-hours
 */
export const whToKwh = (wh: number): number => Math.round(wh) / 1000;
