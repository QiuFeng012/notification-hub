import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_HIGHLIGHT_STYLE } from '@notification-hub/shared';
import type { CardSchedule, SettingsView } from '@notification-hub/shared';
import App from '../src/App';
import { ApiError, type CardApi, type SettingsApi } from '../src/lib/api';
import type { CardView } from '../src/lib/card-view';
import { PAGE_HASHES, type AppPage } from '../src/lib/route';

function makeCard(overrides: Partial<CardView> = {}): CardView {
  return {
    id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    title: '选课开放通知',
    time: '3月8日24:00前',
    source: '教务处',
    keyPoints: ['3月5日14:00开放选课', '3月8日24:00前完成'],
    rawText: '【教务处】选课通知原文',
    schedule: null,
    keywords: { priority: [], hit: [], missed: [] },
    provider: 'deepseek',
    createdAt: '2025-03-05T06:32:00.000Z',
    createdAtLabel: '2025-03-05 14:32',
    updatedAt: null,
    revisionCount: 0,
    pinned: false,
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
    highlight: { ...DEFAULT_HIGHLIGHT_STYLE, multiDayPalette: [...DEFAULT_HIGHLIGHT_STYLE.multiDayPalette], perCard: {} },
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
    updateCard: vi.fn(async (id: string, patch) => makeCard({ id, ...patch })),
    listRevisions: vi.fn(async () => []),
    clearRevisions: vi.fn(async () => undefined),
    // 置顶要保留卡片原有内容，只翻 pinned——否则测试里会把标题也一起换掉
    setPinned: vi.fn(async (id: string, pinned: boolean) => ({
      ...((options.initial ?? []).find((card) => card.id === id) ?? makeCard()),
      id,
      pinned,
    })),
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

/**
 * 渲染应用。
 *
 * 页面由地址栏 hash 决定（见 src/lib/route.ts），所以进哪个页面就设哪个 hash，
 * 顺便也让"刷新后停在原页面"这条行为在测试里成立。
 */
function renderApp(
  api: CardApi,
  settingsApi: SettingsApi = createFakeSettingsApi(),
  today?: string,
  page: AppPage = 'home',
) {
  window.location.hash = PAGE_HASHES[page];
  return render(<App api={api} settingsApi={settingsApi} today={today} />);
}

/** 信息卡只存在于信息卡页，凡是断言卡片的用例都从这一页进 */
function renderCardsApp(api: CardApi, settingsApi?: SettingsApi, today?: string) {
  return renderApp(api, settingsApi, today, 'cards');
}

/** 设置页：API 设置已经从这里进入，不再是首页上的可折叠面板 */
function renderSettingsApp(api: CardApi = createFakeApi(), settingsApi?: SettingsApi) {
  return renderApp(api, settingsApi, undefined, 'settings');
}

describe('空态', () => {
  it('没有历史卡片时，信息卡页显示引导文案', async () => {
    renderCardsApp(createFakeApi());
    expect(await screen.findByText('还没有信息卡')).toBeInTheDocument();
  });

  it('首页渲染通知输入模块', async () => {
    renderApp(createFakeApi());

    expect(screen.getByLabelText('通知原文')).toBeInTheDocument();
    expect(screen.getByLabelText(/本次关注点/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '生成信息卡' })).toBeInTheDocument();
    // 首页不该出现卡片列表
    expect(screen.queryByTestId('info-card')).not.toBeInTheDocument();
  });

  it('加载完成后提交按钮可用、初始为禁用', async () => {
    renderApp(createFakeApi());
    const button = screen.getByRole('button', { name: '生成信息卡' });
    expect(button).toBeDisabled();

    await userEvent.type(screen.getByLabelText('通知原文'), '一条通知');
    expect(button).toBeEnabled();
  });
});

describe('页面导航', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('首页 → 信息卡页 → 设置页，标题与内容跟着换', async () => {
    renderApp(createFakeApi({ initial: [makeCard()] }));

    // 首页有副标题，标题就是首页的视觉起点
    expect(screen.getByText('粘贴通知 → AI 提炼要点 → 生成信息卡，数据只存在本机')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^信息卡/ }));
    expect(await screen.findByText('选课开放通知')).toBeInTheDocument();
    // 切走之后副标题收起，标题退成回首页的入口
    expect(screen.queryByText('粘贴通知 → AI 提炼要点 → 生成信息卡，数据只存在本机')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(await screen.findByRole('heading', { name: 'API 调用' })).toBeInTheDocument();
    expect(screen.queryByTestId('info-card')).not.toBeInTheDocument();
  });

  it('每个页面右上角都有设置入口', async () => {
    renderApp(createFakeApi());
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: /^信息卡/ }));
    expect(screen.getByRole('button', { name: '设置' })).toBeInTheDocument();
  });

  it('点标题回到首页', async () => {
    renderSettingsApp();
    await screen.findByRole('heading', { name: 'API 调用' });

    await userEvent.click(screen.getByRole('button', { name: '信息整合台' }));
    expect(await screen.findByLabelText('通知原文')).toBeInTheDocument();
  });

  it('页面写进地址栏，刷新后停在原页面', async () => {
    const { unmount } = renderApp(createFakeApi());
    await userEvent.click(screen.getByRole('button', { name: '设置' }));
    expect(window.location.hash).toBe('#/settings');
    unmount();

    // 不设 hash 直接渲染，模拟刷新：应该还是设置页
    render(<App api={createFakeApi()} settingsApi={createFakeSettingsApi()} />);
    expect(await screen.findByRole('heading', { name: 'API 调用' })).toBeInTheDocument();
  });

  it('地址栏被改（后退键）时界面跟着换回来', async () => {
    renderSettingsApp();
    await screen.findByRole('heading', { name: 'API 调用' });

    window.location.hash = PAGE_HASHES.home;
    // jsdom 会派发 hashchange；等 React 处理完这一次更新
    expect(await screen.findByLabelText('通知原文')).toBeInTheDocument();
  });

  it('认不出来的 hash 回首页，而不是停在空白页', async () => {
    window.location.hash = '#/不存在的页面';
    render(<App api={createFakeApi()} settingsApi={createFakeSettingsApi()} />);

    expect(await screen.findByLabelText('通知原文')).toBeInTheDocument();
  });

  it('信息卡按钮上带着当前卡片数', async () => {
    renderApp(createFakeApi({ initial: [makeCard(), makeCard({ id: 'second' })] }));

    const navButton = screen.getByRole('button', { name: /^信息卡/ });
    await waitFor(() => expect(navButton).toHaveTextContent('2 张'));
  });
});

describe('生成信息卡', () => {
  it('提交原文后新卡片入库，输入框被清空', async () => {
    const api = createFakeApi({
      initial: [makeCard({ id: 'old-id', title: '历史卡片' })],
      createImpl: async () =>
        makeCard({
          id: 'new-id',
          title: '新生成的卡片',
          createdAt: '2025-03-05T08:00:00.000Z',
        }),
    });
    renderApp(api);

    const textarea = screen.getByLabelText('通知原文');
    await userEvent.type(textarea, '【教务处】选课通知');
    await userEvent.click(screen.getByRole('button', { name: '生成信息卡' }));

    expect(textarea).toHaveValue('');
    expect(api.createCard).toHaveBeenCalledWith('【教务处】选课通知', []);

    // 首页看不到卡片列表了，所以必须在这里说清楚刚生成了什么
    const result = await screen.findByRole('status');
    expect(result).toHaveTextContent('已生成信息卡《新生成的卡片》');

    await userEvent.click(screen.getByRole('button', { name: '去信息卡页查看' }));
    // 两者都没有日期，都落在"无日期"档里，此时按录入时间倒序 → 新的在前
    const titles = screen.getAllByTestId('info-card').map((card) => card.querySelector('.card__title')?.textContent);
    expect(titles).toEqual(['新生成的卡片', '历史卡片']);
  });

  it('首页没有新卡片时不显示"已生成"提示', async () => {
    renderApp(createFakeApi({ initial: [makeCard()] }));
    await waitFor(() => expect(screen.queryByTestId('info-card')).not.toBeInTheDocument());

    expect(screen.queryByText(/已生成信息卡/)).not.toBeInTheDocument();
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
    renderCardsApp(createFakeApi({ initial: [makeCard()] }));

    expect(await screen.findByText('选课开放通知')).toBeInTheDocument();
    expect(screen.getByText('教务处')).toBeInTheDocument();
    expect(screen.getByText('3月8日24:00前')).toBeInTheDocument();
    expect(screen.getByText('3月5日14:00开放选课')).toBeInTheDocument();
  });

  it('未识别来源与时间时显示"未识别"', async () => {
    renderCardsApp(createFakeApi({ initial: [makeCard({ source: null, time: null })] }));

    await screen.findByText('选课开放通知');
    expect(screen.getAllByText('未识别')).toHaveLength(2);
  });

  it('mock 摘要显示为"启发式摘要"而非"AI 摘要"', async () => {
    renderCardsApp(createFakeApi({ initial: [makeCard({ provider: 'mock' })] }));

    await screen.findByText('选课开放通知');
    const chip = document.querySelector('.chip--mock');
    expect(chip).not.toBeNull();
    expect(chip?.textContent).toBe('启发式摘要');
    expect(document.querySelector('.chip--ai')).toBeNull();
  });

  it('未配置 Key 时提示去设置里填，点提示里的入口能到设置页', async () => {
    renderApp(createFakeApi({ initial: [makeCard({ provider: 'mock' })] }));

    // 设置是异步读的，提示条要等它回来才决定显不显示
    await screen.findByText(/本地启发式摘要/);
    const notice = document.querySelector('.notice--mock');
    expect(notice).not.toBeNull();
    expect(notice?.textContent).toContain('DeepSeek API Key');

    // 提示里那个「设置页」是行内跳转，不是死文字
    await userEvent.click(screen.getByRole('button', { name: '设置页' }));
    expect(await screen.findByRole('heading', { name: 'API 调用' })).toBeInTheDocument();
  });

  it('未配置 Key 时，没有卡片也提示去配置', async () => {
    renderCardsApp(createFakeApi());

    await screen.findByText('还没有信息卡');
    expect(document.querySelector('.notice--mock')).not.toBeNull();
  });

  it('已配置 Key 时不显示 mock 提示', async () => {
    renderCardsApp(
      createFakeApi({ initial: [makeCard({ provider: 'mock' })] }),
      createFakeSettingsApi({
        initial: makeSettings({ configured: true, apiKeyMask: 'sk-1234…cdef', source: 'user' }),
      }),
    );

    await screen.findByText('选课开放通知');
    expect(document.querySelector('.notice--mock')).toBeNull();
  });

  it('没有要点的卡片给出说明而不是空白', async () => {
    renderCardsApp(createFakeApi({ initial: [makeCard({ keyPoints: [] })] }));
    expect(await screen.findByText('这条通知没有提炼出要点。')).toBeInTheDocument();
  });

  it('默认折叠原文，点击后展开', async () => {
    renderCardsApp(createFakeApi({ initial: [makeCard()] }));

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
    renderCardsApp(api);
    expect(screen.getByRole('status')).toHaveTextContent('正在读取历史信息卡…');
  });

  it('列表加载失败时展示错误提示', async () => {
    const api = createFakeApi();
    api.listCards = vi.fn(async () => {
      throw new ApiError('NETWORK_ERROR', '无法连接到本地服务，请确认服务端已启动', 0);
    });
    renderCardsApp(api);

    expect(await screen.findByRole('alert')).toHaveTextContent('无法连接到本地服务');
  });

  it('可以关闭错误提示条', async () => {
    const api = createFakeApi();
    api.listCards = vi.fn(async () => {
      throw new ApiError('NETWORK_ERROR', '连接失败', 0);
    });
    renderCardsApp(api);

    await screen.findByRole('alert');
    await userEvent.click(screen.getByRole('button', { name: '关闭提示' }));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('删除信息卡', () => {
  it('点击删除后卡片从列表移除', async () => {
    const api = createFakeApi({ initial: [makeCard()] });
    renderCardsApp(api);

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
    renderCardsApp(api);

    await screen.findByText('选课开放通知');
    await userEvent.click(screen.getByRole('button', { name: '删除信息卡：选课开放通知' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('删除失败：信息卡不存在或已被删除');
    expect(screen.getByText('选课开放通知')).toBeInTheDocument();
  });
});

describe('设置页', () => {
  it('API 表单常展开，直接显示当前模式与未配置状态', async () => {
    renderSettingsApp();

    // 设置页里再套一层"点击展开"只是多一次点击，所以表单是常展开的
    expect(await screen.findByLabelText('DeepSeek API Key')).toBeInTheDocument();
    expect(screen.getByText('未配置，正在使用本地启发式摘要')).toBeInTheDocument();
    expect(screen.getByText('未配置')).toBeInTheDocument();
  });

  it('显示已保存 Key 的掩码，输入框保持为空', async () => {
    renderSettingsApp(
      createFakeApi(),
      createFakeSettingsApi({
        initial: makeSettings({ configured: true, apiKeyMask: 'sk-abc123…cdef', source: 'user' }),
      }),
    );

    expect(await screen.findByText('sk-abc123…cdef')).toBeInTheDocument();
    // 完整 Key 不应回填到输入框
    expect(screen.getByLabelText('DeepSeek API Key')).toHaveValue('');
  });

  it('预留了「外观风格」与「开机自启」，并明确标注还没有实现', async () => {
    renderSettingsApp();

    expect(await screen.findByRole('heading', { name: '外观风格' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: '开机自启' })).toBeInTheDocument();
    // 占位项必须自己说清楚没做，不能看起来像能用的开关
    expect(screen.getAllByTestId('planned-badge')).toHaveLength(2);
    expect(screen.getByText(/米白（当前）/)).toBeInTheDocument();
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
    renderSettingsApp(createFakeApi(), settingsApi);

    await userEvent.type(screen.getByLabelText('DeepSeek API Key'), 'sk-user-key-9999');
    await userEvent.click(screen.getByRole('button', { name: '保存并验证' }));

    await waitFor(() =>
      expect(settingsApi.updateSettings).toHaveBeenCalledWith(
        expect.objectContaining({ apiKey: 'sk-user-key-9999' }),
      ),
    );
    expect(await screen.findByText('设置已保存')).toBeInTheDocument();
    // 配置好之后就不该再提示"当前是本地启发式摘要"了
    expect(document.querySelector('.notice--mock')).toBeNull();
  });

  it('保存后清空输入框，但表单留在原地（用户还要接着改别的）', async () => {
    const settingsApi = createFakeSettingsApi({
      updateImpl: async () => ({
        settings: makeSettings({ configured: true, apiKeyMask: 'sk-user…9999', source: 'user' }),
        warning: null,
      }),
    });
    renderSettingsApp(createFakeApi(), settingsApi);

    await userEvent.type(screen.getByLabelText('DeepSeek API Key'), 'sk-user-key-9999');
    await userEvent.click(screen.getByRole('button', { name: '保存并验证' }));

    await screen.findByText('设置已保存');
    // 已保存的 Key 不回填，所以输入框应该是空的——避免"看起来没保存成功"
    expect(screen.getByLabelText('DeepSeek API Key')).toHaveValue('');
  });

  it('留空保存时不提交 apiKey，避免把已有 Key 冲掉', async () => {
    const settingsApi = createFakeSettingsApi({
      initial: makeSettings({ configured: true, apiKeyMask: 'sk-abc123…cdef', source: 'user' }),
      updateImpl: async () => ({
        settings: makeSettings({ configured: true, apiKeyMask: 'sk-abc123…cdef', source: 'user' }),
        warning: null,
      }),
    });
    renderSettingsApp(createFakeApi(), settingsApi);

    await userEvent.click(await screen.findByRole('button', { name: '保存并验证' }));

    await waitFor(() => expect(settingsApi.updateSettings).toHaveBeenCalled());
    const patch = vi.mocked(settingsApi.updateSettings).mock.calls[0]?.[0];
    expect(patch).not.toHaveProperty('apiKey');
  });

  it('Key 被拒绝时留在设置页并展示服务端原因', async () => {
    const settingsApi = createFakeSettingsApi({
      updateImpl: async () => {
        throw new ApiError('INVALID_API_KEY', 'DeepSeek 拒绝了这个 API Key（HTTP 401）', 400);
      },
    });
    renderSettingsApp(createFakeApi(), settingsApi);

    await userEvent.type(screen.getByLabelText('DeepSeek API Key'), 'sk-wrong');
    await userEvent.click(screen.getByRole('button', { name: '保存并验证' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('DeepSeek 拒绝了这个 API Key');
    // 表单留在原地，用户可以直接改
    expect(screen.getByLabelText('DeepSeek API Key')).toBeInTheDocument();
  });

  it('验证无法判定时仍保存，但把原因告诉用户', async () => {
    const settingsApi = createFakeSettingsApi({
      updateImpl: async () => ({
        settings: makeSettings({ configured: true, apiKeyMask: 'sk-user…9999', source: 'user' }),
        warning: '设置已保存，但没能验证通过：调用 DeepSeek 超时（15000ms）',
      }),
    });
    renderSettingsApp(createFakeApi(), settingsApi);

    await userEvent.type(screen.getByLabelText('DeepSeek API Key'), 'sk-user-key-9999');
    await userEvent.click(screen.getByRole('button', { name: '保存并验证' }));

    expect(await screen.findByRole('status')).toHaveTextContent('没能验证通过');
  });

  it('已配置时可以清除，清除后回到未配置状态', async () => {
    const settingsApi = createFakeSettingsApi({
      initial: makeSettings({ configured: true, apiKeyMask: 'sk-abc123…cdef', source: 'user' }),
      clearImpl: async () => makeSettings({ configured: false, apiKeyMask: null, source: 'mock' }),
    });
    renderSettingsApp(createFakeApi(), settingsApi);

    await userEvent.click(await screen.findByRole('button', { name: '清除' }));

    await waitFor(() => expect(settingsApi.clearSettings).toHaveBeenCalled());
    expect(await screen.findByText('已清除保存的 Key')).toBeInTheDocument();
  });

  it('未配置时不显示清除按钮', async () => {
    renderSettingsApp();

    await screen.findByLabelText('DeepSeek API Key');
    expect(screen.queryByRole('button', { name: '清除' })).not.toBeInTheDocument();
  });

  it('Key 过长时阻止保存并提示', async () => {
    const settingsApi = createFakeSettingsApi();
    renderSettingsApp(createFakeApi(), settingsApi);

    // 直接设值，避免逐字输入 201 个字符
    const input = screen.getByLabelText('DeepSeek API Key');
    await userEvent.type(input, 'x'.repeat(201));

    expect(screen.getByText(/Key 过长/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '保存并验证' })).toBeDisabled();
    expect(settingsApi.updateSettings).not.toHaveBeenCalled();
  });

  it('服务端返回 env 来源时标注清楚', async () => {
    renderSettingsApp(
      createFakeApi(),
      createFakeSettingsApi({
        initial: makeSettings({ configured: true, apiKeyMask: 'sk-env…0001', source: 'env' }),
      }),
    );

    expect(await screen.findByText('已配置（来自环境变量）')).toBeInTheDocument();
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
    renderCardsApp(createFakeApi({ initial: [keywordCard] }));
    await screen.findByText('选课开放通知');

    const marks = document.querySelectorAll('mark.keyword-mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.textContent).toBe('报销');
  });

  it('卡头显示"含你关注的"', async () => {
    renderCardsApp(createFakeApi({ initial: [keywordCard] }));

    const chip = await screen.findByTestId('keyword-hit');
    expect(chip).toHaveTextContent('含你关注的：报销');
  });

  it('展示本次关注点全量，并说明哪些是系统补入的', async () => {
    renderCardsApp(
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
    renderCardsApp(createFakeApi({ initial: [makeCard()] }));
    await screen.findByText('选课开放通知');

    expect(document.querySelector('.card__keywords')).toBeNull();
    expect(screen.queryByTestId('keyword-hit')).not.toBeInTheDocument();
    expect(document.querySelectorAll('mark.keyword-mark')).toHaveLength(0);
  });

  it('没有任何命中的卡片不显示命中标签，但仍显示关注点', async () => {
    renderCardsApp(
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
    renderCardsApp(createFakeApi({ initial: [broken as unknown as CardView] }));

    await screen.findByText('选课开放通知');
    expect(document.querySelector('.card__keywords')).toBeNull();
    expect(document.querySelectorAll('mark.keyword-mark')).toHaveLength(0);
  });
});

const TODAY = '2026-10-02';

function sched(start: string, end: string = start): CardSchedule {
  return { start, end, dayCount: 1, label: start, inferredYear: false };
}

/** 列表当前显示顺序，只看标题 */
function visibleTitles(): string[] {
  return screen
    .getAllByTestId('info-card')
    .map((element) => element.querySelector('.card__title')?.textContent ?? '');
}

describe('列表排序', () => {
  beforeEach(() => {
    // 排序偏好存在 localStorage，用例之间必须清干净，否则互相污染
    window.localStorage.clear();
  });

  // 事件时间与录入时间刻意错开，这样两种排序的结果必然不同，
  // 只看顺序就能判断用的是哪一种，而不是撞运气撞上同一个排列
  const threeCards = () => [
    makeCard({ id: 'c-far', title: '远期通知', schedule: sched('2026-12-01'), createdAt: '2026-10-01T00:00:00.000Z' }),
    makeCard({ id: 'c-near', title: '临近通知', schedule: sched('2026-10-03'), createdAt: '2026-06-01T00:00:00.000Z' }),
    makeCard({ id: 'c-past', title: '过期通知', schedule: sched('2026-09-01'), createdAt: '2026-08-01T00:00:00.000Z' }),
  ];

  it('默认按事件时间排：临近的在前，过期的沉到下面', async () => {
    renderCardsApp(createFakeApi({ initial: threeCards() }), createFakeSettingsApi(), TODAY);
    await screen.findByText('临近通知');

    expect(visibleTitles()).toEqual(['临近通知', '远期通知', '过期通知']);
  });

  it('没有日期的卡片排在最后', async () => {
    renderCardsApp(
      createFakeApi({
        initial: [
          makeCard({ id: 'c-none', title: '没有日期', schedule: null }),
          makeCard({ id: 'c-past', title: '过期通知', schedule: sched('2026-09-01') }),
          makeCard({ id: 'c-near', title: '临近通知', schedule: sched('2026-10-03') }),
        ],
      }),
      createFakeSettingsApi(),
      TODAY,
    );
    await screen.findByText('临近通知');

    expect(visibleTitles()).toEqual(['临近通知', '过期通知', '没有日期']);
  });

  it('每张卡片都写出日程日期，排序依据可见', async () => {
    renderCardsApp(createFakeApi({ initial: threeCards() }), createFakeSettingsApi(), TODAY);
    await screen.findByText('临近通知');

    expect(screen.getAllByTestId('schedule-chip').map((chip) => chip.textContent)).toEqual([
      '日程10月3日',
      '日程12月1日',
      '日程9月1日',
    ]);
  });

  it('切到「按录入时间」后最新录入的排最前，无视事件时间', async () => {
    renderCardsApp(
      createFakeApi({
        initial: [
          makeCard({
            id: 'c-near',
            title: '临近通知',
            schedule: sched('2026-10-03'),
            createdAt: '2026-01-01T00:00:00.000Z',
          }),
          makeCard({
            id: 'c-far',
            title: '远期通知',
            schedule: sched('2026-12-01'),
            createdAt: '2026-09-30T00:00:00.000Z',
          }),
        ],
      }),
      createFakeSettingsApi(),
      TODAY,
    );
    await screen.findByText('临近通知');

    await userEvent.click(screen.getByRole('button', { name: '按录入时间' }));
    expect(visibleTitles()).toEqual(['远期通知', '临近通知']);
  });

  it('排序偏好被记住，重新挂载后仍然生效', async () => {
    const { unmount } = renderCardsApp(
      createFakeApi({ initial: threeCards() }),
      createFakeSettingsApi(),
      TODAY,
    );
    await screen.findByText('临近通知');
    await userEvent.click(screen.getByRole('button', { name: '按录入时间' }));
    unmount();

    renderCardsApp(createFakeApi({ initial: threeCards() }), createFakeSettingsApi(), TODAY);
    await screen.findByText('临近通知');

    // 按录入时间：远期通知最新录入，所以这次排在最前
    expect(visibleTitles()).toEqual(['远期通知', '过期通知', '临近通知']);
    expect(screen.getByRole('button', { name: '按录入时间' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  });

  it('工具栏写出当前排序规则，避免用户以为是随手排的', async () => {
    renderCardsApp(createFakeApi({ initial: threeCards() }), createFakeSettingsApi(), TODAY);
    await screen.findByText('临近通知');

    expect(screen.getByTestId('sort-hint')).toHaveTextContent('临近的在前');
    await userEvent.click(screen.getByRole('button', { name: '按录入时间' }));
    expect(screen.getByTestId('sort-hint')).toHaveTextContent('最新生成的排在最前');
  });

  it('已过期的卡片带「已过期」标记，跨年日程补上年份', async () => {
    renderCardsApp(
      createFakeApi({
        initial: [
          makeCard({ id: 'c-past', title: '过期通知', schedule: sched('2026-09-01') }),
          makeCard({ id: 'c-next', title: '明年通知', schedule: sched('2027-03-08') }),
        ],
      }),
      createFakeSettingsApi(),
      TODAY,
    );
    await screen.findByText('过期通知');

    // 「已过期」是排到下面那一档的原因，必须写在卡上——
    // 否则用户看见 9月1日 排在 明年3月8日 后面会以为排错了
    const expiredChips = screen.getAllByTestId('expired-chip');
    expect(expiredChips).toHaveLength(1);
    expect(screen.getByText('过期通知').closest('[data-testid="info-card"]')).toContainElement(
      expiredChips[0]!,
    );

    // 明年的日程如果不写年份，看起来和今年的一模一样
    expect(screen.getByText('明年通知').closest('[data-testid="info-card"]')).toHaveTextContent(
      '日程2027年3月8日',
    );
  });
});

describe('置顶', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('点置顶后调用接口，卡片移到列表最前并显示已置顶标记', async () => {
    const api = createFakeApi({
      initial: [
        makeCard({ id: 'c-near', title: '临近通知', schedule: sched('2026-10-03') }),
        makeCard({ id: 'c-far', title: '远期通知', schedule: sched('2026-12-01') }),
      ],
    });
    renderCardsApp(api, createFakeSettingsApi(), TODAY);
    await screen.findByText('临近通知');
    expect(visibleTitles()).toEqual(['临近通知', '远期通知']);

    await userEvent.click(screen.getByRole('button', { name: '置顶信息卡：远期通知' }));

    await waitFor(() => expect(visibleTitles()).toEqual(['远期通知', '临近通知']));
    expect(api.setPinned).toHaveBeenCalledWith('c-far', true);
    expect(screen.getByTestId('pinned-badge')).toHaveTextContent('已置顶');
  });

  it('已置顶的卡片可以取消置顶，取消后回到原来的位置', async () => {
    const api = createFakeApi({
      initial: [
        makeCard({ id: 'c-near', title: '临近通知', schedule: sched('2026-10-03') }),
        makeCard({ id: 'c-far', title: '远期通知', schedule: sched('2026-12-01'), pinned: true }),
      ],
    });
    renderCardsApp(api, createFakeSettingsApi(), TODAY);
    await screen.findByText('临近通知');
    expect(visibleTitles()).toEqual(['远期通知', '临近通知']);

    await userEvent.click(screen.getByRole('button', { name: '取消置顶信息卡：远期通知' }));

    await waitFor(() => expect(visibleTitles()).toEqual(['临近通知', '远期通知']));
    expect(api.setPinned).toHaveBeenCalledWith('c-far', false);
  });

  it('置顶失败时回滚位置并给出提示', async () => {
    const api = createFakeApi({
      initial: [
        makeCard({ id: 'c-near', title: '临近通知', schedule: sched('2026-10-03') }),
        makeCard({ id: 'c-far', title: '远期通知', schedule: sched('2026-12-01') }),
      ],
    });
    api.setPinned = vi.fn(async () => {
      throw new ApiError('CARD_NOT_FOUND', '信息卡不存在或已被删除', 404);
    });
    renderCardsApp(api, createFakeSettingsApi(), TODAY);
    await screen.findByText('临近通知');

    await userEvent.click(screen.getByRole('button', { name: '置顶信息卡：远期通知' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('置顶失败');
    // 乐观更新必须回滚，否则界面会显示一个服务端并不认可的状态
    await waitFor(() => expect(visibleTitles()).toEqual(['临近通知', '远期通知']));
    expect(screen.queryByTestId('pinned-badge')).not.toBeInTheDocument();
  });

  it('置顶不增加改动次数，也不显示已修改标记', async () => {
    const api = createFakeApi({ initial: [makeCard({ id: 'c-1', title: '通知' })] });
    renderCardsApp(api, createFakeSettingsApi(), TODAY);
    await screen.findByText('通知');

    await userEvent.click(screen.getByRole('button', { name: '置顶信息卡：通知' }));

    await waitFor(() => expect(screen.getByTestId('pinned-badge')).toBeInTheDocument());
    expect(screen.queryByTestId('edited-badge')).not.toBeInTheDocument();
  });
});

describe('新建卡片的定位', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  it('生成后进信息卡页，新卡片会被滚进视野并闪一下', async () => {
    const scrollIntoView = vi.fn();
    // jsdom 没有实现 scrollIntoView，这里补一个以验证调用
    Element.prototype.scrollIntoView = scrollIntoView;

    const api = createFakeApi({
      initial: [makeCard({ id: 'c-near', title: '已有通知', schedule: sched('2026-10-03') })],
      createImpl: async () =>
        makeCard({ id: 'c-new', title: '刚生成的通知', schedule: null, createdAt: '2026-10-02T00:00:00.000Z' }),
    });
    renderApp(api, createFakeSettingsApi(), TODAY);
    await screen.findByLabelText('通知原文');

    await userEvent.type(screen.getByLabelText('通知原文'), '一条新通知');
    await userEvent.click(screen.getByRole('button', { name: '生成信息卡' }));
    await screen.findByText(/已生成信息卡《刚生成的通知》/);

    await userEvent.click(screen.getByRole('button', { name: '去信息卡页查看' }));

    await screen.findByText('刚生成的通知');
    // 没有日期的卡片按事件时间排会沉到最下面，所以必须主动告诉用户它在哪
    expect(visibleTitles()).toEqual(['已有通知', '刚生成的通知']);
    expect(scrollIntoView).toHaveBeenCalled();

    const newCard = screen.getByText('刚生成的通知').closest('[data-testid="info-card"]');
    expect(newCard).toHaveClass('card--new');
  });
});
