// Minimal, dependency-free logger: every API log goes through one timestamped interface
// (info/warn/error/debug), so logs can later be redirected or filtered in one place. It currently
// writes to the console; logger.debug is disabled in production.
const isProd = process.env.NODE_ENV === 'production';

const timestamp = () => new Date().toISOString();

export const logger = {
  info: (...args) => console.log(`[${timestamp()}]`, ...args),
  warn: (...args) => console.warn(`[${timestamp()}]`, ...args),
  error: (...args) => console.error(`[${timestamp()}]`, ...args),
  // Diagnostic traces (OCR steps, payloads, …): useful in development, noisy in production.
  debug: (...args) => {
    if (!isProd) console.log(`[${timestamp()}] [DEBUG]`, ...args);
  },
};
