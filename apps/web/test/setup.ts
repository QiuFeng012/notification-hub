import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// 每个用例后卸载已渲染的组件，避免 DOM 在用例之间串味
afterEach(() => {
  cleanup();
  // 主题、排序方式这类偏好都存在 localStorage 里，
  // 不清掉的话一个用例改了主题会污染后面所有用例。
  try {
    window.localStorage.clear();
  } catch {
    // 环境不支持 localStorage 时无所谓，本来就没东西要清
  }
  document.documentElement.removeAttribute('data-theme');
  document.documentElement.removeAttribute('data-theme-mode');
});
