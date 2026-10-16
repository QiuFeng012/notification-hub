/**
 * 界面真实交互验证：用 Chrome DevTools Protocol 驱动无头浏览器，真实点击界面按钮。
 *
 * 覆盖三条只有真跑才能确认的路径：
 *   1. 提交原文后新卡片真的出现在界面上；
 *   2. 置顶后卡片真的排到最前，并且状态真的写进了服务端；
 *   3. 删除后卡片真的从界面和服务端一起消失。
 *
 * 第 3 步尤其重要：删除走的是无 body 的 DELETE，曾经因为多带了一个
 * Content-Type 头被 Fastify 以 FST_ERR_CTP_EMPTY_JSON_BODY 拒绝，
 * 而单元测试里的 mock 不校验请求头，完全没拦住。
 *
 * 用法：先启动服务端，再执行
 *   npx tsx scripts/ui-delete-check.mts [appUrl] [cdpPort]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const appUrl = (process.argv[2] ?? 'http://127.0.0.1:5178').replace(/\/+$/, '');
const cdpPort = Number(process.argv[3] ?? 9222);

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
];

const browserPath = EDGE_CANDIDATES.find((candidate) => fs.existsSync(candidate));
if (!browserPath) {
  console.error('找不到可用的 Chromium 内核浏览器，跳过界面验证');
  process.exit(2);
}

function check(label: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  PASS  ${label}`);
    return;
  }
  console.error(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  process.exitCode = 1;
}

/**
 * 日历的列对齐检查。
 *
 * 判据是**同列必须同心**：日期圆与星期表头若不是共用同一套栅格，
 * 它们的中心就会按列线性错开——这正是那次真实缺陷的样子：
 * 表头只有 `gap: 4px`，周行另加了 `padding: 6px` 和边框，
 * 两边列宽不同，偏差按列累加（周一 +6px、周四恰好 0、**周日 -6px**），
 * 表现成"周日日期没对齐"。反过来说，只看日期之间是否等距是查不出来的，
 * 必须拿表头当基准。
 *
 * 两个刻意的实现细节：
 *   · **窗口左边框不参与比较。** 它是 Chromium 的滚动条/边框产生的固定偏移，
 *     两边都有；减掉它才不会把无关的偏移算成列错位。
 *   · **不拿"单元格宽度 + gap"当列距。** 栅格单元格的 getBoundingClientRect
 *     宽度并不等于轨道宽度（亚像素分配时 7 列会各差零点几像素），
 *     据此推算列中心会累计出好几像素的假偏差——这条检查第一版就是这么写错的。
 *     改成两边各自用最小二乘拟合出列距，再逐列比中心。
 *
 * 容差 2px：实测同心误差在 1px 内，而那个缺陷是 6px，两者拉得很开。
 *
 * 返回问题列表，空数组表示对齐。
 */
async function measureCalendarAlignment(cdp: {
  evaluate<T>(expression: string): Promise<T>;
}): Promise<string[]> {
  return cdp.evaluate<string[]>(`
    (() => {
      const problems = [];
      const labels = [...document.querySelectorAll('.calendar__weekday')];
      const rows = [...document.querySelectorAll('.calendar__week')];
      if (labels.length !== 7) return ['星期表头不是 7 列：' + labels.length];
      if (rows.length === 0) return ['没有周行'];

      const headerLeft = document.querySelector('.calendar__weekdays').getBoundingClientRect().left;
      const headerCenters = labels.map((el) => {
        const r = el.getBoundingClientRect();
        return r.left + r.width / 2 - headerLeft;
      });

      // 每一列的日期圆中心：同一列在不同周里会差零点几像素（亚像素舍入），
      // 取平均把它抹平
      const byColumn = new Map();
      for (const row of rows) {
        for (const day of row.querySelectorAll('.day-circle')) {
          const date = day.dataset.date;
          if (!date) continue;
          // 列下标按星期几：周一 = 0 … 周日 = 6（表头顺序是「一…日」）
          const column = (new Date(date + 'T00:00:00').getDay() + 6) % 7;
          const r = day.getBoundingClientRect();
          const cx = r.left + r.width / 2 - headerLeft;
          const list = byColumn.get(column) ?? [];
          list.push(cx);
          byColumn.set(column, list);
        }
      }

      const columns = [...byColumn.keys()].sort((a, b) => a - b);
      if (columns.length < 2) return ['可见的日期列不足 2 列，无法判断对齐'];
      const dayCenters = new Map(
        columns.map((column) => {
          const list = byColumn.get(column);
          return [column, list.reduce((sum, value) => sum + value, 0) / list.length];
        }),
      );

      // 最小二乘拟合 中心 = base + column * pitch，两边各拟合一次
      const fit = (pairs) => {
        const n = pairs.length;
        const sumX = pairs.reduce((s, [x]) => s + x, 0);
        const sumY = pairs.reduce((s, [, y]) => s + y, 0);
        const sumXY = pairs.reduce((s, [x, y]) => s + x * y, 0);
        const sumXX = pairs.reduce((s, [x]) => s + x * x, 0);
        const denominator = n * sumXX - sumX * sumX;
        if (denominator === 0) return { base: 0, pitch: 0 };
        const pitch = (n * sumXY - sumX * sumY) / denominator;
        return { base: (sumY - pitch * sumX) / n, pitch };
      };

      const headerFit = fit(headerCenters.map((cx, column) => [column, cx]));
      const dayFit = fit(columns.map((column) => [column, dayCenters.get(column)]));

      if (Math.abs(headerFit.pitch - dayFit.pitch) > 0.5) {
        problems.push(
          '表头与日期的列距不同：' + headerFit.pitch.toFixed(2) + ' vs ' + dayFit.pitch.toFixed(2),
        );
      }

      let worst = 0;
      let worstColumn = -1;
      for (const column of columns) {
        const expected = headerFit.base + headerFit.pitch * column;
        const actual = dayCenters.get(column);
        const delta = Math.abs(actual - expected);
        if (delta > worst) {
          worst = delta;
          worstColumn = column;
        }
      }
      if (worst > 2) {
        problems.push(
          '第 ' + (worstColumn + 1) + ' 列偏差 ' + worst.toFixed(2) + 'px（容差 2px）',
        );
      }
      return problems;
    })()
  `);
}

/**
 * 日程跑道的端头对齐检查。
 *
 * 跑道要看起来"从这天一直连到那天"，端头半圆的圆心就必须落在
 * **首末两天的日期圆心上**。把长度拆开看（实测标定过）：
 *
 *     跑道高 26（半径 13）＝ 日期圆直径
 *     跑道铺满"首列左边界 → 末列右边界"，而日期圆在列内居中
 *   ⇒ 圆心距跑道端头 = 半个**列宽** + 13
 *
 * 注意是**半个列宽**，不是半个列距：相邻两天的圆心间距含列间距（pitch = 列宽 + gap），
 * 但列边界之间只差列宽。写成 pitch/2 会算出 60.35 而不是 58.35，
 * 于是把已经精确对齐的跑道误报成偏 15px（这条检查的第三版就是这么错的）。
 *
 * 两条判据各管一件事：
 *   1. 端头位置 —— 钉住"居中"与"两端对称"；
 *   2. 跑道宽度 —— 覆盖 n 列必然等于 `(n-1)×pitch + 列宽`。
 *      它不看圆心，所以"跑道整体被改宽/改窄"一定被它抓到；
 *      而判据 1 的覆盖集合只能靠"圆心落在端头之内"来认，改窄时首末圆会落到
 *      外面、认不出来，所以两条都要。
 *
 * 列宽与列间距都从周行的 `grid-template-columns` / `column-gap` 读，
 * 不写死：不同视口下它们都会变（750px 视口是 90.7px，1280px 是 145.7px）。
 *
 * 单日圆单独量：必须与日期圆等大同心。
 *
 * 容差 1.5px：实测误差在 0.5px 内，而上面那些错法都是 15px 以上。
 */
async function measureTrackEndpoints(cdp: {
  evaluate<T>(expression: string): Promise<T>;
}): Promise<string[]> {
  return cdp.evaluate<string[]>(`
    (() => {
      const problems = [];
      const box = (el) => {
        const r = el.getBoundingClientRect();
        return { left: r.left, right: r.right, x: r.left + r.width / 2, width: r.width };
      };

      /** 列距 = 列宽 + 列间距；同时把列宽单独返回，供宽度校验用 */
      const metricsOf = (week) => {
        const style = getComputedStyle(week);
        const widths = style.gridTemplateColumns
          .split(' ')
          .map((value) => Number.parseFloat(value))
          .filter((value) => Number.isFinite(value) && value > 0);
        if (widths.length < 2) return null;
        const gap = Number.parseFloat(style.columnGap || '0');
        const column = widths.reduce((sum, value) => sum + value, 0) / widths.length;
        if (!(column > 0)) return null;
        const gapValue = Number.isFinite(gap) ? gap : 0;
        return { column, gap: gapValue, pitch: column + gapValue };
      };

      const RADIUS = 13;

      for (const span of document.querySelectorAll('[data-testid="calendar-span"].span--multi')) {
        const track = span.querySelector('.span__track');
        if (!track) { problems.push('日程缺少跑道底色层'); continue; }
        const t = box(track);
        const week = span.closest('[data-testid="calendar-week"]');
        const metrics = week ? metricsOf(week) : null;
        if (!week || !metrics) continue;
        const { column, gap, pitch } = metrics;

        /**
         * "覆盖的日期"只能看出**包含关系**，所以判据收到圆心落在端头之内。
         *
         * 这里放宽过一次，想让"跑道被改窄、首末圆落到跑道外"也能被检到，
         * 结果把旁边一天的圆也算了进来，误报 109px（实测）。
         * 改窄的缺陷由下面的宽度校验兜住——那条不需要知道覆盖哪几天。
         */
        const inside = [...week.querySelectorAll('.day-circle')]
          .map(box)
          .filter((c) => c.x >= t.left && c.x <= t.right);
        if (inside.length < 2) continue;

        const expectedLeft = inside[0].x - column / 2;
        const expectedRight = inside[inside.length - 1].x + column / 2;

        /*
         * 关系一：端头落在首列/末列的列边界上（圆心 ∓ 半列宽），
         * 而日期圆在列内居中，于是端头半圆的圆心正好套住那个圆。
         * 这条同时钉住了"跑道居中"与"两端对称"。
         */
        if (Math.abs(t.left - expectedLeft) > 1.5) {
          problems.push(
            '跑道左端偏离首日圆心 ' + (t.left - expectedLeft).toFixed(1) + 'px（实测端头 ' + t.left.toFixed(1) + '，应为 ' + expectedLeft.toFixed(1) + '）',
          );
        }
        if (Math.abs(t.right - expectedRight) > 1.5) {
          problems.push(
            '跑道右端偏离末日圆心 ' + (t.right - expectedRight).toFixed(1) + 'px（实测端头 ' + t.right.toFixed(1) + '，应为 ' + expectedRight.toFixed(1) + '）',
          );
        }

        /*
         * 关系二（独立校验）：覆盖 n 列时，宽度必然等于 (n-1)×列距 + 列宽。
         * 这条不看圆心，所以"跑道被改窄/加宽"一定被它抓到——
         * 正是上面那条判据因为误报而收窄后失去的能力。
         */
        const expectedWidth = (inside.length - 1) * pitch + column;
        if (Math.abs(t.width - expectedWidth) > 1.5) {
          problems.push(
            '跑道宽度 ' + t.width.toFixed(1) + 'px，覆盖 ' + inside.length + ' 天应为 ' + expectedWidth.toFixed(1) + 'px（列宽 ' + column.toFixed(1) + '、列距 ' + pitch.toFixed(1) + '、间距 ' + gap.toFixed(1) + '）',
          );
        }
      }

      // 单日圆：必须与日期圆同宽、同心
      for (const span of document.querySelectorAll('[data-testid="calendar-span"].span--single')) {
        const track = span.querySelector('.span__track');
        const date = span.querySelector('.visually-hidden')?.textContent;
        if (!track || !date) continue;
        const day = span.closest('[data-testid="calendar-week"]')?.querySelector('[data-date="' + date + '"]');
        if (!day) continue;
        const t = box(track);
        const d = box(day);
        if (Math.abs(t.width - d.width) > 1) {
          problems.push('单日圆的直径与日期圆不同：' + t.width.toFixed(1) + ' vs ' + d.width.toFixed(1));
        }
        if (Math.abs(t.x - d.x) > 1.5) {
          problems.push('单日圆与日期圆不同心，偏 ' + (t.x - d.x).toFixed(2) + 'px');
        }
      }

      return problems;
    })()
  `);
}

const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'notification-hub-ui-'));const browser = spawn(
  browserPath,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function findPageTarget(): Promise<string> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`http://127.0.0.1:${cdpPort}/json/list`);
      const targets = (await response.json()) as Array<{ type: string; webSocketDebuggerUrl?: string }>;
      const page = targets.find((target) => target.type === 'page' && target.webSocketDebuggerUrl);
      if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
    } catch {
      // 浏览器还没起来，继续等
    }
    await sleep(250);
  }
  throw new Error('无法连接到浏览器调试端口');
}

interface CdpMessage {
  id?: number;
  result?: { result?: { value?: unknown } };
  error?: { message: string };
}
/** 极简 CDP 客户端：只需要 Runtime.evaluate */
function createCdp(wsUrl: string) {
  const socket = new WebSocket(wsUrl);
  const pending = new Map<number, (message: CdpMessage) => void>();
  let nextId = 1;

  const ready = new Promise<void>((resolve, reject) => {
    socket.addEventListener('open', () => resolve());
    socket.addEventListener('error', () => reject(new Error('WebSocket 连接失败')));
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (typeof message.id === 'number') {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  return {
    ready,
    /** 任意 CDP 命令；用来在文档创建前注入脚本 */
    async send<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      const id = nextId;
      nextId += 1;
      const promise = new Promise<CdpMessage>((resolve) => pending.set(id, resolve));
      socket.send(JSON.stringify({ id, method, params }));
      const message = await promise;
      if (message.error) throw new Error(`${method}: ${message.error.message}`);
      return message.result as unknown as T;
    },
    async evaluate<T>(expression: string): Promise<T> {
      const id = nextId;
      nextId += 1;
      const promise = new Promise<CdpMessage>((resolve) => pending.set(id, resolve));
      socket.send(
        JSON.stringify({
          id,
          method: 'Runtime.evaluate',
          params: { expression, awaitPromise: true, returnByValue: true },
        }),
      );
      const message = await promise;
      if (message.error) throw new Error(message.error.message);
      const result = message.result?.result;
      if (result && typeof result === 'object' && 'value' in result) {
        return result.value as T;
      }
      return undefined as T;
    },
    close() {
      socket.close();
    },
  };
}

/** 同一进程内的轮询 helper，注入到页面里等待条件成立 */
const POLL_HELPER = `
window.__waitFor = async (predicate, timeoutMs = 8000) => {
  const started = Date.now();
  for (;;) {
    const value = predicate();
    if (value) return value;
    if (Date.now() - started > timeoutMs) return null;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
};
`;

async function main(): Promise<void> {
  console.log(`界面验证目标：${appUrl}`);
  console.log(`浏览器：${browserPath}\n`);

  const cdp = createCdp(await findPageTarget());
  await cdp.ready;

  await cdp.evaluate(`location.href = ${JSON.stringify(appUrl)}`);
  await sleep(1500);
  await cdp.evaluate(POLL_HELPER);

  const cardCount = () =>
    cdp.evaluate<number>(`document.querySelectorAll('[data-testid="info-card"]').length`);
  const cardIds = () =>
    cdp.evaluate<string[]>(
      `[...document.querySelectorAll('[data-testid="info-card"]')].map((el) => el.dataset.cardId)`,
    );
  /** 点页头右上角的导航按钮；返回是否找到了那个按钮 */
  const clickNav = (text: string) =>
    cdp.evaluate<boolean>(`
      (() => {
        const button = [...document.querySelectorAll('.nav-button')]
          .find((item) => item.textContent.includes(${JSON.stringify(text)}));
        if (!button) return false;
        button.click();
        return true;
      })()
    `);

  console.log('1. 首页：标题 + 通知输入模块');
  const title = await cdp.evaluate<string>(`document.querySelector('.app__title')?.textContent ?? ''`);
  check('页面标题正确', title === '信息整合台', `实际 "${title}"`);
  // 首页既可能是空 hash（直接打开根地址），也可能是 #/。
  // 不去把它改写成规范形式：那样会在历史里多插一条，
  // 用户按后退反而像是"没反应"。
  const isHome = () =>
    cdp.evaluate<boolean>(`location.hash === '' || location.hash === '#/'`);
  check('默认停在首页', await isHome(), await cdp.evaluate<string>('location.hash'));
  check('首页有通知输入模块', await cdp.evaluate<boolean>(`Boolean(document.querySelector('#raw-text'))`));
  check(
    '首页不展示卡片列表（要看得点进信息卡页）',
    (await cardCount()) === 0,
    `首页出现了 ${await cardCount()} 张卡`,
  );

  console.log('2. 页头导航：信息卡页 / 设置页 / 点标题回首页');
  check('点了「信息卡」按钮', await clickNav('信息卡'));
  await sleep(600);
  check(
    '切到信息卡页，地址栏同步',
    (await cdp.evaluate<string>('location.hash')) === '#/cards',
    await cdp.evaluate<string>('location.hash'),
  );

  const before = await cardCount();
  const beforeIds = await cardIds();
  // 一张卡都没有也能跑：脚本只动自己新建的那张，绝不碰已有数据
  console.log(`     信息卡页当前渲染 ${before} 张卡${before === 0 ? '（空库）' : ''}`);

  // ---------- 2b. 日历视图的列对齐 ----------
  // 日历此前完全没被界面验证覆盖，而"周日没对齐"正是一处纯渲染缺陷：
  // 已算出的列下标是对的，是 CSS 的盒子模型把列宽搞歪了——所以这类问题
  // 只能靠"在真实浏览器里量表头与日期的中心"来发现。
  console.log('2b. 日历视图：日期是否落在所属星期的列中心');
  check('切到「日历视图」', await cdp.evaluate<boolean>(`
    (() => {
      const tab = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('日历视图'));
      if (!tab) return false;
      tab.click();
      return true;
    })()
  `));
  await sleep(800);

  const aligned = await measureCalendarAlignment(cdp);
  check('本月各列与星期表头对齐', aligned.length === 0, aligned.join('；'));

  // 日程跑道的端头必须落在首末两天的日期圆心上（几何由 CSS 的 calc 撑起来）
  const trackProblems = await measureTrackEndpoints(cdp);
  check('日程跑道两端与首末日期圆同心', trackProblems.length === 0, trackProblems.join('；'));

  // 日历的写法（用户确定的规格）：
  //   · 表头按「一 二 三 四 五 六 日」，周一最前、周日最后
  //   · 从左往右、从上往下读，必须正好是 1、2、3… 一直到月末，不跳号不倒序
  //   · 每个日期落在它所属星期的那一列
  //
  // 第三条与第二条一起决定了切周方式：切周必须收在周日，
  // 否则像 2026 年 10 月这种「1 号是周四」的月份，第 2 行会以 5 开头、
  // 4 号被留到行尾，读出来就成了 1、2、3、5、6…、4。
  //
  // 判据全部由界面自身的数据推导，不写死具体月份——写死过一版，
  // 结果它在脚本翻到上个月之后执行时误报。
  const weekLayout = await cdp.evaluate<string>(`
    (() => {
      const weekRows = [...document.querySelectorAll('.calendar__week')];
      const title = document.querySelector('.calendar__title')?.textContent?.trim() ?? '';
      if (!/(\\d{4})\\s*年\\s*(\\d{1,2})\\s*月/.test(title)) {
        return '读不出当前月份：' + title;
      }

      const circles = weekRows.flatMap((row, rowIndex) =>
        [...row.querySelectorAll('.day-circle')].map((el) => ({ el, row, rowIndex })),
      );
      // 失败时把整月的行分布打出来，直接看清哪一行不对
      const layout = weekRows.map((row, index) => {
        const texts = [...row.querySelectorAll('.day-circle')].map((el) => el.dataset.date.slice(-2));
        return index + ':[' + texts.join(',') + ']';
      }).join(' ');

      const labels = [...document.querySelectorAll('.calendar__weekday')];
      if (labels.map((el) => el.textContent).join('') !== '一二三四五六日') {
        return '表头顺序不是「一二三四五六日」：' + labels.map((el) => el.textContent).join('');
      }
      if (circles.length === 0) return '这个月没有任何日期圆';
      if (Number(circles[0].el.textContent) !== 1) {
        return '按阅读顺序第一个不是 1 号，而是 ' + circles[0].el.textContent + '；行分布 ' + layout;
      }

      const problems = [];
      // 阅读顺序 = DOM 顺序 = 从左往右、从上往下（行内按列号排）
      let previous = 0;
      for (const entry of circles) {
        const day = Number(entry.el.textContent);
        if (day !== previous + 1) {
          problems.push('按顺序读出「' + previous + ' 后面是 ' + day + '」；行分布 ' + layout);
          break;
        }
        previous = day;
        // 该日期必须落在它所属星期的那一列（周一 = 0 … 周日 = 6）
        const expected = (new Date(entry.el.dataset.date + 'T00:00:00').getDay() + 6) % 7;
        const box = entry.el.getBoundingClientRect();
        let actual = 0;
        let best = Infinity;
        labels.forEach((label, index) => {
          const r = label.getBoundingClientRect();
          const delta = Math.abs(r.left + r.width / 2 - (box.left + box.width / 2));
          if (delta < best) { best = delta; actual = index; }
        });
        if (actual !== expected) {
          problems.push(
            day + ' 号在第 ' + actual + ' 列（表头「' + labels[actual].textContent +
            '」），但它是周' + labels[expected].textContent + '，应在第 ' + expected + ' 列',
          );
        }
        if (problems.length > 3) break;
      }

      return problems.length > 0 ? problems.join('；') : 'ok';
    })()
  `);
  check('表头一…日、按顺序读为 1…月末、日期落位正确', weekLayout === 'ok', weekLayout);

  // 换一个月再量一次：不同月份首末周的空列数不同，
  // 只测一个月有可能恰好躲过那种只在特定月出现的错位
  check('日历能翻到上个月', await cdp.evaluate<boolean>(`
    (() => {
      const previous = document.querySelector('.calendar__nav button[aria-label="上个月"]');
      if (!previous) return false;
      previous.click();
      return true;
    })()
  `));
  await sleep(700);
  const alignedPrevious = await measureCalendarAlignment(cdp);
  check('上个月各列同样对齐', alignedPrevious.length === 0, alignedPrevious.join('；'));

  // 回到卡片列表，恢复第 3 步开始时的页面状态
  check('切回「卡片列表」', await cdp.evaluate<boolean>(`
    (() => {
      const tab = [...document.querySelectorAll('button')].find((el) => el.textContent?.includes('卡片列表'));
      if (!tab) return false;
      tab.click();
      return true;
    })()
  `));
  await sleep(600);

  check('点了「设置」按钮', await clickNav('设置'));
  await sleep(600);
  const settingsState = await cdp.evaluate<string>(`
    (() => {
      const hash = location.hash;
      const api = [...document.querySelectorAll('.settings-section__title')]
        .map((item) => item.textContent);
      const planned = document.querySelectorAll('[data-testid="planned-badge"]').length;
      const hasKeyInput = Boolean(document.querySelector('#api-key-input'));
      const themeOptions = [...document.querySelectorAll('[data-theme-option]')]
        .map((el) => el.getAttribute('data-theme-option'));
      const theme = document.documentElement.getAttribute('data-theme');
      const bodyBg = getComputedStyle(document.body).backgroundColor;
      return JSON.stringify({ hash, api, planned, hasKeyInput, themeOptions, theme, bodyBg });
    })()
  `);
  const settings = JSON.parse(settingsState) as {
    hash: string;
    api: string[];
    planned: number;
    hasKeyInput: boolean;
    themeOptions: string[];
    theme: string | null;
    bodyBg: string;
  };
  check('切到设置页，地址栏同步', settings.hash === '#/settings', settings.hash);
  check('API 调用已经放进设置页', settings.hasKeyInput && settings.api.includes('API 调用'), settingsState);
  // 「外观风格」已经实现，于是只剩「开机自启」还是占位
  check('只剩「开机自启」还是占位', settings.planned === 1, `占位分组 ${settings.planned} 个`);
  check(
    '占位项明确标注了还没实现',
    await cdp.evaluate<boolean>(
      `document.body.textContent.includes('待实现') && document.body.textContent.includes('没做的原因')`,
    ),
  );

  // ---------- 外观风格：真的点一次，并核对配色真的换了 ----------
  check(
    '外观风格有三种可选主题',
    settings.themeOptions.join(',') === 'light,dark,system',
    settings.themeOptions.join(','),
  );
  check('页面带上了主题标记', settings.theme === 'light' || settings.theme === 'dark', String(settings.theme));

  const clickTheme = (name: string) =>
    cdp.evaluate<boolean>(`
      (() => {
        const option = [...document.querySelectorAll('[data-theme-option]')]
          .find((el) => el.getAttribute('data-theme-option') === ${JSON.stringify(name)});
        if (!option) return false;
        option.click();
        return true;
      })()
    `);
  const themeState = () =>
    cdp.evaluate<string>(`
      JSON.stringify({
        theme: document.documentElement.getAttribute('data-theme'),
        mode: document.documentElement.getAttribute('data-theme-mode'),
        bg: getComputedStyle(document.body).backgroundColor,
        checked: [...document.querySelectorAll('[data-theme-option][aria-checked="true"]')]
          .map((el) => el.getAttribute('data-theme-option')),
      })
    `);

  const darkShot = await (async () => {
    check('点得动「深色」', await clickTheme('dark'));
    await sleep(400);
    return JSON.parse(await themeState()) as { theme: string; mode: string; bg: string; checked: string[] };
  })();
  check('选深色后 data-theme 变成 dark', darkShot.theme === 'dark', JSON.stringify(darkShot));
  check('深色的背景色与米白不同', darkShot.bg !== settings.bodyBg, `${settings.bodyBg} -> ${darkShot.bg}`);
  check('深色按钮标为已选', darkShot.checked.join(',') === 'dark', darkShot.checked.join(','));

  check('点得动「米白」', await clickTheme('light'));
  await sleep(400);
  const lightShot = JSON.parse(await themeState()) as { theme: string; bg: string; checked: string[] };
  check('选米白后 data-theme 回到 light', lightShot.theme === 'light', JSON.stringify(lightShot));
  check('颜色真的切回去了（不是只改了按钮样式）', lightShot.bg === settings.bodyBg, `${darkShot.bg} -> ${lightShot.bg}`);

  check('点得动「跟随系统」', await clickTheme('system'));
  await sleep(400);
  const systemShot = JSON.parse(await themeState()) as { theme: string; mode: string; checked: string[] };
  // 系统是浅是深取决于这台机器，但 mode 必须是 system，且 theme 必须是解析后的两个值之一
  check('「跟随系统」记的是偏好而不是写死一个主题', systemShot.mode === 'system', JSON.stringify(systemShot));
  check(
    '「跟随系统」解析成具体主题',
    systemShot.theme === 'light' || systemShot.theme === 'dark',
    String(systemShot.theme),
  );

  // 收尾：切回米白，别把深色留给下一个看界面的人
  await clickTheme('light');
  await sleep(300);

  check('点标题回首页', await cdp.evaluate<boolean>(`
    (() => {
      const button = document.querySelector('.app__title-button');
      if (!button) return false;
      button.click();
      return true;
    })()
  `));
  await sleep(600);
  check('回到首页', await isHome(), await cdp.evaluate<string>('location.hash'));

  console.log('3. 在首页提交一条通知');
  const submitted = await cdp.evaluate<string>(`
    (async () => {
      const textarea = document.querySelector('#raw-text');
      if (!textarea) return '首页找不到输入框';
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '【界面验证】请于3月8日24:00前提交报名表，逾期不再受理。');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
      document.querySelector('.button--primary').click();
      // 首页看不到卡片列表，所以这里等的是"已生成"那行提示
      const ok = await window.__waitFor(() => document.querySelector('.home__result'));
      if (!ok) {
        const alert = document.querySelector('[role="alert"]');
        return 'failed: ' + (alert ? alert.textContent : '没有出现生成结果提示');
      }
      return document.querySelector('.home__result').textContent;
    })()
  `);
  check('提交后首页给出「已生成」反馈', submitted.startsWith('已生成信息卡'), submitted);

  console.log('4. 从反馈进信息卡页，确认新卡片在列表里');
  check('点了「去信息卡页查看」', await cdp.evaluate<boolean>(`
    (() => {
      const button = [...document.querySelectorAll('.home__result button')]
        .find((item) => item.textContent.trim() === '去信息卡页查看');
      if (!button) return false;
      button.click();
      return true;
    })()
  `));
  await sleep(800);
  check(
    '进到信息卡页',
    (await cdp.evaluate<string>('location.hash')) === '#/cards',
    await cdp.evaluate<string>('location.hash'),
  );

  const afterSubmit = await cardCount();
  check('卡片数 +1', afterSubmit === before + 1, `${before} -> ${afterSubmit}`);
  console.log(`     现在渲染 ${afterSubmit} 张卡`);

  // 列表是按事件时间排的，新卡片不一定在第一张，
  // 所以先算出它的 id，后面所有操作都按 id 定位，绝不靠"第几张"。
  const knownIds: string[] = beforeIds;
  const newId = (await cardIds()).find((id) => !knownIds.includes(id)) ?? null;
  check('能定位到刚生成的卡片', typeof newId === 'string' && newId.length > 0, `实际 ${String(newId)}`);

  const selector = `[data-card-id="${newId}"]`;

  console.log('5. 点击新卡片上的「置顶」按钮');
  const pinResult = await cdp.evaluate<string>(`
    (async () => {
      const card = document.querySelector(${JSON.stringify(selector)});
      if (!card) return 'card-not-found';
      const button = [...card.querySelectorAll('button')].find((item) => item.textContent.trim() === '置顶');
      if (!button) return 'pin-button-not-found';
      button.click();
      const ok = await window.__waitFor(() => {
        const first = document.querySelector('[data-testid="info-card"]');
        if (!first || first.dataset.cardId !== ${JSON.stringify(newId)}) return false;
        return Boolean(first.querySelector('[data-testid="pinned-badge"]'));
      });
      return ok ? 'ok' : '卡片没有移到最前或没有置顶标记';
    })()
  `);
  check('置顶后卡片排到列表最前并显示已置顶', pinResult === 'ok', pinResult);

  const serverCards = await fetch(`${appUrl}/api/cards`)
    .then((response) => response.json() as Promise<{ cards: Array<{ id: string; pinned: boolean }> }>)
    .catch(() => null);
  check(
    '置顶状态真的写进了服务端（不是只改了界面）',
    serverCards?.cards.find((card) => card.id === newId)?.pinned === true,
    JSON.stringify(serverCards?.cards.find((card) => card.id === newId)),
  );

  console.log('6. 再点一次「取消置顶」');
  const unpinResult = await cdp.evaluate<string>(`
    (async () => {
      const card = document.querySelector(${JSON.stringify(selector)});
      if (!card) return 'card-not-found';
      const button = [...card.querySelectorAll('button')].find((item) => item.textContent.trim() === '取消置顶');
      if (!button) return 'unpin-button-not-found';
      button.click();
      const ok = await window.__waitFor(() => {
        const current = document.querySelector(${JSON.stringify(selector)});
        return current && !current.querySelector('[data-testid="pinned-badge"]');
      });
      return ok ? 'ok' : '置顶标记没有消失';
    })()
  `);
  check('取消置顶后标记消失', unpinResult === 'ok', unpinResult);

  console.log('7. 切换排序方式');
  const sortResult = await cdp.evaluate<string>(`
    (async () => {
      const tab = [...document.querySelectorAll('.sort-tab')]
        .find((item) => item.textContent.trim() === '按录入时间');
      if (!tab) return 'sort-tab-not-found';
      tab.click();
      const ok = await window.__waitFor(() =>
        tab.getAttribute('aria-pressed') === 'true'
        && (document.querySelector('[data-testid="sort-hint"]')?.textContent ?? '').includes('最新生成'));
      if (ok) {
        const back = [...document.querySelectorAll('.sort-tab')]
          .find((item) => item.textContent.trim() === '按事件时间');
        back.click();
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      return ok ? 'ok' : '切换后按钮状态或规则说明没更新';
    })()
  `);
  check('可以切到「按录入时间」并回到「按事件时间」', sortResult === 'ok', sortResult);

  console.log('8. 点击新卡片的「删除」按钮');
  const deleteResult = await cdp.evaluate<string>(`
    (async () => {
      const card = document.querySelector(${JSON.stringify(selector)});
      if (!card) return 'card-not-found';
      const button = [...card.querySelectorAll('button')].find((item) => item.textContent.trim() === '删除');
      if (!button) return 'not-found';
      button.click();
      const ok = await window.__waitFor(() =>
        document.querySelectorAll('[data-testid="info-card"]').length === ${before});
      if (!ok) {
        const alert = document.querySelector('[role="alert"]');
        return 'failed: ' + (alert ? alert.textContent : '卡片数量未恢复');
      }
      return 'ok';
    })()
  `);
  check('删除后卡片从界面消失', deleteResult === 'ok', deleteResult);
  check('删除过程没有报错提示', !deleteResult.startsWith('failed'));

  const finalCount = await cardCount();
  check('卡片数回到提交前', finalCount === before, `期望 ${before}，实际 ${finalCount}`);
  const finalIds = await cardIds();
  check(
    '其他卡片一张都没被误删',
    beforeIds.every((id) => finalIds.includes(id)),
    `期望保留 ${beforeIds.join(', ')}，实际 ${finalIds.join(', ')}`,
  );

  console.log('9. 核对服务端数据已同步删除');
  const serverTotal = await fetch(`${appUrl}/api/cards`)
    .then((response) => response.json() as Promise<{ total: number }>)
    .then((body) => body.total)
    .catch(() => -1);
  check('服务端条数与界面一致', serverTotal === finalCount, `服务端 ${serverTotal}，界面 ${finalCount}`);

  // 放在最后：这几条只读静态资源与浏览器状态，不碰卡片数据
  console.log('10. PWA：manifest、service worker 与缓存边界');
  const manifestResult = await cdp.evaluate<string>(`
    (async () => {
      const link = document.querySelector('link[rel="manifest"]');
      if (!link) return '页面没有挂 manifest';
      const response = await fetch(link.getAttribute('href'));
      if (!response.ok) return 'manifest HTTP ' + response.status;
      const manifest = await response.json();
      if (!manifest.name || !manifest.start_url || manifest.display !== 'standalone') {
        return 'manifest 缺字段：' + JSON.stringify({ name: manifest.name, start_url: manifest.start_url, display: manifest.display });
      }
      const sizes = (manifest.icons || []).map((icon) => icon.sizes);
      if (!sizes.includes('192x192') || !sizes.includes('512x512')) return '图标尺寸不全：' + sizes.join(',');
      return 'ok';
    })()
  `);
  check('页面取到的 manifest 满足 Chromium 的安装条件', manifestResult === 'ok', manifestResult);

  // 再问浏览器一遍：它自己解析出来的 manifest 有没有报错。
  // 这条比人工核对字段更接近真相——解析规则、图标尺寸、字段合法性都由它判定。
  //
  // 这里本来想验 beforeinstallprompt（浏览器认定可安装时才发），实测无头模式
  // 下它不触发：安装引导是纯 UI 功能，无头浏览器不跑它。留一条永远为假的断言
  // 比不写还糟，所以改用 getAppManifest。
  const appManifest = await cdp.send<{ errors?: unknown[]; data?: string }>('Page.getAppManifest');
  const manifestErrors = appManifest.errors ?? [];
  check(
    '浏览器解析 manifest 没有报错',
    manifestErrors.length === 0,
    JSON.stringify(manifestErrors),
  );
  check('浏览器确实拿到了 manifest 内容', (appManifest.data ?? '').includes('信息整合台'));

  const workerResult = await cdp.evaluate<string>(`
    (async () => {
      if (!('serviceWorker' in navigator)) return '浏览器不支持 service worker';
      const registration = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((resolve) => setTimeout(() => resolve(null), 8000)),
      ]);
      if (!registration) return 'service worker 8 秒内没有就绪';
      if (!registration.active) return '注册了但没有 active worker';
      const expected = new URL('/sw.js', location.origin).href;
      if (registration.active.scriptURL !== expected) return '脚本地址不对：' + registration.active.scriptURL;
      if (!navigator.serviceWorker.controller) return '已安装但当前页面没有被它接管';
      return 'ok';
    })()
  `);
  check('service worker 已注册、已激活并接管当前页面', workerResult === 'ok', workerResult);

  const cacheResult = await cdp.evaluate<string>(`
    (async () => {
      const names = await caches.keys();
      if (names.length !== 1) return '缓存桶数量不对：' + JSON.stringify(names);
      const cache = await caches.open(names[0]);
      const requests = await cache.keys();
      return JSON.stringify(requests.map((request) => new URL(request.url).pathname).sort());
    })()
  `);
  // 这条是这次改动最要紧的约束：一个字节的应用代码都不许进缓存，
  // 否则重新构建之后打开的还是旧界面，而且旧到让人以为改动没生效
  check(
    '缓存里只有那张离线说明页，没有任何应用代码',
    cacheResult === JSON.stringify(['/offline.html']),
    cacheResult,
  );

  // 这里**故意不**验证"服务停了之后 service worker 交出说明页"那一条，两个原因：
  //
  //   1. 那条路径要求真的把服务停掉再拉起来。让这个脚本去管服务生命周期，
  //      既会动用户正在跑的服务，又让验证本身变得不稳（实测出现过卡住不返回）。
  //      启停是 verify-launcher 的职责，两边都碰就会分叉——项目里已经有过教训。
  //   2. CDP 的 Network.emulateNetworkConditions({offline:true}) 试过了，不能用：
  //      它在请求到达 service worker 之前就把导航掐掉，页面变成浏览器错误页，
  //      看上去"验过了一条类似的检查"，其实根本没走到要验的那段代码。
  //
  // 所以那条留在人工核对里（README「验证」一节写了步骤），
  // 离线回落的**逻辑**由 test/service-worker.test.ts 真跑 sw.js 源码覆盖，
  // 缓存的**边界**由上面这条断言在真实浏览器里覆盖。

  console.log(process.exitCode === 1 ? '\n界面验证失败' : '\n界面验证全部通过');
  cdp.close();
}

try {
  await main();
} finally {
  browser.kill();
  await sleep(300);
  fs.rmSync(profileDir, { recursive: true, force: true });
}
