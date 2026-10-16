import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ReExtractPreview, UpdateCardRequest } from '@notification-hub/shared';
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
    schedules: [],
    keywords: { priority: [], hit: [], missed: [] },
    provider: 'deepseek',
    createdAt: '2026-09-20T06:32:00.000Z',
    createdAtLabel: '2026-09-20 14:32',
    updatedAt: null,
    revisionCount: 0,
    pinned: false,
    ...overrides,
  };
}

/** 重新提炼的替身：默认回一份"官方改了口径"的草稿 */
function makePreview(overrides: Partial<ReExtractPreview> = {}): ReExtractPreview {
  return {
    rawText: '【教务处】选课截止时间推迟到10月22日。',
    title: '选课截止时间推迟',
    time: '2026年10月22日',
    source: '教务处',
    keyPoints: ['截止时间推迟到10月22日'],
    provider: 'mock',
    schedule: {
      start: '2026-10-22',
      end: '2026-10-22',
      dayCount: 1,
      label: '2026年10月22日',
      inferredYear: false,
    },
    schedules: [
      {
        start: '2026-10-22',
        end: '2026-10-22',
        dayCount: 1,
        label: '2026年10月22日',
        inferredYear: false,
      },
    ],
    supplementedKeywords: [],
    ...overrides,
  };
}

function setup(card: CardView = makeCard(), onReExtract = vi.fn(async () => makePreview())) {
  const onSubmit = vi.fn(async (_patch: UpdateCardRequest) => true);
  const onCancel = vi.fn();
  render(
    <CardEditForm card={card} onSubmit={onSubmit} onCancel={onCancel} onReExtract={onReExtract} />,
  );
  return { onSubmit, onCancel, onReExtract };
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
});

describe('CardEditForm 官方改口径：粘贴原文重新提炼', () => {
  const pasteBox = () => screen.getByLabelText('官方修改后的原文') as HTMLTextAreaElement;

  it('没有粘贴内容时按钮给出提示，不去调接口', async () => {
    const onReExtract = vi.fn(async () => makePreview());
    setup(makeCard(), onReExtract);

    await userEvent.click(screen.getByRole('button', { name: '重新提炼' }));

    expect(onReExtract).not.toHaveBeenCalled();
    expect(screen.getByText('先把官方修改后的原文粘进来')).toBeInTheDocument();
  });

  it('粘贴后点「重新提炼」，用粘贴的原文去提炼并给出逐项对比', async () => {
    const onReExtract = vi.fn(async () => makePreview());
    setup(makeCard(), onReExtract);

    await userEvent.type(pasteBox(), '【教务处】截止时间推迟到10月22日。');
    await userEvent.click(screen.getByRole('button', { name: '重新提炼' }));

    expect(onReExtract).toHaveBeenCalledWith('【教务处】截止时间推迟到10月22日。');
    const diff = await screen.findByTestId('re-extract-diff');
    // 原值与新值都要显示出来，用户才能对比
    expect(within(diff).getByText('选课开放通知')).toBeInTheDocument();
    expect(within(diff).getByText('选课截止时间推迟')).toBeInTheDocument();
    expect(within(diff).getByText('2026年10月22日')).toBeInTheDocument();
  });

  it('提炼结果不会自动覆盖：不点「采纳」时各字段原样不动', async () => {
    setup();
    await userEvent.type(pasteBox(), '官方新原文');
    await userEvent.click(screen.getByRole('button', { name: '重新提炼' }));
    await screen.findByTestId('re-extract-diff');

    // 这是这个功能的核心约束：官方改动未必只动时间，用户可能手工订正过要点，
    // 所以提炼只做"给一份草稿"，覆盖必须由用户逐项确认
    expect(titleInput()).toHaveValue('选课开放通知');
    expect(timeInput()).toHaveValue('2026年9月28日');
  });

  it('点某一项的「采纳」只改那一项', async () => {
    setup();
    await userEvent.type(pasteBox(), '官方新原文');
    await userEvent.click(screen.getByRole('button', { name: '重新提炼' }));
    const diff = await screen.findByTestId('re-extract-diff');

    // 只采纳"时间"这一行
    const timeRow = within(diff).getByText('时间').closest('.re-extract__row') as HTMLElement;
    await userEvent.click(within(timeRow).getByRole('button', { name: '采纳' }));

    expect(timeInput()).toHaveValue('2026年10月22日');
    // 标题没被一起改掉
    expect(titleInput()).toHaveValue('选课开放通知');
  });

  it('「全部采纳」把四项一起换上，并把原文留进补充说明', async () => {
    const { onSubmit } = setup();
    await userEvent.type(pasteBox(), '官方新原文');
    await userEvent.click(screen.getByRole('button', { name: '重新提炼' }));
    await screen.findByTestId('re-extract-diff');

    await userEvent.click(screen.getByRole('button', { name: '全部采纳' }));

    expect(titleInput()).toHaveValue('选课截止时间推迟');
    expect(timeInput()).toHaveValue('2026年10月22日');
    expect(sourceInput()).toHaveValue('教务处');
    expect(screen.getByLabelText('要点 1')).toHaveValue('截止时间推迟到10月22日');
    // 日后对账时要知道这轮改的是哪份通知
    expect(noteInput()).toHaveValue('【教务处】选课截止时间推迟到10月22日。');

    // 采纳只是填进表单，还没提交
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: '保存修改' }));
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it('识别不出时间时明确说明，而不是留一个空值让人以为改好了', async () => {
    setup(
      makeCard(),
      vi.fn(async () => makePreview({ time: null, schedule: null })),
    );
    await userEvent.type(pasteBox(), '官方新原文（没有日期）');
    await userEvent.click(screen.getByRole('button', { name: '重新提炼' }));

    expect(await screen.findByText('（没识别出时间）')).toBeInTheDocument();
    expect(screen.getByText(/没识别出日期，这张卡不会进日历/)).toBeInTheDocument();
  });

  it('提炼出的排期会显示出来，确认前就知道会落到哪天', async () => {
    setup();
    await userEvent.type(pasteBox(), '官方新原文');
    await userEvent.click(screen.getByRole('button', { name: '重新提炼' }));

    expect(await screen.findByText(/排期：10月22日/)).toBeInTheDocument();
  });

  it('服务端兜底补入的关注点会说明，不让人以为那是模型提炼的', async () => {
    setup(
      makeCard(),
      vi.fn(async () => makePreview({ supplementedKeywords: ['检查时间', '报到地点'] })),
    );
    await userEvent.type(pasteBox(), '官方新原文');
    await userEvent.click(screen.getByRole('button', { name: '重新提炼' }));

    expect(await screen.findByText('替你补了关注的：检查时间、报到地点')).toBeInTheDocument();
  });

  it('提炼失败时给出错误原因，并保留已填内容', async () => {
    setup(
      makeCard(),
      vi.fn(async () => {
        throw new Error('无法连接到本地服务，请确认服务端已启动');
      }),
    );
    await userEvent.type(pasteBox(), '官方新原文');
    await userEvent.click(screen.getByRole('button', { name: '重新提炼' }));

    expect(await screen.findByText('无法连接到本地服务，请确认服务端已启动')).toBeInTheDocument();
    expect(screen.queryByTestId('re-extract-diff')).toBeNull();
    expect(titleInput()).toHaveValue('选课开放通知');
  });

  it('提交失败时留在表单里并提示', async () => {
    const card = makeCard();
    const onSubmit = vi.fn(async () => false);
    const onCancel = vi.fn();
    render(
      <CardEditForm
        card={card}
        onSubmit={onSubmit}
        onCancel={onCancel}
        onReExtract={async () => makePreview()}
      />,
    );

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
