/**
 * A logger that logs nothing, for suites that bundle a module which imports
 * pino for one warning it will never emit.
 *
 * Bundling the real one is harmless but noisy — it writes to stdout in the
 * middle of a check list — and stubbing it keeps the suite's output the only
 * thing on screen.
 */
const noop = () => {};
const logger = { info: noop, warn: noop, error: noop, debug: noop, fatal: noop, trace: noop };
logger.child = () => logger;
export default () => logger;
