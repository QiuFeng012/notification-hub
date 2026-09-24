import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { SettingsView } from '@notification-hub/shared';
import App from '../src/App';
import { ApiError, type CardApi, type SettingsApi } from '../src/lib/api';
import type { CardView } from '../src/lib/card-view';

function makeCard(overrides: Partial<CardView> = {}): CardView {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    title: '选课开放通知',
    time: '3月8日24:00前',
    source: '教务处',
    keyPoints: ['3月5日14:00开放选课', '3月8日24:00前完成'],
    rawText: '【教务处】选课通知原文',
    keywords: { priority: [], hit: [], missed: [] },
    provider: 'deepseek',
    createdAt: '2025-03-05T06:32:00.000Z',
    createdAtLabel: '2025-03-05 14:32',
    ...overrides,
  };
}

function makeSettings(overrides: Partial<SettingsView> = {}): SettingsView {
  return {
    configured: false,
    apiKeyMask: null,
    source: 'mock',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    ...overrides,
  };
}

interface FakeApiOptions {
  initial?: CardView[];
  createImpl?: (rawText: string, keywords?: string[]) => Promise<CardView>;
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

interface FakeSettingsApiOptions {
  initial?: SettingsView;
  updateImpl?: (patch: { apiKey?: string; baseUrl?: string; model?: string }) => Promise<{
    settings: SettingsView;
    warning: string | null;
  }>;
  clearImpl?: () => Promise<SettingsView>;
}

function createFakeSettingsApi(options: FakeSettingsApiOptions = {}) {
  const api: SettingsApi = {
    getSettings: vi.fn(async () => options.initial ?? makeSettings()),
    updateSettings: vi.fn(
      options.updateImpl ??
        (async () => ({ settings: makeSettings(), warning: null })),
    ),
    clearSettings: vi.fn(options.clearImpl ?? (async () => makeSettings())),
  };
  return api;
}

function renderApp(api: CardApi, settingsApi: SettingsApi = createFakeSettingsApi()) {
  return render(<App api={api} settingsApi={settingsApi} />);
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
    expect(api.createCard).toHaveBeenCalledWith('【教务处】选课通知', []);

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

  it('未配置 Key 时提示去 API 设置里填', async () => {
    renderApp(createFakeApi({ initial: [makeCard({ provider: 'mock' })] }));
    await screen.findByText('选课开放通知');

    const notice = document.querySelector('.notice--mock');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('本地启发式摘要');
    expect(notice?.textContent).toContain('API 设置');
  });

  it('未配置 Key 时，没有卡片也提示去配置', async () => {
    renderApp(createFakeApi());

    await screen.findByText('还没有信息卡');
    expect(document.querySelector('.notice--mock')).not.toBeNull();
  });

  it('已配置 Key 时不显示 mock 提示', async () => {
    renderApp(
      createFakeApi({ initial: [makeCard({ provider: 'mock' })] }),
      createFakeSettingsApi({
        initial: makeSettings({ configured: true, apiKeyMask: 'sk-1234…cdef', source: 'user' }),
      }),
    );

    await screen.findByText('选课开放通知');
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

describe('API 设置', () => {
  it('默认折叠，只显示当前模式', async () => {
    renderApp(createFakeApi());

    const toggle = await screen.findByRole('button', { name: /API 设置/ });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('未配置，正在使用本地启发式摘要');
    expect(screen.queryByLabelText('DeepSeek API Key')).not.toBeInTheDocument();
  });

  it('展开后显示已保存 Key 的掩码，输入框保持为空', async () => {
    renderApp(
      createFakeApi(),
      createFakeSettingsApi({
        initial: makeSettings({ configured: true, apiKeyMask: 'sk-abc123…cdef', source: 'user' }),
      }),
    );

    await userEvent.click(await screen.findByRole('button', { name: /API 设置/ }));

    expect(screen.getByText('sk-abc123…cdef')).toBeInTheDocument();
    // 完整 Key 不应回填到输入框
    expect(screen.getByLabelText('DeepSeek API Key')).toHaveValue('');
  });

  it('填写 Key 后保存，提交的是用户输入的值', async () => {
    const settingsApi = createFakeSettingsApi({
      updateImpl: async (patch) => ({
        settings: makeSettings({
          configured: true,
          apiKeyMask: 'sk-user…9999',
          source: 'user',
          baseUrl: patch.baseUrl ?? 'https://api.deepseek.com',
          model: patch.model ?? 'deepseek-chat',
        }),
        warning: null,
      }),
    });
    renderApp(createFakeApi(), settingsApi);

    await userEvent.click(await screen.findByRole('button', { name: /API 设置/ }));
    await userEvent.type(screen.getByLabelText('DeepSeek API Key'), 'sk-user-key-9999');
    await userEvent.click(screen.getByRole('button', { name: '保存并验证' }));

    await waitFor(() =>
      expect(settingsApi.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'sk-user-key-9999' }),
      ),
    );
    expect(await screen.findByText('设置已保存')).toBeInTheDocument();
    expect(screen.queryByText(/本地启发式摘要/)).not.toBeInTheDocument();
  });

  it('保存后折叠面板并清空输入框', async () => {
    const settingsApi = createFakeSettingsApi({
      updateImpl: async () => ({
        settings: makeSettings({ configured: true, apiKeyMask: 'sk-user…9999', source: 'user' }),
        warning: null,
      }),
    });
    renderApp(createFakeApi(), settingsApi);

    await userEvent.click(await screen.findByRole('button', { name: /API 设置/ }));
    await userEvent.type(screen.getByLabelText('DeepSeek API Key'), 'sk-user-key-9999');
    await userEvent.click(screen.getByRole('button', { name: '保存并验证' }));

    await screen.findByText('设置已保存');
    expect(screen.queryByLabelText('DeepSeek API Key')).not.toBeInTheDocument();
  });

  it('留空保存时不提交 apiKey，避免把已有 Key 冲掉', async () => {
    const settingsApi = createFakeSettingsApi({
      initial: makeSettings({ configured: true, apiKeyMask: 'sk-abc123…cdef', source: 'user' }),
      updateImpl: async () => ({
        settings: makeSettings({ configured: true, apiKeyMask: 'sk-abc123…cdef', source: 'user' }),
        warning: null,
      }),
    });
    renderApp(createFakeApi(), settingsApi);

    await userEvent.click(await screen.findByRole('button', { name: /API 设置/ }));
    await userEvent.click(screen.getByRole('button', { name: '保存并验证' }));

    await waitFor(() => expect(settingsApi.updateSettings).toHaveBeenCalled());
    const patch = vi.mocked(settingsApi.updateSettings).mock.calls[0]?.[0];
    expect(patch).not.toHaveProperty('apiKey');
  });

  it('Key 被拒绝时保留面板并展示服务端原因', async () => {
    const settingsApi = createFakeSettingsApi({
      updateImpl: async () => {
        throw new ApiError('INVALID_API_KEY', 'DeepSeek 拒绝了这个 API Key（HTTP 401）', 400);
      },
    });
    renderApp(createFakeApi(), settingsApi);

    await userEvent.click(await screen.findByRole('button', { name: /API 设置/ }));
    await userEvent.type(screen.getByLabelText('DeepSeek API Key'), 'sk-wrong');
    await userEvent.click(screen.getByRole('button', { name: '保存并验证' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('DeepSeek 拒绝了这个 API Key');
    // 面板保持展开，用户可以直接改
    expect(screen.getByLabelText('DeepSeek API Key')).toBeInTheDocument();
  });

  it('验证无法判定时仍保存，但把原因告诉用户', async () => {
    const settingsApi = createFakeSettingsApi({
      updateImpl: async () => ({
        settings: makeSettings({ configured: true, apiKeyMask: 'sk-user…9999', source: 'user' }),
        warning: '设置已保存，但没能验证通过：调用 DeepSeek 超时（15000ms）',
      }),
    });
    renderApp(createFakeApi(), settingsApi);

    await userEvent.click(await screen.findByRole('button', { name: /API 设置/ }));
    await userEvent.type(screen.getByLabelText('DeepSeek API Key'), 'sk-user-key-9999');
    await userEvent.click(screen.getByRole('button', { name: '保存并验证' }));

    expect(await screen.findByRole('status')).toHaveTextContent('没能验证通过');
  });

  it('已配置时可以清除，清除后回到未配置状态', async () => {
    const settingsApi = createFakeSettingsApi({
      initial: makeSettings({ configured: true, apiKeyMask: 'sk-abc123…cdef', source: 'user' }),
      clearImpl: async () => makeSettings({ configured: false, apiKeyMask: null, source: 'mock' }),
    });
    renderApp(createFakeApi(), settingsApi);

    await userEvent.click(await screen.findByRole('button', { name: /API 设置/ }));
    await userEvent.click(screen.getByRole('button', { name: '清除' }));

    await waitFor(() => expect(settingsApi.clearSettings).toHaveBeenCalled());
    expect(await screen.findByText('已清除保存的 Key')).toBeInTheDocument();
  });

  it('未配置时不显示清除按钮', async () => {
    renderApp(createFakeApi());

    await userEvent.click(await screen.findByRole('button', { name: /API 设置/ }));
    expect(screen.queryByRole('button', { name: '清除' })).not.toBeInTheDocument();
  });

  it('Key 过长时阻止保存并提示', async () => {
    const settingsApi = createFakeSettingsApi();
    renderApp(createFakeApi(), settingsApi);

    await userEvent.click(await screen.findByRole('button', { name: /API 设置/ }));
    // 直接设值，避免逐字输入 201 个字符
    const input = screen.getByLabelText('DeepSeek API Key');
    await userEvent.type(input, 'x'.repeat(201));

    expect(screen.getByText(/Key 过长/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存并验证' })).toBeDisabled();
    expect(settingsApi.updateSettings).not.toHaveBeenCalled();
  });

  it('服务端返回 env 来源时标注清楚', async () => {
    renderApp(
      createFakeApi(),
      createFakeSettingsApi({
        initial: makeSettings({ configured: true, apiKeyMask: 'sk-env…0001', source: 'env' }),
      }),
    );

    const toggle = await screen.findByRole('button', { name: /API 设置/ });
    expect(toggle).toHaveTextContent('已配置（来自环境变量）');
  });
});

describe('本次关注点', () => {
  it('输入关键词后显示为标签，并随提交一起发送', async () => {
    const api = createFakeApi();
    renderApp(api);

    await userEvent.type(screen.getByLabelText(/本次关注点/), '面试,报销');
    // 标签与输入框内容会同时出现，这里断言标签个数
    expect(document.querySelectorAll('.keyword-pill')).toHaveLength(2);

    await userEvent.type(screen.getByLabelText('通知原文'), '一条通知');
    await userEvent.click(screen.getByRole('button', { name: '生成信息卡' }));

    await waitFor(() =>
      expect(api.createCard).toHaveBeenCalledWith('一条通知', ['面试', '报销']),
    );
  });

  it('顿号与空格也能分隔，且去重', async () => {
    const api = createFakeApi();
    renderApp(api);

    await userEvent.type(screen.getByLabelText(/本次关注点/), '面试、报销，面试');
    expect(document.querySelectorAll('.keyword-pill')).toHaveLength(2);
    expect(screen.getByText('面试')).toBeInTheDocument();
    expect(screen.getByText('报销')).toBeInTheDocument();
  });

  it('提交成功后关键词输入被清空（一次性，不残留到下一次）', async () => {
    const api = createFakeApi();
    renderApp(api);

    const keywordInput = screen.getByLabelText(/本次关注点/);
    await userEvent.type(keywordInput, '面试');
    await userEvent.type(screen.getByLabelText('通知原文'), '一条通知');
    await userEvent.click(screen.getByRole('button', { name: '生成信息卡' }));

    await waitFor(() => expect(keywordInput).toHaveValue(''));
    expect(document.querySelectorAll('.keyword-pill')).toHaveLength(0);
  });

  it('提交失败时保留关键词，方便重试', async () => {
    const api = createFakeApi({
      createImpl: async () => {
        throw new ApiError('SUMMARY_FAILED', '模型炸了', 502);
      },
    });
    renderApp(api);

    const keywordInput = screen.getByLabelText(/本次关注点/);
    await userEvent.type(keywordInput, '面试');
    await userEvent.type(screen.getByLabelText('通知原文'), '一条通知');
    await userEvent.click(screen.getByRole('button', { name: '生成信息卡' }));

    await screen.findByRole('alert');
    expect(keywordInput).toHaveValue('面试');
  });

  it('超过上限时阻止提交并提示', async () => {
    const api = createFakeApi();
    renderApp(api);

    const many = Array.from({ length: 21 }, (_, index) => `词${index}`).join(',');
    await userEvent.type(screen.getByLabelText(/本次关注点/), many);

    expect(screen.getByText(/最多 20 个/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('通知原文'), '一条通知');
    expect(screen.getByRole('button', { name: '生成信息卡' })).toBeDisabled();
    expect(api.createCard).not.toHaveBeenCalled();
  });

  it('不填关注点时不会把空数组之外的字段塞给接口', async () => {
    const api = createFakeApi();
    renderApp(api);

    await userEvent.type(screen.getByLabelText('通知原文'), '一条通知');
    await userEvent.click(screen.getByRole('button', { name: '生成信息卡' }));

    await waitFor(() => expect(api.createCard).toHaveBeenCalledWith('一条通知', []));
  });
});

describe('卡片上的关注点标注', () => {
  const keywordCard = makeCard({
    keyPoints: ['3月5日14:00开放选课', '请于3月8日24:00前完成报销材料提交'],
    keywords: { priority: ['报销', '面试'], hit: ['报销'], missed: [] },
  });

  it('命中的关键词在要点里高亮', async () => {
    renderApp(createFakeApi({ initial: [keywordCard] }));
    await screen.findByText('选课开放通知');

    const marks = document.querySelectorAll('mark.keyword-mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe('报销');
  });

  it('卡头显示"含你关注的"', async () => {
    renderApp(createFakeApi({ initial: [keywordCard] }));

    const chip = await screen.findByTestId('keyword-hit');
    expect(chip).toHaveTextContent('含你关注的：报销');
  });

  it('展示本次关注点全量，并说明哪些是系统补入的', async () => {
    renderApp(
      createFakeApi({
        initial: [
          makeCard({
            keyPoints: ['（关注点）报销材料请交到财务处'],
            keywords: { priority: ['报销', '面试'], hit: [], missed: ['报销'] },
          }),
        ],
      }),
    );

    await screen.findByText('选课开放通知');
    // 用卡片内的专属类名定位，避免误匹配表单上的「本次关注点」标签
    const line = document.querySelector('.card__keywords');
    expect(line).not.toBeNull();
    expect(line?.textContent).toContain('报销');
    expect(line?.textContent).toContain('面试');
    expect(line?.textContent).toContain('由系统从原文补入');
  });

  it('没有关注点的卡片不显示相关标注', async () => {
    renderApp(createFakeApi({ initial: [makeCard()] }));
    await screen.findByText('选课开放通知');

    expect(document.querySelector('.card__keywords')).toBeNull();
    expect(screen.queryByTestId('keyword-hit')).not.toBeInTheDocument();
    expect(document.querySelectorAll('mark.keyword-mark')).toHaveLength(0);
  });

  it('没有任何命中的卡片不显示命中标签，但仍显示关注点', async () => {
    renderApp(
      createFakeApi({
        initial: [makeCard({ keywords: { priority: ['报销'], hit: [], missed: [] } })],
      }),
    );

    await screen.findByText('选课开放通知');
    expect(document.querySelector('.card__keywords')).not.toBeNull();
    expect(screen.queryByTestId('keyword-hit')).not.toBeInTheDocument();
  });

  it('服务端返回的关键词字段损坏时不崩，也不产生虚假高亮', async () => {
    // 直接把 keywords 塞成非法值，模拟老数据或异常响应
    const broken = { ...makeCard(), keywords: 'not-an-object' };
    renderApp(createFakeApi({ initial: [broken as unknown as CardView] }));

    await screen.findByText('选课开放通知');
    expect(document.querySelector('.card__keywords')).toBeNull();
    expect(document.querySelectorAll('mark.keyword-mark')).toHaveLength(0);
  });
});
