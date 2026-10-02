import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { UpdateCardRequest } from '@notification-hub/shared';
import { CardEditForm } from '../src/components/CardEditForm';
import { RevisionHistory } from '../src/components/RevisionHistory';
import type { CardView } from '../src/lib/card-view';

function makeCard(overrides: Partial<CardView> = {}): CardView {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    title: '选课开放通知',
    time: '2026年9月28日',
    source: '教务处',
    keyPoints: ['要点一', '要点二'],
    rawText: '原文',
    schedule: null,
    keywords: { priority: [], hit: [], missed: [] },
    provider: 'deepseek',
    createdAt: '2026-09-20T06:32:00.000Z',
    createdAtLabel: '2026-09-20 14:32',
    updatedAt: null,
    revisionCount: 0,
    ...overrides,
  };
}

function setup(card: CardView = makeCard()) {
  const onSubmit = vi.fn(async (_patch: UpdateCardRequest) => true);
  const onCancel = vi.fn();
  render(<CardEditForm card={card} onSubmit={onSubmit} onCancel={onCancel} />);
  return { onSubmit, onCancel };
}

const titleInput = () => screen.getByLabelText('标题') as HTMLInputElement;
const timeInput = () => screen.getByLabelText('时间') as HTMLInputElement;
const sourceInput = () => screen.getByLabelText('来源') as HTMLInputElement;
const reasonSelect = () => screen.getByLabelText('修改原因（必填）') as HTMLSelectElement;
const noteInput = () => screen.getByLabelText('补充说明') as HTMLInputElement;

describe('CardEditForm 预填', () => {
  it('用卡片当前内容预填各字段', () => {
    setup();
    expect(titleInput()).toHaveValue('选课开放通知');
    expect(timeInput()).toHaveValue('2026年9月28日');
    expect(sourceInput()).toHaveValue('教务处');
    expect(screen.getByLabelText('要点 1')).toHaveValue('要点一');
    expect(screen.getByLabelText('要点 2')).toHaveValue('要点二');
  });

  it('时间与来源为空时输入框为空', () => {
    setup(makeCard({ time: null, source: null }));
    expect(timeInput()).toHaveValue('');
    expect(sourceInput()).toHaveValue('');
  });

  it('默认修改原因为"官方通知更新"', () => {
    setup();
    expect(reasonSelect()).toHaveValue('official');
  });
});

describe('CardEditForm 提交', () => {
  it('提交时带上全部字段与原因', async () => {
    const { onSubmit } = setup();
    await userEvent.clear(titleInput());
    await userEvent.type(titleInput(), '教务处：选课时间调整');
    await userEvent.clear(timeInput());
    await userEvent.type(timeInput(), '2026年10月5日');
    await userEvent.selectOptions(reasonSelect(), 'official');
    await userEvent.type(noteInput(), '教务处推迟了一周');
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect(onSubmit).toHaveBeenCalledWith({
      title: '教务处：选课时间调整',
      time: '2026年10月5日',
      source: '教务处',
      keyPoints: ['要点一', '要点二'],
      reason: 'official',
      note: '教务处推迟了一周',
    });
  });

  it('未填补充说明时不带 note 字段', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));

    const patch = onSubmit.mock.calls[0]?.[0] as UpdateCardRequest;
    expect(patch).not.toHaveProperty('note');
  });

  it('清空时间时提交 null，表示这条没有可排的日期', async () => {
    const { onSubmit } = setup();
    await userEvent.clear(timeInput());
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect((onSubmit.mock.calls[0]?.[0] as UpdateCardRequest).time).toBeNull();
  });

  it('清空来源时提交 null', async () => {
    const { onSubmit } = setup();
    await userEvent.clear(sourceInput());
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect((onSubmit.mock.calls[0]?.[0] as UpdateCardRequest).source).toBeNull();
  });

  it('三种修改原因都能选', async () => {
    const { onSubmit } = setup();
    for (const [value, label] of [
      ['official', '官方通知更新'],
      ['manual', '我手动更正'],
      ['other', '其他'],
    ] as const) {
      await userEvent.selectOptions(reasonSelect(), value);
      await userEvent.click(screen.getByRole('button', { name: '保存修改' }));
      expect(screen.getByRole('option', { name: label })).toBeInTheDocument();
    }

    const reasons = onSubmit.mock.calls.map((call) => (call[0] as UpdateCardRequest).reason);
    expect(reasons).toEqual(['official', 'manual', 'other']);
  });
});

describe('CardEditForm 校验', () => {
  it('标题为空时阻止提交并提示', async () => {
    const { onSubmit } = setup();
    await userEvent.clear(titleInput());

    expect(screen.getByText('标题不能为空')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存修改' })).toBeDisabled();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('要点全部清空时阻止提交', async () => {
    const { onSubmit } = setup();
    await userEvent.clear(screen.getByLabelText('要点 1'));
    await userEvent.clear(screen.getByLabelText('要点 2'));

    expect(screen.getByText('至少要保留一条要点')).toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it('空白要点被忽略，不进入提交内容', async () => {
    const { onSubmit } = setup();
    await userEvent.clear(screen.getByLabelText('要点 2'));
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect((onSubmit.mock.calls[0]?.[0] as UpdateCardRequest).keyPoints).toEqual(['要点一']);
  });

  it('提交失败时留在表单里并提示', async () => {
    const card = makeCard();
    const onSubmit = vi.fn(async () => false);
    const onCancel = vi.fn();
    render(<CardEditForm card={card} onSubmit={onSubmit} onCancel={onCancel} />);

    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect(await screen.findByText('保存失败，请查看上方提示')).toBeInTheDocument();
    expect(onCancel).not.toHaveBeenCalled();
  });
});

describe('CardEditForm 要点编辑', () => {
  it('可以加一条要点', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: '加一条要点' }));
    await userEvent.type(screen.getByLabelText('要点 3'), '补充要点');
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect((onSubmit.mock.calls[0]?.[0] as UpdateCardRequest).keyPoints).toEqual([
      '要点一',
      '要点二',
      '补充要点',
    ]);
  });

  it('可以删掉一条要点', async () => {
    const { onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: '删除要点 1' }));
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));

    expect((onSubmit.mock.calls[0]?.[0] as UpdateCardRequest).keyPoints).toEqual(['要点二']);
  });

  it('只剩一条时不能删', () => {
    setup(makeCard({ keyPoints: ['唯一要点'] }));
    expect(screen.getByRole('button', { name: '删除要点 1' })).toBeDisabled();
  });

  it('可以取消编辑', async () => {
    const { onCancel, onSubmit } = setup();
    await userEvent.click(screen.getByRole('button', { name: '取消' }));

    expect(onCancel).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
  });
});

describe('RevisionHistory', () => {
  const revision = {
    id: 1,
    cardId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    reason: 'official' as const,
    note: '教务处推迟了一周',
    previousTitle: '原标题',
    previousTime: '2026年9月28日',
    previousSource: '教务处',
    previousKeyPoints: ['原要点一', '原要点二'],
    createdAt: '2026-09-25T02:00:00.000Z',
  };

  it('展示改动原因、说明与改动前的内容', async () => {
    render(<RevisionHistory cardId={revision.cardId} load={async () => [revision]} />);

    const history = await screen.findByTestId('revision-history');
    expect(within(history).getByText('官方通知更新')).toBeInTheDocument();
    expect(within(history).getByText('教务处推迟了一周')).toBeInTheDocument();
    // 「原标题」既是字段名也是原值，所以按定义列表的语义定位值
    const values = within(history).getAllByRole('definition');
    expect(values.map((item) => item.textContent)).toEqual([
      '原标题',
      '2026年9月28日',
      '教务处',
      '原要点一原要点二',
    ]);
  });

  it('没有改动时如实说明', async () => {
    render(<RevisionHistory cardId={revision.cardId} load={async () => []} />);
    expect(await screen.findByText('这条还没被改过。')).toBeInTheDocument();
  });

  it('读取失败时给出提示而不是空白', async () => {
    render(
      <RevisionHistory
        cardId={revision.cardId}
        load={async () => {
          throw new Error('读取改动历史失败');
        }}
      />,
    );
    expect(await screen.findByText('读取改动历史失败')).toBeInTheDocument();
  });

  it('缺失的时间与来源显示为"未识别"，不显示 null', async () => {
    render(
      <RevisionHistory
        cardId={revision.cardId}
        load={async () => [{ ...revision, previousTime: null, previousSource: null }]}
      />,
    );

    await screen.findByTestId('revision-history');
    expect(screen.getAllByText('未识别')).toHaveLength(2);
  });
});
