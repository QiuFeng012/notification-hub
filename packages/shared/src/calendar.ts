/**
 * 卡片日程与荧光笔标记的**类型定义**。
 *
 * 注意：这里刻意只放类型。共享包以 .ts 源码形式被引用，
 * 编译后的服务端不会为 `export * from './calendar.js'` 找到真实的 .js 文件，
 * 所以任何运行时值（常量、函数）都必须放在 index.ts 里，
 * 只有纯类型可以放在这个文件并靠 `export type` 被擦除。
 */

/**
 * 一条日程在通知里扮演的角色。
 *
 * 起因：很多通知同时给两个时间——"9月23日12:30开始报名"与"9月24日15:00活动举行"。
 * 它们不是一段时间的两端（不是"从几号到几号"），而是两件不同的事。
 * 合并成一个区间就把日历画错了：报名截止那天与活动那天被涂成连续的一片。
 */
export type ScheduleRole =
  /** 报名 / 提交 / 截止：需要在某个时间点之前完成的事 */
  | 'deadline'
  /** 活动 / 开放 / 举行：什么时候真正发生 */
  | 'activity'
  /** 体检、检查、考试这类到场安排 */
  | 'visit'
  /** 没有明显归属的（绝大多数通知都是这一类） */
  | 'primary';

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
  /**
   * 这条日程扮演的角色。界面用它给同一张卡的不同日程加标签
   * （「报名截止」「活动」），否则两条颜色相同的条摆在一起分不清谁是谁。
   */
  role?: ScheduleRole;
}

/** 修改原因：用来区分"官方改了口径"和"我自己记错了" */
export type RevisionReason = 'official' | 'manual' | 'other';

/**
 * 一次改动的快照。
 *
 * 存的是"改动前"的内容，所以把它的原因读出来就是：
 * "因为 X，把 Y 改成了现在这样"。
 */
export interface CardRevision {
  /** 自增序号 */
  id: number;
  cardId: string;
  /** 改动原因 */
  reason: RevisionReason;
  /** 可选补充说明 */
  note: string | null;
  /** 改动前的标题 */
  previousTitle: string;
  previousTime: string | null;
  previousSource: string | null;
  previousKeyPoints: string[];
  /** 改动时间，ISO 8601 */
  createdAt: string;
}

/** GET /api/cards/:id/revisions 的响应 */
export interface CardRevisionListResponse {
  revisions: CardRevision[];
}

/** PATCH /api/cards/:id 的请求体：只传要改的字段 */
export interface UpdateCardRequest {
  title?: string;
  /** null 表示清空时间 */
  time?: string | null;
  source?: string | null;
  keyPoints?: string[];
  /**
   * 官方修改后的原文。
   *
   * 必须能被更新：排期是从**原文**解析出来的，只换时间而不换原文时，
   * 新通知里那些日期（「检查时间改为 10 月 29 日」）永远进不了日历，
   * 而卡片的「时间」已经变了——两边对不上，表现就是"事件没显示"。
   */
  rawText?: string;
  /** 修改原因，必填——否则日后无法解释这条为什么和原文不一致 */
  reason: RevisionReason;
  note?: string;
}

/**
 * 卡片列表的排序方式。
 *
 * 刻意不做"自动评估紧急度"：紧急度是时间的函数（今天到期 vs 三天后到期），
 * 不是文本的属性，模型打出的静态标签过几天必然过时。
 * 按事件时间排序 + 置顶是确定性的，同样能解决"先看哪条"的问题。
 */
export type CardSortMode =
  /** 按事件时间升序（最近的排在最前），没有日期的沉底 */
  | 'event'
  /** 按录入时间倒序（最新录入的在最前） */
  | 'created';

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
