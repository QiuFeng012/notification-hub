import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// 每个用例后卸载已渲染的组件，避免 DOM 在用例之间串味
afterEach(() => {
  cleanup();
});
