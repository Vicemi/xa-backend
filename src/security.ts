// Control de acceso compartido por la API HTTP y el WebSocket: token del juego, orígenes permitidos, IP real,
// la verificación opcional de Cloudflare Access (Zero Trust) y un presupuesto de mensajes por conexión.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingHttpHeaders, IncomingMessage } from 'node:http';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { config } from './config.js';

const digest = (s: string) => createHash('sha256').update(s).digest();
const TOKEN_HASHES = config.tokens.map(digest);
const ADMIN_HASH = config.adminToken ? digest(config.adminToken) : null;

/** Comparación en tiempo constante del token compartido del juego (cualquiera de los aceptados). */
export function tokenOk(candidate: string | undefined | null): boolean {
  if (!candidate) return false;
  const h = digest(candidate);
  let ok = false;
  for (const t of TOKEN_HASHES) if (timingSafeEqual(h, t)) ok = true;   // sin salida temprana: el mismo tiempo elija el que elija
  return ok;
}

export function adminOk(candidate: string | undefined | null): boolean {
  return !!ADMIN_HASH && !!candidate && timingSafeEqual(digest(candidate), ADMIN_HASH);
}

/** Cuenta búsquedas / reanudaciones fallidas por dirección y bloquea la dirección un rato: los códigos no se pueden adivinar. */
export class JoinGuard {
  private fails = new Map<string, { n: number; first: number; until: number }>();
  blocked(ip: string): boolean {
    const f = this.fails.get(ip);
    return !!f && f.until > Date.now();
  }
  fail(ip: string): void {
    const now = Date.now();
    const f = this.fails.get(ip);
    if (!f || now - f.first > 60_000) { this.fails.set(ip, { n: 1, first: now, until: 0 }); return; }
    f.n++;
    if (f.n >= config.joinFailLimit) f.until = now + config.joinBlockMinutes * 60_000;
  }
  sweep(): void {
    const now = Date.now();
    for (const [ip, f] of this.fails) if (f.until < now && now - f.first > 60_000) this.fails.delete(ip);
  }
}
export const joinGuard = new JoinGuard();

export function tokenFromHeaders(h: IncomingHttpHeaders): string | undefined {
  const x = h['x-xa-token'];
  if (typeof x === 'string') return x;
  const a = h.authorization;
  if (typeof a === 'string' && a.startsWith('Bearer ')) return a.slice(7);
  return undefined;
}

/** El navegador no puede mandar cabeceras en un WebSocket, así que el token viaja como sub-protocolo: `new WebSocket(url, ['xa-v1', 'token.<token>'])`. */
export function tokenFromProtocols(protocols: string[]): string | undefined {
  const p = protocols.find((s) => s.startsWith('token.'));
  return p ? p.slice(6) : undefined;
}

export function originAllowed(origin: string | undefined): boolean {
  const list = config.allowedOrigins;
  if (list.includes('*')) return true;
  if (!origin) return false;   // los navegadores siempre la mandan; lo que no la manda es un script, no el juego
  return list.some((o) => o.replace(/\/$/, '') === origin);
}

/** Dirección real del cliente: la cabecera de Cloudflare cuando el servidor solo recibe tráfico por Cloudflare, si no el socket. */
export function clientIp(req: Pick<IncomingMessage, 'headers' | 'socket'>, expressIp?: string): string {
  if (config.trustCloudflare) {
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf;
  }
  return expressIp ?? req.socket.remoteAddress ?? 'unknown';
}

// ---- Cloudflare Access (opcional): valida la cabecera Cf-Access-Jwt-Assertion contra las claves públicas del equipo.
const jwks = config.cfAccessTeamDomain ? createRemoteJWKSet(new URL(`https://${config.cfAccessTeamDomain}/cdn-cgi/access/certs`)) : null;
export const accessConfigured = !!(jwks && config.cfAccessAud);

export async function accessOk(headers: IncomingHttpHeaders): Promise<boolean> {
  if (!accessConfigured || !jwks) return true;
  const raw = headers['cf-access-jwt-assertion'];
  const jwt = typeof raw === 'string' ? raw : /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(String(headers.cookie ?? ''))?.[1];
  if (!jwt) return false;
  try {
    await jwtVerify(jwt, jwks, { issuer: `https://${config.cfAccessTeamDomain}`, audience: config.cfAccessAud });
    return true;
  } catch {
    return false;
  }
}

/** Balde de fichas: `rate` mensajes por segundo con una ráfaga de `rate`. */
export class Budget {
  private tokens: number;
  private last = Date.now();
  constructor(private rate = config.wsMessagesPerSecond) { this.tokens = rate; }
  take(): boolean {
    const now = Date.now();
    this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
    this.last = now;
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}
