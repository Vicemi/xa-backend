// La API HTTP, escrita con Elysia (rutas tipadas y validadas) y montada dentro de Express (ver http.ts).
import { Elysia } from 'elysia';
import { config } from './config.js';
import { COLORS } from './game.js';
import { CodeParams, CreateRoomBody } from './protocol.js';
import { maxPlayers, type Rooms } from './rooms.js';
import { adminOk, joinGuard, tokenFromHeaders, tokenOk } from './security.js';

/** Express pone la dirección real del cliente acá (y pisa lo que el cliente haya mandado con ese nombre). */
export const IP_HEADER = 'x-xa-client-ip';

export interface Runtime { connections(): number; startedAt: number }

export function buildApi(rooms: Rooms, runtime: Runtime) {
  const ipOf = (request: Request) => request.headers.get(IP_HEADER) ?? 'unknown';
  return new Elysia()
    // /health es pública (sonda, sin datos); todo lo demás necesita el token del juego
    .get('/health', () => ({ ok: true, rooms: rooms.size, uptime: Math.round(process.uptime()) }))
    .group('/api', (app) =>
      app
        .onBeforeHandle(({ request, set }) => {
          const h: Record<string, string> = {};
          request.headers.forEach((v, k) => { h[k] = v; });
          if (!tokenOk(tokenFromHeaders(h))) { set.status = 401; return { error: 'unauthorized' }; }
        })
        // lo que el frontend necesita saber de este servidor
        .get('/info', () => ({
          name: 'xa-backend', protocol: 1, mode: 'coop',
          colors: COLORS,
          limits: { coop: maxPlayers() },
          reconnectGraceSeconds: config.reconnectGraceSeconds,
          iceServers: config.iceServers,
          difficulty: config.difficulty,
        }))
        // crea una sala: devuelve su código (el que se comparte) y la clave que prueba quién es el anfitrión
        .post('/rooms', ({ set, request }) => {
          const ip = ipOf(request);
          if (joinGuard.blocked(ip)) { set.status = 429; return { error: 'blocked' }; }
          const r = rooms.create(ip);
          if (typeof r === 'string') { set.status = 503; return { error: r }; }
          return { code: r.room.code, hostKey: r.hostKey, max: maxPlayers() };
        }, { body: CreateRoomBody })
        // ¿se puede entrar a esta sala? (se comprueba antes de abrir el socket). Adivinar códigos bloquea la dirección un rato.
        .get('/rooms/:code', ({ params, set, request }) => {
          const ip = ipOf(request);
          if (joinGuard.blocked(ip)) { set.status = 429; return { error: 'blocked' }; }
          const room = rooms.get(params.code);
          if (!room) { joinGuard.fail(ip); set.status = 404; return { error: 'not_found' }; }
          const free = room.players.size < maxPlayers();
          return { code: room.code, status: room.status, players: room.players.size, max: maxPlayers(), joinable: room.status === 'lobby' && free };
        }, { params: CodeParams })
        // contadores para monitoreo (sin datos personales); solo con ADMIN_TOKEN y la cabecera x-admin-token
        .get('/admin/stats', ({ request, set }) => {
          if (!adminOk(request.headers.get('x-admin-token'))) { set.status = 404; return { error: 'not_found' }; }
          return { ...rooms.stats(), sockets: runtime.connections(), uptime: Math.round((Date.now() - runtime.startedAt) / 1000), memoryMb: Math.round(process.memoryUsage().rss / 1048576) };
        }),
    )
    .onError(({ code, set }) => {
      if (code === 'VALIDATION') { set.status = 422; return { error: 'invalid_request' }; }
      if (code === 'NOT_FOUND') { set.status = 404; return { error: 'not_found' }; }
      set.status = 500;
      return { error: 'server_error' };
    });
}
