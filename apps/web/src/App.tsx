import { useMemo } from 'react';
import { CardList } from './components/CardList';
import { IngestForm } from './components/IngestForm';
import { useCards } from './hooks/useCards';
import { createCardApi } from './lib/api';

/**
 * 应用外壳：左侧输入栏 + 右侧信息卡时间流。
 * 通过 props 传入 api 是为了在组件测试里注入替身，无需真的发请求。
 */
export interface AppProps {
  api?: ReturnType<typeof createCardApi>;
}

export default function App({ api }: AppProps = {}) {
  const cardApi = useMemo(() => api ?? createCardApi(), [api]);
  const { cards, loading, submitting, error, dismissError, submit, remove } = useCards(cardApi);

  return (
    <div className="app">
      <header className="app__header">
        <div>
          <h1 className="app__title">信息整合台</h1>
          <p className="app__subtitle">粘贴通知 → AI 提炼要点 → 生成信息卡，数据只存在本机</p>
        </div>
        <span className="app__badge">{loading ? '—' : `${cards.length} 张卡`}</span>
      </header>

      {error ? (
        <div className="banner banner--error" role="alert">
          <span>{error}</span>
          <button type="button" className="banner__close" onClick={dismissError} aria-label="关闭提示">
            ×
          </button>
        </div>
      ) : null}

      {!loading && cards.some((card) => card.provider === 'mock') ? (
        <p className="notice notice--mock">
          当前有卡片来自<strong>启发式摘要</strong>（按关键词与日期规则挑句子，不是 AI 总结）。
          在仓库根目录创建 <code>.env</code> 并填入 <code>DEEPSEEK_API_KEY</code>，重启后即启用 DeepSeek 真实总结。
        </p>
      ) : null}

      <main className="app__main">
        <section className="panel panel--input" aria-label="输入通知">
          <IngestForm submitting={submitting} onSubmit={submit} />
        </section>

        <section className="panel panel--list" aria-label="信息卡列表">
          <h2 className="panel__title">信息卡</h2>
          <CardList cards={cards} loading={loading} onDelete={remove} />
        </section>
      </main>
    </div>
  );
}
