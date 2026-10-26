// Todo lo que necesita el servidor viene del entorno (un .env junto a package.json, ver .env.example).
import 'dotenv/config';

function str(name: string, def?: string): string {
  const v = process.env[name];
  if (v === undefined || v.trim() === '') {
    if (def === undefined) throw new Error(`Missing environment variable ${name} (see .env.example)`);
    return def;
  }
  return v.trim();
}
function int(name: string, def: number, min: number, max: number): number {
  const n = Number(str(name, String(def)));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}`);
  return Math.floor(n);
}
function num(name: string, def: number, min: number, max: number): number {
  const n = Number(str(name, String(def)));
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}`);
  return n;
}
function bool(name: string, def: boolean): boolean {
  return ['1', 'true', 'yes', 'on'].includes(str(name, def ? 'true' : 'false').toLowerCase());
}
function list(name: string, def: string): string[] {
  return str(name, def).split(',').map((s) => s.trim()).filter(Boolean);
}

// Un token, o varios separados por comas (rotar el token sin cortar el servicio: agregás el nuevo, actualizás el
// frontend y sacás el viejo).
const tokens = list('GAME_TOKEN', '');
if (tokens.length === 0) throw new Error('Missing environment variable GAME_TOKEN (see .env.example)');
// El token viaja como sub-protocolo del WebSocket, así que solo puede usar caracteres válidos de "token".
for (const t of tokens) if (!/^[A-Za-z0-9._-]{16,128}$/.test(t)) throw new Error('GAME_TOKEN must be 16-128 characters of A-Z a-z 0-9 . _ - (run `npm run token` to make one)');
const adminToken = str('ADMIN_TOKEN', '');
if (adminToken && !/^[A-Za-z0-9._-]{16,128}$/.test(adminToken)) throw new Error('ADMIN_TOKEN must be 16-128 characters of A-Z a-z 0-9 . _ -');

function parseIce(raw: string): unknown[] {
  try {
    const v = JSON.parse(raw);
    if (Array.isArray(v)) return v.slice(0, 8);
  } catch { /* fall through */ }
  throw new Error('ICE_SERVERS must be a JSON array such as [{"urls":"stun:stun.l.google.com:19302"}]');
}

export const config = {
  port: int('PORT', 8787, 1, 65535),
  host: str('HOST', '0.0.0.0'),
  /** Clave(s) compartida(s) que manda el frontend (PUBLIC_XA_BACKEND_TOKEN). */
  tokens,
  /** Opcional: habilita GET /api/admin/stats (cabecera x-admin-token). Vacío = desactivado. */
  adminToken,
  /** Orígenes de navegador autorizados a llamar la API / abrir el socket. `*` = cualquiera (solo desarrollo). */
  allowedOrigins: list('ALLOWED_ORIGINS', '*'),
  /** Express "trust proxy" (cantidad de proxies delante, o true/false). Detrás de Cloudflare Tunnel usá 1. */
  trustProxy: str('TRUST_PROXY', '1'),
  /** Tomar la IP real del cliente de la cabecera CF-Connecting-IP (solo cuando TODO el tráfico pasa por Cloudflare). */
  trustCloudflare: bool('TRUST_CLOUDFLARE', false),
  /** Verificación opcional del JWT de Cloudflare Access (Zero Trust). */
  cfAccessTeamDomain: str('CF_ACCESS_TEAM_DOMAIN', ''),
  cfAccessAud: str('CF_ACCESS_AUD', ''),
  cfAccessRequired: bool('CF_ACCESS_REQUIRED', false),

  maxRooms: int('MAX_ROOMS', 200, 1, 100000),
  roomIdleMinutes: int('ROOM_IDLE_MINUTES', 30, 1, 1440),
  /** Cooperativo de 1 a 4 jugadores (1 = jugar solo, como en el modo normal). */
  maxCoopPlayers: int('MAX_COOP_PLAYERS', 4, 1, 4),
  maxConnectionsPerIp: int('MAX_CONNECTIONS_PER_IP', 8, 1, 100),
  /** Salas que una dirección puede tener abiertas al mismo tiempo. */
  maxRoomsPerIp: int('MAX_ROOMS_PER_IP', 3, 1, 1000),
  /** Segundos que se guarda el asiento de quien perdió la conexión (recarga de página, corte de red). */
  reconnectGraceSeconds: int('RECONNECT_GRACE_SECONDS', 45, 5, 600),
  /** Segundos que una partida espera a un anfitrión desconectado antes de terminarse para todos. */
  hostPlayGraceSeconds: int('HOST_PLAY_GRACE_SECONDS', 12, 3, 120),
  /** Búsquedas / reanudaciones fallidas por dirección antes de bloquearla (evita adivinar códigos). */
  joinFailLimit: int('JOIN_FAIL_LIMIT', 12, 3, 1000),
  joinBlockMinutes: int('JOIN_BLOCK_MINUTES', 5, 1, 1440),
  /** Mensajes inválidos que puede mandar un cliente antes de cerrarle el socket. */
  maxStrikes: int('MAX_STRIKES', 5, 1, 100),
  httpRatePerMinute: int('HTTP_RATE_PER_MINUTE', 60, 1, 10000),
  createRoomPerMinute: int('CREATE_ROOM_PER_MINUTE', 6, 1, 1000),
  /** Mensajes por segundo por conexión (el juego manda ~30 mientras juega). */
  wsMessagesPerSecond: int('WS_MESSAGES_PER_SECOND', 90, 10, 1000),
  wsMaxPayloadBytes: int('WS_MAX_PAYLOAD_BYTES', 65536, 1024, 1048576),

  /** Ajuste de la dificultad cooperativa (el anfitrión recibe el resultado con la sala). */
  difficulty: {
    /** Cada jugador extra hace a los enemigos un poco más duros (0.10 = +10 %). */
    hpPerPlayer: num('DIFFICULTY_PER_PLAYER', 0.10, 0, 1),
    /** Enemigos extra por jugador extra (0.75: dos jugadores = 1.75x los enemigos). */
    countPerPlayer: num('ENEMY_COUNT_PER_PLAYER', 0.75, 0, 2),
    /** Vida extra de los jefes por jugador extra. */
    bossHpPerPlayer: num('BOSS_HP_PER_PLAYER', 0.5, 0, 3),
    cap: num('DIFFICULTY_CAP', 3, 1, 10),
    /** Segundos que un jugador puede estar solo antes de que la dificultad empiece a subir. */
    soloGraceSeconds: int('SOLO_GRACE_SECONDS', 25, 5, 600),
    /** Cuánto sube la dificultad por cada segundo solo pasada la gracia (1.0 = +100 % por segundo). */
    soloRampPerSecond: num('SOLO_RAMP_PER_SECOND', 0.02, 0, 1),
    /** Tope del castigo por estar solo (multiplicador de vida y cantidad). */
    soloCap: num('SOLO_PENALTY_CAP', 1.6, 1, 10),
  },
  /** STUN / TURN para que los navegadores se conecten directamente (WebRTC). JSON de RTCIceServer. */
  iceServers: parseIce(str('ICE_SERVERS', '[{"urls":"stun:stun.l.google.com:19302"},{"urls":"stun:stun.cloudflare.com:3478"}]')),
  logLevel: str('LOG_LEVEL', 'info'),
};

export type Config = typeof config;
