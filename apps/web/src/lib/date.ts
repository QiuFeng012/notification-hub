/**
 * 前端的本地日期工具。
 *
 * 刻意不用 `toISOString().slice(0, 10)`：那会按 UTC 换算，
 * 在东八区的晚上会把日期挪到第二天，日历就会排错格。
 */

/** Date → 本地日期 YYYY-MM-DD */
export function toIsoDate(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
