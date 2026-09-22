import { CardItem } from './CardItem';
import type { CardView } from '../lib/card-view';

interface CardListProps {
  cards: CardView[];
  loading: boolean;
  onDelete: (id: string) => Promise<void>;
}

/** 信息卡列表：按入库时间倒序的时间流 */
export function CardList({ cards, loading, onDelete }: CardListProps) {
  if (loading) {
    return (
      <div className="state state--loading" role="status">
        正在读取历史信息卡…
      </div>
    );
  }

  if (cards.length === 0) {
    return (
      <div className="state state--empty">
        <p className="state__title">还没有信息卡</p>
        <p className="state__desc">把收到的通知粘贴到左侧输入栏，点「生成信息卡」就会出现在这里。</p>
      </div>
    );
  }

  return (
    <div className="card-list">
      {cards.map((card) => (
        <CardItem key={card.id} card={card} onDelete={onDelete} />
      ))}
    </div>
  );
}
