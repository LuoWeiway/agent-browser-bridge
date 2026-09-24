// console_monitor.js - 运行在主世界 (world: MAIN)，无感捕获页面控制台错误与未处理异常
(function () {
  if (window.__agent_console_logs_installed__) return;
  window.__agent_console_logs_installed__ = true;
  window.__agent_console_logs__ = window.__agent_console_logs__ || [];

  const MAX_LOGS = 150;

  function pushLog(level, message, extra = {}) {
    try {
      const entry = {
        timestamp: new Date().toISOString(),
        level,
        message: typeof message === 'string' ? message.slice(0, 2000) : JSON.stringify(message).slice(0, 2000),
        url: window.location.href,
        ...extra
      };
      window.__agent_console_logs__.push(entry);
      if (window.__agent_console_logs__.length > MAX_LOGS) {
        window.__agent_console_logs__.shift();
      }
    } catch (e) {}
  }

  // 1. 劫持 console.error
  const origError = console.error;
  console.error = function (...args) {
    try {
      const text = args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }).join(' ');
      pushLog('error', text);
    } catch (e) {}
    return origError.apply(console, args);
  };

  // 2. 劫持 console.warn
  const origWarn = console.warn;
  console.warn = function (...args) {
    try {
      const text = args.map(a => {
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a); } catch (e) { return String(a); }
      }).join(' ');
      pushLog('warn', text);
    } catch (e) {}
    return origWarn.apply(console, args);
  };

  // 3. 监听全局 JavaScript 运行时未捕获异常
  window.addEventListener('error', function (event) {
    pushLog('error', event.message || 'Script Error', {
      source: event.filename || '',
      lineno: event.lineno,
      colno: event.colno,
      stack: event.error && event.error.stack ? event.error.stack.slice(0, 2000) : ''
    });
  }, true);

  // 4. 监听未捕获的 Promise Rejection
  window.addEventListener('unhandledrejection', function (event) {
    const reason = event.reason;
    const msg = reason ? (reason.message || String(reason)) : 'Unhandled Promise Rejection';
    pushLog('error', msg, {
      type: 'unhandledrejection',
      stack: reason && reason.stack ? reason.stack.slice(0, 2000) : ''
    });
  }, true);
})();
