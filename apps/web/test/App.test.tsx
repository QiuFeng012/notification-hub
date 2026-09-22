import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import App from '../src/App';
import { ApiError, type CardApi } from '../src/lib/api';
import type { CardView } from '../src/lib/card-view';

function makeCard(overrides: Partial<CardView> = {}): CardView {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    title: '选课开放通知',
    time: '3月8日24:00前',
    source: '教务处',
    keyPoints: ['3月5日14:00开放选课', '3月8日24:00前完成'],
    rawText: '【教务处】选课通知原文',
    provider: 'deepseek',
    createdAt: '2025-03-05T06:32:00.000Z',
    createdAtLabel: '2025-03-05 14:32',
    ...overrides,
  };
}

interface FakeApiOptions {
  initial?: CardView[];
  createImpl?: (rawText: string) => Promise<CardView>;
  deleteImpl?: (id: string) => Promise<void>;
}

function createFakeApi(options: FakeApiOptions = {}) {
  const api: CardApi = {
    listCards: vi.fn(async () => options.initial ?? []),
    createCard: vi.fn(options.createImpl ?? (async () => makeCard())),
    deleteCard: vi.fn(options.deleteImpl ?? (async () => undefined)),
  };
  return api;
}

function renderApp(api: CardApi) {
  return render(<App api={api} />);
}

describe('空态', () => {
  it('没有历史卡片时显示引导文案', async () => {
    renderApp(createFakeApi());
    expect(await screen.findByText('还没有信息卡')).toBeInTheDocument();
  });

  it('加载完成后提交按钮可用、初始为禁用', async () => {
    renderApp(createFakeApi());
    const button = screen.getByRole('button', { name: '生成信息卡' });
    expect(button).toBeDisabled();

    await userEvent.type(screen.getByLabelText('通知原文'), '一条通知');
    expect(button).toBeEnabled();
  });
});

describe('生成信息卡', () => {
  it('提交原文后新卡片出现在列表最前，输入框被清空', async () => {
    const api = createFakeApi({
      initial: [makeCard({ id: 'old-id', title: '历史卡片' })],
      createImpl: async () => makeCard({ id: 'new-id', title: '新生成的卡片' }),
    });
    renderApp(api);

    const textarea = screen.getByLabelText('通知原文');
    await userEvent.type(textarea, '【教务处】选课通知');
    await userEvent.click(screen.getByRole('button', { name: '生成信息卡' }));

    expect(await screen.findByText('新生成的卡片')).toBeInTheDocument();
    expect(textarea).toHaveValue('');
    expect(api.createCard).toHaveBeenCalledWith('【教务处】选课通知');

    const titles = screen.getAllByTestId('info-card').map((card) => card.querySelector('.card__title')?.textContent);
    expect(titles[0]).toBe('新生成的卡片');
  });

  it('Ctrl + Enter 也能提交', async () => {
    const api = createFakeApi();
    renderApp(api);

    const textarea = screen.getByLabelText('通知原文');
    await userEvent.type(textarea, '一条通知');
    await userEvent.type(textarea, '{Control>}{Enter}{/Control}');

    await waitFor(() => expect(api.createCard).toHaveBeenCalledTimes(1));
  });

  it('提交失败时展示服务端错误、保留输入内容', async () => {
    const api = createFakeApi({
      createImpl: async () => {
        throw new ApiError('SUMMARY_FAILED', 'DeepSeek 接口返回 401', 502);
      },
    });
    renderApp(api);

    const textarea = screen.getByLabelText('通知原文');
    await userEvent.type(textarea, '一条通知');
    await userEvent.click(screen.getByRole('button', { name: '生成信息卡' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('DeepSeek 接口返回 401');
    expect(textarea).toHaveValue('一条通知');
  });

  it('少于一个字数的空白输入不会发起请求', async () => {
    const api = createFakeApi();
    renderApp(api);

    await userEvent.type(screen.getByLabelText('通知原文'), '   ');
    expect(screen.getByRole('button', { name: '生成信息卡' })).toBeDisabled();
    expect(api.createCard).not.toHaveBeenCalled();
  });

  it('显示字数统计', async () => {
    renderApp(createFakeApi());
    expect(screen.getByText('0 / 8000')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('通知原文'), 'abc');
    expect(screen.getByText('3 / 8000')).toBeInTheDocument();
  });

  it('提交中按钮文案变为"正在总结…"且不可重复提交', async () => {
    let release: ((card: CardView) => void) | undefined;
    const api = createFakeApi({
      createImpl: () =>
        new Promise<CardView>((resolve) => {
          release = resolve;
        }),
    });
    renderApp(api);

    await userEvent.type(screen.getByLabelText('通知原文'), '一条通知');
    await userEvent.click(screen.getByRole('button', { name: '生成信息卡' }));

    const pendingButton = await screen.findByRole('button', { name: '正在总结…' });
    expect(pendingButton).toBeDisabled();

    release?.(makeCard());
    expect(await screen.findByRole('button', { name: '生成信息卡' })).toBeInTheDocument();
  });
});

describe('信息卡展示', () => {
  it('渲染标题、来源、时间与要点', async () => {
    renderApp(createFakeApi({ initial: [makeCard()] }));

    expect(await screen.findByText('选课开放通知')).toBeInTheDocument();
    expect(screen.getByText('教务处')).toBeInTheDocument();
    expect(screen.getByText('3月8日24:00前')).toBeInTheDocument();
    expect(screen.getByText('3月5日14:00开放选课')).toBeInTheDocument();
  });

  it('未识别来源与时间时显示"未识别"', async () => {
    renderApp(createFakeApi({ initial: [makeCard({ source: null, time: null })] }));

    await screen.findByText('选课开放通知');
    expect(screen.getAllByText('未识别')).toHaveLength(2);
  });

  it('mock 摘要显示为"启发式摘要"而非"AI 摘要"', async () => {
    renderApp(createFakeApi({ initial: [makeCard({ provider: 'mock' })] }));

    await screen.findByText('选课开放通知');
    const chip = document.querySelector('.chip--mock');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('启发式摘要');
    expect(document.querySelector('.chip--ai')).toBeNull();
  });

  it('列表含 mock 卡片时提示如何启用 AI 总结', async () => {
    renderApp(createFakeApi({ initial: [makeCard({ provider: 'mock' })] }));
    await screen.findByText('选课开放通知');

    const notice = document.querySelector('.notice--mock');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('启发式摘要');
    expect(notice?.textContent).toContain('DEEPSEEK_API_KEY');
  });

  it('全部是 AI 摘要时不显示 mock 提示', async () => {
    renderApp(createFakeApi({ initial: [makeCard({ provider: 'deepseek' })] }));

    await screen.findByText('选课开放通知');
    expect(document.querySelector('.notice--mock')).toBeNull();
  });

  it('没有卡片时不显示 mock 提示', async () => {
    renderApp(createFakeApi());
    await screen.findByText('还没有信息卡');
    expect(document.querySelector('.notice--mock')).toBeNull();
  });

  it('没有要点的卡片给出说明而不是空白', async () => {
    renderApp(createFakeApi({ initial: [makeCard({ keyPoints: [] })] }));
    expect(await screen.findByText('这条通知没有提炼出要点。')).toBeInTheDocument();
  });

  it('默认折叠原文，点击后展开', async () => {
    renderApp(createFakeApi({ initial: [makeCard()] }));

    await screen.findByText('选课开放通知');
    expect(screen.queryByText('【教务处】选课通知原文')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '查看原文' }));
    expect(screen.getByText('【教务处】选课通知原文')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '收起原文' }));
    expect(screen.queryByText('【教务处】选课通知原文')).not.toBeInTheDocument();
  });

  it('加载中显示占位状态', () => {
    const api = createFakeApi();
    api.listCards = vi.fn(() => new Promise<CardView[]>(() => undefined));
    renderApp(api);
    expect(screen.getByRole('status')).toHaveTextContent('正在读取历史信息卡…');
  });

  it('列表加载失败时展示错误提示', async () => {
    const api = createFakeApi();
    api.listCards = vi.fn(async () => {
      throw new ApiError('NETWORK_ERROR', '无法连接到本地服务，请确认服务端已启动', 0);
    });
    renderApp(api);

    expect(await screen.findByRole('alert')).toHaveTextContent('无法连接到本地服务');
  });

  it('可以关闭错误提示条', async () => {
    const api = createFakeApi();
    api.listCards = vi.fn(async () => {
      throw new ApiError('NETWORK_ERROR', '连接失败', 0);
    });
    renderApp(api);

    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('删除信息卡', () => {
  it('点击删除后卡片从列表移除', async () => {
    const api = createFakeApi({ initial: [makeCard()] });
    renderApp(api);

    await screen.findByText('选课开放通知');
    await userEvent.click(screen.getByRole('button', { name: '删除信息卡：选课开放通知' }));

    await waitFor(() => expect(api.deleteCard).toHaveBeenCalledWith('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'));
    expect(await screen.findByText('还没有信息卡')).toBeInTheDocument();
  });

  it('删除失败时卡片被还原并提示原因', async () => {
    const api = createFakeApi({
      initial: [makeCard()],
      deleteImpl: async () => {
        throw new ApiError('CARD_NOT_FOUND', '信息卡不存在或已被删除', 404);
      },
    });
    renderApp(api);

    await screen.findByText('选课开放通知');
    await userEvent.click(screen.getByRole('button', { name: '删除信息卡：选课开放通知' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('删除失败：信息卡不存在或已被删除');
    expect(screen.getByText('选课开放通知')).toBeInTheDocument();
  });
});
