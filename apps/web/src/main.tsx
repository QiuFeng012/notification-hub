import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('找不到 #root 挂载点');
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

/**
 * 注册 service worker，只为「服务没在跑」时能显示一张说明页（见 public/sw.js）。
 *
 * 只在生产构建里注册：开发态是 Vite 的 5173，注册之后那个 service worker
 * 会留在浏览器里继续接管导航，出现"改了代码没反应"，排查起来非常费劲。
 */
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      // 注册失败最多是少了那张说明页，不该影响应用本身
      console.warn('service worker 注册失败，服务未启动时将显示浏览器的默认错误页', error);
    });
  });
}
