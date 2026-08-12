import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

if (import.meta.env.DEV) {
  // dev-only: expose the OPFS end-to-end engine test on window
  import('./engine/selftest').then(({ abSelfTest }) => {
    (window as unknown as { abSelfTest: typeof abSelfTest }).abSelfTest = abSelfTest;
    console.log('[ABTEST] self-test available: await window.abSelfTest()');
  });
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
