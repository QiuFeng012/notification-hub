import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RgbColorPicker } from '../src/components/RgbColorPicker';

function setup(value = '#b4643f') {
  const onChange = vi.fn();
  const onCommit = vi.fn();
  render(
    <RgbColorPicker label="单日颜色" value={value} onChange={onChange} onCommit={onCommit} />,
  );
  return { onChange, onCommit };
}

const channel = (name: 'R' | 'G' | 'B') => screen.getByLabelText(`单日颜色：${name} 通道`) as HTMLInputElement;
const channelNumber = (name: 'R' | 'G' | 'B') =>
  screen.getByLabelText(`单日颜色：${name} 数值`) as HTMLInputElement;
const hexInput = () => screen.getByLabelText('单日颜色：十六进制值') as HTMLInputElement;

describe('RgbColorPicker 结构', () => {
  it('渲染取色器、十六进制输入与三条通道', () => {
    setup();
    expect(screen.getByLabelText('单日颜色：打开色盘')).toBeInTheDocument();
    expect(hexInput()).toHaveValue('#b4643f');
    for (const name of ['R', 'G', 'B'] as const) {
      expect(channel(name)).toHaveValue(String(name === 'R' ? 180 : name === 'G' ? 100 : 63));
    }
  });

  it('三条滑条的值来自当前颜色', () => {
    setup('#4a7c8c');
    expect(channel('R')).toHaveValue('74');
    expect(channel('G')).toHaveValue('124');
    expect(channel('B')).toHaveValue('140');
  });

  it('滑条范围是 0-255', () => {
    setup();
    for (const name of ['R', 'G', 'B'] as const) {
      expect(channel(name)).toHaveAttribute('min', '0');
      expect(channel(name)).toHaveAttribute('max', '255');
    }
  });
});

describe('RgbColorPicker 拖动滑条', () => {
  it('拖动中只触发 onChange（预览），不触发 onCommit（保存）', async () => {
    const { onChange, onCommit } = setup();
    const slider = channel('R');

    // fireEvent 直接改 value，模拟拖动过程中的中间态
    await userEvent.click(slider);
    onChange.mockClear();
    onCommit.mockClear();

    // 用原生事件模拟拖动
    const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
      window.HTMLInputElement.prototype,
      'value',
    )?.set;
    nativeInputValueSetter?.call(slider, '200');
    slider.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onChange).toHaveBeenCalledWith('#c8643f');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('松手时触发 onCommit，把新颜色写回去', async () => {
    const { onCommit } = setup();
    const slider = channel('G');

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(slider, '255');
    slider.dispatchEvent(new Event('input', { bubbles: true }));
    fireEvent.pointerUp(slider);

    expect(onCommit).toHaveBeenCalledWith('#b4ff3f');
  });

  it('拖动 R 通道只改 R，其余通道不变', async () => {
    const { onChange } = setup('#102030');
    const slider = channel('R');

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(slider, '255');
    slider.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onChange).toHaveBeenCalledWith('#ff2030');
  });

  it('数值输入越界时被钳制', async () => {
    const { onChange } = setup('#000000');
    const number = channelNumber('R');

    // 手输 999 应被钳到 255
    await userEvent.clear(number);
    await userEvent.type(number, '999');

    const calls = onChange.mock.calls.map((call) => call[0] as string);
    expect(calls.every((hex) => /^#[0-9a-f]{6}$/.test(hex))).toBe(true);
  });
});

describe('RgbColorPicker 十六进制输入', () => {
  it('合法输入即时生效并保存', async () => {
    const { onChange, onCommit } = setup();
    const input = hexInput();

    await userEvent.clear(input);
    await userEvent.type(input, '#00ff00');

    expect(onChange).toHaveBeenCalledWith('#00ff00');
    expect(onCommit).toHaveBeenCalledWith('#00ff00');
  });

  it('接受三位简写', async () => {
    const { onCommit } = setup();
    const input = hexInput();

    await userEvent.clear(input);
    await userEvent.type(input, '#f00');

    expect(onCommit).toHaveBeenCalledWith('#ff0000');
  });

  it('非法输入标记为错误，且不写入', async () => {
    const { onChange, onCommit } = setup();
    const input = hexInput();

    await userEvent.clear(input);
    await userEvent.type(input, 'zzz');

    expect(input.className).toContain('rgb-picker__hex--error');
    expect(onChange).not.toHaveBeenCalled();
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('失焦时把非法输入拉回当前颜色', async () => {
    const { onCommit } = setup('#b4643f');
    const input = hexInput();

    await userEvent.clear(input);
    await userEvent.type(input, 'zzz');
    await userEvent.tab();

    expect(input).toHaveValue('#b4643f');
    expect(input.className).not.toContain('error');
    // 拉回是界面行为，不该被当成一次"用户改色"保存，
    // 否则每失焦一次就往接口写一遍原值。
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('外部颜色变化时同步输入框', () => {
    const { rerender } = render(
      <RgbColorPicker label="单日颜色" value="#111111" onChange={vi.fn()} onCommit={vi.fn()} />,
    );
    expect(hexInput()).toHaveValue('#111111');

    rerender(
      <RgbColorPicker label="单日颜色" value="#222222" onChange={vi.fn()} onCommit={vi.fn()} />,
    );
    expect(hexInput()).toHaveValue('#222222');
  });
});

describe('RgbColorPicker 取色器', () => {
  it('系统取色器变化时同时预览并保存', async () => {
    const { onChange, onCommit } = setup();
    const swatch = screen.getByLabelText('单日颜色：打开色盘') as HTMLInputElement;

    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    setter?.call(swatch, '#123456');
    swatch.dispatchEvent(new Event('input', { bubbles: true }));

    expect(onChange).toHaveBeenCalledWith('#123456');
    expect(onCommit).toHaveBeenCalledWith('#123456');
  });

  it('取色器初始值就是当前颜色', () => {
    setup('#4a7c8c');
    expect(screen.getByLabelText('单日颜色：打开色盘')).toHaveValue('#4a7c8c');
  });
});

