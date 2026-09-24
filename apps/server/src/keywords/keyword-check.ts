import { textMentionsKeyword, type CardKeywords } from '@notification-hub/shared';
import { MAX_KEY_POINT_LENGTH } from '../ai/types.js';

/** 兜底要点的前缀，让人一眼看出这条是系统补的，而不是模型总结的 */
const FALLBACK_PREFIX = '（关注点）';

/** 按标点把原文切成分句，用来给兜底要点找证据句 */
const CLAUSE_SPLIT = /[。！？!?；;\n]+/;

function splitClauses(rawText: string): string[] {
  return rawText
    .split(CLAUSE_SPLIT)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

/** 要点是否覆盖了某个关键词 */
function pointsCoverKeyword(keyPoints: string[], keyword: string): boolean {
  return keyPoints.some((point) => textMentionsKeyword(point, keyword));
}
export interface KeywordCheckResult {
  keyPoints: string[];
  keywords: CardKeywords;
  /** 是否补入过兜底要点 */
  supplemented: boolean;
}

/**
 * 关键词校验与兜底。
 *
 * 这是"关键词"这个功能真正的价值所在：模型有可能把用户明确关心的信息漏掉，
 * 而通用规则无法判断什么对用户重要。有了关键词，我们得到一个可断言的锚点——
 * 原文提到了它，要点里就必须有它的影子，否则由代码补一条。
 *
 * 补入的不是"你漏了 X"这种空话，而是原文里提到 X 的那个句子，
 * 这样用户至少能看到事实，而不是一句提示。
 *
 * @param rawText   通知原文
 * @param keyPoints 模型产出的要点
 * @param priority  用户本次填写的关注点
 */
export function enforceKeywords(
  rawText: string,
  keyPoints: string[],
  priority: string[],
): KeywordCheckResult {
  if (priority.length === 0) {
    return { keyPoints, keywords: { priority: [], hit: [], missed: [] }, supplemented: false };
  }

  const hit: string[] = [];
  const missed: string[] = [];
  const supplementedPoints: string[] = [];
  let supplemented = false;
  let working = [...keyPoints];

  for (const keyword of priority) {
    const mentionedInRaw = textMentionsKeyword(rawText, keyword);

    if (pointsCoverKeyword(working, keyword)) {
      hit.push(keyword);
      continue;
    }

    // 原文根本没提这个词：不算遗漏，只是这次没命中，不该补垃圾进去
    if (!mentionedInRaw) continue;

    missed.push(keyword);
    supplemented = true;

    const evidence = splitClauses(rawText).find((clause) => textMentionsKeyword(clause, keyword));
    const sentence = (evidence ?? keyword).slice(0, MAX_KEY_POINT_LENGTH - FALLBACK_PREFIX.length);
    supplementedPoints.push(`${FALLBACK_PREFIX}${sentence}`);
  }

  if (supplementedPoints.length > 0) {
    // 兜底要点放在最前：用户明确关心的东西不该排在最后
    working = [...supplementedPoints, ...working];
  }

  return {
    keyPoints: working,
    keywords: { priority, hit, missed },
    supplemented,
  };
}
