import { parseSummaryResponse } from './parse.js';
import { InvalidApiKeyError, SummaryError, type Summarizer } from './types.js';

/** 交给模型的系统提示：只允许输出 JSON，字段语义写死，避免每次输出结构漂移 */
export const SYSTEM_PROMPT = `你是一个通知信息提炼助手，服务于个人使用的信息整合工具。

用户会把一条通知、消息或邮件的原文粘贴给你。你的唯一任务是提取要点，输出一个 JSON 对象。

严格遵循以下规则：
1. 只输出 JSON，不要输出任何解释、前后缀或 Markdown 代码块。
2. JSON 结构固定为：
   {"title": string, "time": string | null, "source": string | null, "key_points": string[]}
3. title：一句话概括这条通知的主题，不超过 30 字，不要照抄整段原文。
4. time：通知中明确出现的时间或截止时间，原样保留原文表述（如 "3月5日 14:00"、"2025-03-05"）；原文没写就填 null，禁止猜测或推算。
5. source：通知的来源方，如某个群、平台、机构、公司、部门；原文没写就填 null。
6. key_points：3 到 5 条要点，每条一句话，不超过 50 字。按重要性从高到低排列。
   - 必须覆盖：要做什么、什么时间、在哪儿做、有没有截止时间、需要带什么或回复什么。
   - 合并重复信息，删除寒暄、客套、签名、免责声明等无信息量的内容。
   - 保留原文中的具体数字、金额、链接、地点、人名，不要改写成模糊表述。
7. 所有字段值使用与原文一致的语言（原文是中文就用中文）。
8. 如果原文几乎没有有效信息（例如只有一句问候），key_points 填入一条说明，内容为"原文未包含可提炼的有效信息"。

示例输入：
【教务处】各位同学：本学期选课将于3月5日14:00开放，请于3月8日24:00前在教务系统完成选课，逾期系统自动关闭。联系人：王老师 电话 12345678。

示例输出：
{"title":"本学期选课开放通知","time":"3月8日24:00前","source":"教务处","key_points":["3月5日14:00开放选课","需在3月8日24:00前完成选课","在教务系统内操作，逾期自动关闭","有问题联系王老师 12345678"]}`;

export interface DeepSeekSummarizerOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  timeoutMs?: number;
  /** 可注入，便于测试时拦截请求而不真的联网 */
  fetchImpl?: typeof fetch;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string | null } }>;
}

/**
 * 一次最小化的 API 调用，用来确认用户填的 Key 能不能用。
 * 只发一个单字消息，花费可以忽略。
 */
const VALIDATION_USER_MESSAGE = '在吗';

/**
 * 用户当次关注点。附在 user 消息而不是 system 提示里：
 * system 部分保持不变，才能吃到 DeepSeek 的上下文缓存。
 */
export function buildKeywordSection(keywords: string[]): string {
  if (keywords.length === 0) return '';
  return [
    '',
    '---',
    `用户本次特别关注以下内容：${keywords.join('、')}`,
    '请在 key_points 中优先覆盖与这些关注点相关的信息。',
    '原文明确提到某个关注点时，至少有一条要点必须覆盖它；不要因为你觉得次要就省略。',
    '原文没有提到的关注点无需提及，也不要为了凑数而推测或编造。',
    '',
    '通知原文：',
  ].join('\n');
}

/**
 * 真实 AI 摘要器：调用 DeepSeek 的 OpenAI 兼容接口。
 *
 * 开启 response_format=json_object 让模型只吐 JSON；即便如此解析层仍做兜底，
 * 因为线上模型偶尔仍会包裹代码块或附带一句解释。
 */
export function createDeepSeekSummarizer(options: DeepSeekSummarizerOptions): Summarizer {
  const baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '');
  const model = options.model ?? 'deepseek-chat';
  const timeoutMs = options.timeoutMs ?? 45_000;
  const doFetch = options.fetchImpl ?? fetch;

  /** 发一次请求并返回模型文本；把 HTTP 错误翻译成可读的异常 */
  async function callModel(userContent: string, maxTokens: number | null): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await doFetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: userContent },
          ],
          response_format: { type: 'json_object' },
          temperature: 0.2,
          stream: false,
          ...(maxTokens === null ? {} : { max_tokens: maxTokens }),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const detail = await response.text().catch(() => '');
        const suffix = detail ? `：${detail.slice(0, 200)}` : '';
        // 401/403 明确说明是密钥问题。调用方据此区分"Key 不对"和"网络/限流"
        if (response.status === 401 || response.status === 403) {
          throw new InvalidApiKeyError(`DeepSeek 拒绝了这个 API Key（HTTP ${response.status}）${suffix}`);
        }
        throw new SummaryError(`DeepSeek 接口返回 ${response.status}${suffix}`);
      }

      const payload = (await response.json()) as ChatCompletionResponse;
      return payload.choices?.[0]?.message?.content ?? '';
    } catch (error) {
      if (error instanceof SummaryError) throw error;
      if (error instanceof Error && error.name === 'AbortError') {
        throw new SummaryError(`调用 DeepSeek 超时（${timeoutMs}ms）`);
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new SummaryError(`调用 DeepSeek 失败：${reason}`);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async summarize(input) {
      const { rawText, keywords } = input;
      const userContent =
        keywords.length > 0 ? `${buildKeywordSection(keywords)}${rawText}` : rawText;
      const content = await callModel(userContent, null);
      return { draft: parseSummaryResponse(content, rawText), provider: 'deepseek' as const };
    },

    async validate() {
      await callModel(VALIDATION_USER_MESSAGE, 16);
    },
  };
}
