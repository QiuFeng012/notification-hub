import { useCallback, useEffect, useState } from 'react';
import { MAX_RAW_TEXT_LENGTH } from '@notification-hub/shared';
import { ApiError, type CardApi } from '../lib/api';
import type { CardView } from '../lib/card-view';

export interface UseCardsResult {
  cards: CardView[];
  loading: boolean;
  submitting: boolean;
  /** 最近一次失败的中文提示，null 表示无错误 */
  error: string | null;
  dismissError: () => void;
  submit: (rawText: string) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
}

function toMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return '发生未知错误';
}

/**
 * 信息卡状态管理：负责初次加载、提交原文、删除卡片。
 * 抽成 hook 是为了让组件只管渲染，业务动作在测试里可以脱离界面单独验证。
 */
export function useCards(api: CardApi): UseCardsResult {
  const [cards, setCards] = useState<CardView[]>([]);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const list = await api.listCards();
        if (!cancelled) setCards(list);
      } catch (caught) {
        if (!cancelled) setError(toMessage(caught));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const dismissError = useCallback(() => setError(null), []);

  const submit = useCallback(
    async (rawText: string) => {
      const trimmed = rawText.trim();
      if (trimmed.length === 0) {
        setError('请先粘贴通知内容');
        return false;
      }
      if (trimmed.length > MAX_RAW_TEXT_LENGTH) {
        setError(`内容过长（${trimmed.length} 字符），上限 ${MAX_RAW_TEXT_LENGTH} 字符`);
        return false;
      }

      setSubmitting(true);
      setError(null);
      try {
        const card = await api.createCard(trimmed);
        // 新卡插到最前，与列表接口的倒序排列保持一致
        setCards((previous) => [card, ...previous]);
        return true;
      } catch (caught) {
        setError(toMessage(caught));
        return false;
      } finally {
        setSubmitting(false);
      }
    },
    [api],
  );

  const remove = useCallback(
    async (id: string) => {
      const snapshot = cards;
      // 乐观删除：先在界面上移除，失败再回滚，避免等待网络造成卡顿感
      setCards((previous) => previous.filter((card) => card.id !== id));
      try {
        await api.deleteCard(id);
      } catch (caught) {
        setCards(snapshot);
        setError(`删除失败：${toMessage(caught)}`);
      }
    },
    [api, cards],
  );

  return { cards, loading, submitting, error, dismissError, submit, remove };
}
