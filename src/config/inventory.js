/**
 * Inventory analytics constants. They live in one place so that ABC, XYZ, ROP
 * and KPI calculations cannot drift apart between services and reports.
 * Monetary values stay strings: they are fed into decimal.js, never into Number.
 */
export const ORDER_COST_BYN = '50';
export const HOLDING_RATE = '0.20';
export const SERVICE_LEVEL_Z = 1.645;
export const DEMAND_WINDOW_DAYS = 90;
export const XYZ_MONTHS = 6;
export const DEAD_STOCK_DAYS = 90;
export const ACTIVITY_WINDOW_DAYS = 180;
export const ABC_A = 0.8;
export const ABC_B = 0.95;
export const XYZ_X = 0.1;
export const XYZ_Y = 0.25;
export const MIN_HISTORY_DAYS = 14;
