import { truncate } from './parse.js';
import { MAX_KEY_POINTS, MAX_KEY_POINT_LENGTH, MAX_TITLE_LENGTH, type CardDraft, type Summarizer } from './types.js';

/** 【来源】/ [来源] / 〔来源〕 / （来源） 形式的抬头 */
const BRACKET_PREFIX = /^\s*[【\[〔（(]\s*([^】\]〕）)]{1,24})\s*[】\]〕）)]/;
/** "来源：xxx" / "来自 xxx" / "From: xxx" */
const SOURCE_LABEL = /(?:来源|来自|发送方|发布方|from)\s*[:：]?\s*([^\n，,。；;]{1,32})/i;

/** 单个日期 */
const DATE_ONLY = String.raw`(?:\d{4}\s*[-/年.]\s*\d{1,2}\s*[-/月.]\s*\d{1,2}\s*日?|\d{1,2}\s*月\s*\d{1,2}\s*日)`;
/** 时刻：14:00 / 14：00 / 14:00pm；前置断言排除 "24:00前" 这类带"前"的写法被误当时刻 */
const TIME_OF_DAY = String.raw`(?<![前之])\d{1,2}\s*[:：]\s*\d{2}\s*(?:am|pm)?`;
/** 日期（可带时刻），或独立的时刻 */
const DATE_WITH_TIME = new RegExp(
  String.raw`(?:${DATE_ONLY})(?:\s*(?:${TIME_OF_DAY}))?|(?:${TIME_OF_DAY})`,
  'i',
);

/** 兜底：相对时间表达 */
const RELATIVE_TIME = /(?:今天|明天|后天|本周|这周|下周|周[一二三四五六日天]|星期[一二三四五六日天])[^\n，,。；;]{0,12}/;

/** 带这些词的行更可能是"需要你行动"的关键信息 */
const SIGNAL_WORDS = [
  '截止', '报名', '缴费', '付款', '领取', '提交', '确认', '回复',
  '会议', '时间', '地点', '地址', '链接', '入口', '注意', '提醒', '请', '需',
  '必须', '重要', '变更', '取消', '延期', '面试', '考试', '答辩', '值班',
  'deadline', 'due', 'required', 'important', 'meeting',
];

/**
 * 截止语义：出现这些词说明附近的时间才是"你真正要记住的时间"。
 *
 * 单独一个 '前' 太宽泛（"3月5日前台签到"、"前提条件" 都会误判），
 * 因此要求 '前' 之后若干字符内出现动作词才算截止，并排除"前台/前提/前往"等常见复合词。
 */
const DEADLINE_CUE =
  /截止|逾期|最后期限|之前|以前|前(?!台|方|后|面|提|往|来|辈|景|途|进|期)[^，,。；;\n]{0,8}?(?:完成|提交|报名|确认|回复|缴纳|结束|办理|上传|填报|到达|交齐|前)|deadline|due\b|before\b/i;

/** 纯礼貌用语、没有信息量的行，不应进入要点 */
const NOISE_PATTERN = /^(收到|好的|谢谢|感谢|辛苦了|收到谢谢|ok|okay|thanks?|thank\s*you|以上|完毕|。|！|!|~)+$/i;

/** 联系方式行：属于补充信息，优先度低于通知主体，但不至于完全丢弃 */
const CONTACT_PATTERN = /(联系人|联系电话|电话|微信|邮箱|咨询)/;

const PUNCTUATION_ONLY = /^[\s\p{P}\p{S}]+$/u;

/** 句末标点：长行按句子切开，标题才能是一句而不是一整段 */
const SENTENCE_SPLIT = /(?<=[。！？!?；;])/;
/** 分句标点：用于定位"截止"这类局部语义 */
const CLAUSE_SPLIT = /[，,。；;、\n]/;

function splitSentences(rawText: string): string[] {
  const units: string[] = [];
  for (const rawLine of rawText.split(/\r?\n/)) {
    const line = rawLine.replace(/^[\s\-*•·>]+/, '').trim();
    if (line.length === 0) continue;
    for (const piece of line.split(SENTENCE_SPLIT)) {
      const sentence = piece.trim();
      if (sentence.length > 0) units.push(sentence);
    }
  }
  return units;
}

/** 按逗号句号等切成分句，用于定位局部语义（如"截止"只出现在某个分句里） */
function splitClauses(text: string): string[] {
  return text
    .split(CLAUSE_SPLIT)
    .map((clause) => clause.trim())
    .filter((clause) => clause.length > 0);
}

function isSubstantive(unit: string): boolean {  if (unit.length < 4) return false;
  if (PUNCTUATION_ONLY.test(unit)) return false;
  if (NOISE_PATTERN.test(unit)) return false;
  return true;
}

function scoreUnit(unit: string, index: number): number {
  const lower = unit.toLowerCase();
  let score = 0;
  for (const word of SIGNAL_WORDS) {
    if (lower.includes(word.toLowerCase())) score += 2;
  }
  if (DATE_WITH_TIME.test(unit)) score += 2;
  if (/\d/.test(unit)) score += 1;
  if (unit.length >= 12 && unit.length <= 80) score += 1;
  if (CONTACT_PATTERN.test(unit)) score -= 2;
  // 靠前的句子通常是通知主体，给一点点先手优势
  score += Math.max(0, 3 - index) * 0.5;
  return score;
}

function extractSource(text: string): string | null {
  const bracket = BRACKET_PREFIX.exec(text);
  if (bracket?.[1]) return truncate(bracket[1], 64);
  const labeled = SOURCE_LABEL.exec(text);
  if (labeled?.[1]) {
    const candidate = truncate(labeled[1], 64);
    if (candidate.length > 0) return candidate;
  }
  return null;
}

/**
 * 提取时间时优先取"截止/逾期"附近的时间，而不是通知里最先出现的那个时间。
 * 例：「3月5日14:00开放，请于3月8日24:00前完成」应取 3月8日24:00前，而不是 3月5日14:00。
 */
function extractTime(text: string): string | null {
  // 先切小句：截止语义往往只出现在逗号分隔的某一个分句里
  // （如「3月5日14:00开放，请于3月8日24:00前完成」，整句里第一个日期并不是截止时间）
  for (const clause of splitClauses(text)) {
    if (!DEADLINE_CUE.test(clause)) continue;

    const match = DATE_WITH_TIME.exec(clause);
    if (!match?.[0]) continue;
    // 匹配到的是截止分句里的时间：若原句紧跟着"前/之前"，补回来让语义完整
    const tail = clause.slice((match.index ?? 0) + match[0].length).trimStart();
    const suffix = /^(前|之前|以前)/.exec(tail)?.[1] ?? '';
    return truncate(`${match[0]}${suffix}`, 64);
  }

  const dateMatch = DATE_WITH_TIME.exec(text);
  if (dateMatch?.[0]) return truncate(dateMatch[0], 64);

  const relative = RELATIVE_TIME.exec(text);
  if (relative?.[0]) return truncate(relative[0], 64);

  return null;
}

/**
 * 去掉抬头、首尾装饰符号与收尾标点，得到干净的标题文本。
 *
 * 通知类文本常见 ❗️/🔥/📢 等装饰、Markdown 强调符与成对引号包裹，
 * 它们不是信息，出现在标题里会显得很脏。成对引号只在两端同时出现时才剥掉，
 * 避免破坏正文里本来就有的引号。
 */
const LEADING_DECORATION = /^[\s：:，,、。；;!?！？~～*#>=\-—·•"'“”‘’…\u2600-\u27BF\uFE0F\u2B00-\u2BFF\u{1F000}-\u{1FAFF}]+/u;
const TRAILING_DECORATION = /[\s：:，,、。；;!?！？~～*#>=\-—·•"'“”‘’…\u2600-\u27BF\uFE0F\u2B00-\u2BFF\u{1F000}-\u{1FAFF}]+$/u;
/** 行内 Markdown 强调与代码标记 */
const INLINE_EMPHASIS = /(\*\*|__|`|~~|\*|_)/g;

function cleanTitle(unit: string): string {
  return unit
    .replace(BRACKET_PREFIX, '')
    .replace(INLINE_EMPHASIS, '')
    .replace(LEADING_DECORATION, '')
    .replace(TRAILING_DECORATION, '');
}

/**
 * 无 API Key 时使用的本地摘要器。
 *
 * 它不做真正的语义理解，只用"关键词 + 日期 + 句位置"这类启发式规则挑句子，
 * 目的有两个：让没有 Key 的人也能把整条链路跑通；让每次产出的结构稳定可测。
 * 产出会被标记 provider='mock'，前端显式提示"这是启发式摘要，非 AI 生成"。
 */
/** 单个关注点的提权幅度：必须显著高于通用信号词的分值，
 *  否则用户明确指定的关注点会被"截止/请"这类通用规则盖过去，功能就白做了。 */
const KEYWORD_BOOST = 20;

export function createMockSummarizer(): Summarizer {
  return {
    summarize(input) {
      const { rawText, keywords } = input;
      const units = splitSentences(rawText);
      const searchable = rawText.slice(0, 2000);

      const candidates = units.filter(isSubstantive);
      // 清洗要在挑选之前完成：纯装饰行（"❗️❗️❗️"）清洗后为空，不应被选中当标题
      const cleaned = candidates
        .map((unit, index) => ({ text: cleanTitle(unit), score: scoreUnit(unit, index) }))
        .filter((item) => item.text.length > 0);

      // 本次关注点直接参与打分：本地摘要器没有语义理解能力，
      // 让它"看见"用户在意什么，是最实际的加权方式。
      if (keywords.length > 0) {
        for (const item of cleaned) {
          const matched = keywords.filter((keyword) => item.text.includes(keyword)).length;
          item.score += matched * KEYWORD_BOOST;
        }
      }

      const title = truncate(cleaned[0]?.text ?? '', MAX_TITLE_LENGTH);

      const keyPoints =
        cleaned.length === 0
          ? ['未从原文中识别出有效要点，请确认粘贴的是通知正文，或配置 DEEPSEEK_API_KEY 使用 AI 总结']
          : cleaned
              .slice()
              .sort((a, b) => b.score - a.score)
              .slice(0, MAX_KEY_POINTS)
              .map((item) => truncate(item.text, MAX_KEY_POINT_LENGTH));

      const draft: CardDraft = {
        title: title || '未识别标题的通知',
        time: extractTime(searchable),
        source: extractSource(searchable),
        keyPoints,
      };

      return Promise.resolve({ draft, provider: 'mock' as const });
    },
  };
}
