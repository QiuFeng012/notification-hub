import { useEffect, useRef, useState } from 'react';
import {
  channelGradient,
  clampChannel,
  hexToRgb,
  isValidHex,
  parseColorInput,
  rgbToHex,
  type RgbColor,
} from '../lib/color';

const CHANNELS: Array<{ key: keyof RgbColor; label: string }> = [
  { key: 'r', label: 'R' },
  { key: 'g', label: 'G' },
  { key: 'b', label: 'B' },
];

interface RgbColorPickerProps {
  /** 当前颜色，`#rrggbb` */
  value: string;
  /**
   * 拖动过程中的实时回调（用于即时预览）。
   * 拖动时不要直接落盘——那会往接口打几十次请求。
   */
  onChange: (hex: string) => void;
  /** 松手/失焦后回调，调用方在这里真正保存 */
  onCommit: (hex: string) => void;
  /** 无障碍标签前缀，用于区分页面上多个色盘 */
  label: string;
}

/**
 * 全自定义 RGB 色盘。
 *
 * 组成：一个原生取色器（点开是系统色盘）+ 十六进制输入 + R/G/B 三条滑条。
 * 三条滑条是刻意保留的：系统色盘给不了"把 B 调到 200"这种精确控制，
 * 而调荧光笔颜色时经常需要微调到某个具体通道。
 *
 * 滑条拖动只触发 onChange（预览），松手才 onCommit（保存），
 * 避免拖动一次就往服务端写几十遍。
 */
export function RgbColorPicker({ value, onChange, onCommit, label }: RgbColorPickerProps) {
  const rgb = hexToRgb(value) ?? { r: 0, g: 0, b: 0 };
  const [hexInput, setHexInput] = useState(value);
  const [hexError, setHexError] = useState(false);
  // 外部值变化（例如选了别的卡片）时同步输入框，但不打断正在输入的内容
  const inputFocused = useRef(false);
  /**
   * 程序化重置输入框的标记。
   *
   * 受控输入在 setState 回填 value 时，浏览器仍可能补发一次 change 事件，
   * 于是失焦回滚会被当成"用户改了颜色"，把原值又提交一遍。
   * 用这个标记把程序化写入和用户输入区分开。
   */
  const isResetting = useRef(false);
  /**
   * 各通道最近一次的值。
   *
   * 滑条的 input 是受控的：onChange 之后 React 会按 state 把 value 重置回去，
   * 所以松手时再读 event.target.value 可能读到旧值。
   * 拖动过程中把最新值记在 ref 里，提交时以它为准。
   */
  const latestChannels = useRef<RgbColor>(rgb);
  latestChannels.current = rgb;
  /**
   * 本次拖动/键盘调整是否真的改动过值。
   *
   * 松手与松键都会触发提交，但键盘操作滑条时会冒出一些与本次交互无关的
   * keyup；无条件提交就会把"根本没改过"的通道值当成一次改色写回去。
   * 所以只有确实变过才提交，提交后清掉标记。
   */
  const pendingCommit = useRef(false);

  useEffect(() => {
    if (!inputFocused.current) {
      isResetting.current = true;
      setHexInput(value);
      setHexError(false);
    }
  }, [value]);

  function updateChannel(channel: keyof RgbColor, raw: string, commit: boolean) {
    const next = { ...latestChannels.current, [channel]: clampChannel(Number(raw)) };
    const hex = rgbToHex(next);
    // 值没变就别标记为待提交，避免"没改也保存"
    if (hex !== value) pendingCommit.current = true;
    latestChannels.current = next;
    onChange(hex);
    if (commit) commitChannel(channel);
  }

  /** 提交时用 ref 里的最新值，而不是可能已过期的受控值 */
  function commitChannel(channel: keyof RgbColor) {
    if (!pendingCommit.current) return;
    pendingCommit.current = false;
    onCommit(rgbToHex(latestChannels.current));
    void channel;
  }

  function applyHexInput(raw: string) {
    const parsed = parseColorInput(raw);
    const parsedHex = parsed ? rgbToHex(parsed) : null;

    setHexInput(raw);

    // 程序化回填引发的补发事件不是用户意图，必须忽略，否则失焦回滚会把原值
    // 又当成一次"用户改色"提交上去。
    // 用两个确定性判据，任一成立即忽略：
    //   1) 正处于程序化回填；
    //   2) 输入解析出的颜色与当前值完全相同——用户不可能"输入"一个与现状
    //      一模一样的颜色，这只可能来自回填。一次性标记挡不住补发的第二次事件，
    //      这条判据才挡得住。
    if (isResetting.current || (parsedHex !== null && parsedHex === value)) {
      isResetting.current = false;
      setHexError(false);
      return;
    }

    if (!parsed || parsedHex === null) {
      setHexError(raw.trim().length > 0);
      return;
    }

    setHexError(false);
    onChange(parsedHex);
    onCommit(parsedHex);
  }

  return (
    <div className="rgb-picker" data-testid="rgb-picker">
      <div className="rgb-picker__head">
        <input
          type="color"
          className="rgb-picker__swatch"
          value={value}
          aria-label={`${label}：打开色盘`}
          onChange={(event) => {
            const hex = event.target.value.toLowerCase();
            onChange(hex);
            onCommit(hex);
          }}
        />
        <input
          type="text"
          className={hexError ? 'rgb-picker__hex rgb-picker__hex--error' : 'rgb-picker__hex'}
          value={hexInput}
          spellCheck={false}
          autoComplete="off"
          aria-label={`${label}：十六进制值`}
          onFocus={() => {
            inputFocused.current = true;
          }}
          onBlur={() => {
            inputFocused.current = false;
            // 失焦时把非法输入拉回当前颜色，避免留着一个看不见的坏值。
            // 标记为程序化重置，免得这次回填被当成用户改色再提交一遍。
            if (!isValidHex(hexInput)) {
              isResetting.current = true;
              setHexInput(value);
              setHexError(false);
            }
          }}
          onChange={(event) => applyHexInput(event.target.value)}
        />
      </div>

      {CHANNELS.map(({ key, label: channelLabel }) => (
        <label key={key} className="rgb-picker__channel">
          <span className="rgb-picker__channel-name">{channelLabel}</span>
          <input
            type="range"
            className="rgb-picker__range"
            min={0}
            max={255}
            step={1}
            value={rgb[key]}
            aria-label={`${label}：${channelLabel} 通道`}
            style={{ backgroundImage: channelGradient(rgb, key) }}
            onChange={(event) => updateChannel(key, event.target.value, false)}
            // 键盘与鼠标都可能在 change 之后触发一次结束事件，
            // 用 onPointerUp + onKeyUp 覆盖两种输入方式。
            // 提交读 ref 里的最新值：受控 input 的 value 这时可能已被重置。
            onPointerUp={() => commitChannel(key)}
            onKeyUp={() => commitChannel(key)}
          />
          <input
            type="number"
            className="rgb-picker__number"
            min={0}
            max={255}
            value={rgb[key]}
            aria-label={`${label}：${channelLabel} 数值`}
            onChange={(event) => updateChannel(key, event.target.value, false)}
            onBlur={() => commitChannel(key)}
          />
        </label>
      ))}
    </div>
  );
}
