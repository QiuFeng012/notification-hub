/**
 * 卡片日程与荧光笔标记的**类型定义**。
 *
 * 注意：这里刻意只放类型。共享包以 .ts 源码形式被引用，
 * 编译后的服务端不会为 `export * from './calendar.js'` 找到真实的 .js 文件，
 * 所以任何运行时值（常量、函数）都必须放在 index.ts 里，
 * 只有纯类型可以放在这个文件并靠 `export type` 被擦除。
 */

/** 卡片在日历上占据的日期范围 */
export interface CardSchedule {
  /** 起始日期（含），本地日期 YYYY-MM-DD */
  start: string;
  /** 结束日期（含）；单日卡片与 start 相同 */
  end: string;
  /** 覆盖天数，等于 end - start + 1 */
  dayCount: number;
  /** 解析所依据的原文本，界面用它解释"为什么排在这天" */
  label: string;
  /**
   * 是否含年份推测。文本里没写年份时按卡片创建时间推断，
   * 跨年场景可能偏一年，界面会如实提示而不是假装精确。
   */
  inferredYear: boolean;
}

/**
 * 日历上的荧光笔颜色配置。
 * 只存"用户显式改过的"部分，其余由前端按卡片 id 稳定派生默认色，
 * 所以不必把颜色写死在每条数据里。
 */
export interface HighlightStyle {
  /** 单日卡片的默认颜色 */
  singleDay: string;
  /** 多日卡片的调色板，按卡片 id 稳定分配，保证相邻卡片颜色不同 */
  multiDayPalette: string[];
  /** 针对某张卡片的单独指定，优先级最高：cardId -> 颜色 */
  perCard: Record<string, string>;
}
