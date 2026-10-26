import { config } from './config.js';

const levels = ['debug', 'info', 'warn', 'error'];
const min = Math.max(0, levels.indexOf(config.logLevel));
const out = (lvl: number, ...a: unknown[]) => { if (lvl >= min) (lvl >= 2 ? console.error : console.log)(new Date().toISOString(), levels[lvl]!.toUpperCase(), ...a); };

export const log = {
  debug: (...a: unknown[]) => out(0, ...a),
  info: (...a: unknown[]) => out(1, ...a),
  warn: (...a: unknown[]) => out(2, ...a),
  error: (...a: unknown[]) => out(3, ...a),
};
