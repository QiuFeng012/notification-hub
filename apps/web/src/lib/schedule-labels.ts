import type { ScheduleRole } from '@notification-hub/shared';

/** 日程角色的中文标签；日历与时间轴共用，避免两处写法漂移 */
export const SCHEDULE_ROLE_LABELS: Record<ScheduleRole, string> = {
  deadline: '截止',
  activity: '活动',
  visit: '到场',
  primary: '主要',
};
