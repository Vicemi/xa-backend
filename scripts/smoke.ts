// Prueba de punta a punta: arranca el servidor y hace de anfitrión e invitados.   npm test
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import WebSocket from 'ws';

const PORT = 18787;
const TOKEN = 'smoke-test-token-0123456789';
const OLD_TOKEN = 'smoke-old-token-0123456789';
const ADMIN = 'smoke-admin-token-0123456789';
const ORIGIN = 'http://localhost:4321';
const base = `http://127.0.0.1:${PORT}`;
const env = {
  ...process.env, PORT: String(PORT), GAME_TOKEN: `${TOKEN},${OLD_TOKEN}`, ADMIN_TOKEN: ADMIN, ALLOWED_ORIGINS: ORIGIN, TRUST_PROXY: '0', LOG_LEVEL: 'warn',
  CREATE_ROOM_PER_MINUTE: '100', HTTP_RATE_PER_MINUTE: '1000', WS_MESSAGES_PER_SECOND: '100', MAX_CONNECTIONS_PER_IP: '100', MAX_ROOMS_PER_IP: '40',
  RECONNECT_GRACE_SECONDS: '5', HOST_PLAY_GRACE_SECONDS: '3', JOIN_FAIL_LIMIT: '12', MAX_STRIKES: '5',
};
const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], { env, stdio: ['ignore', 'inherit', 'inherit'] });

let fails = 0;
const check = (ok: boolean, what: string) => { console.log(`${ok ? '  ok  ' : ' FAIL '} ${what}`); if (!ok) fails++; };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const api = (path: string, init: RequestInit & { token?: string | null; origin?: string | null; headers2?: Record<string, string> } = {}) => {
  const headers: Record<string, string> = { 'content-type': 'application/json', ...(init.headers2 ?? {}) };
  if (init.token !== null) headers['x-xa-token'] = init.token ?? TOKEN;
  if (init.origin !== null) headers.origin = init.origin ?? ORIGIN;
  return fetch(base + path, { ...init, headers });
};

type Msg = { t: string; [k: string]: any };
class Client {
  ws: WebSocket;
  inbox: Msg[] = [];
  closed: number | null = null;
  constructor(origin = ORIGIN, token = TOKEN) {
    this.ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, ['xa-v1', 'token.' + token], { headers: { origin } });
    this.ws.on('message', (d) => this.inbox.push(JSON.parse(d.toString())));
    this.ws.on('close', (code) => { this.closed = code; });
  }
  ready() { return once(this.ws, 'open'); }
  send(m: unknown) { this.ws.send(JSON.stringify(m)); }
  async wait(t: string, ms = 2000, pred: (m: Msg) => boolean = () => true): Promise<Msg> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const i = this.inbox.findIndex((m) => m.t === t && pred(m));
      if (i >= 0) return this.inbox.splice(i, 1)[0]!;
      await sleep(10);
    }
    throw new Error('timeout waiting for ' + t);
  }
  has(t: string, pred: (m: Msg) => boolean = () => true) { return this.inbox.some((m) => m.t === t && pred(m)); }
}
const mk = async (code: string, name: string, key?: string) => {
  const c = new Client(); await c.ready();
  c.send({ t: 'join', code, name, key });
  const j = await c.wait('joined');
  return { c, j };
};
const room = async () => (await (await api('/api/rooms', { method: 'POST', body: '{}' })).json()) as any;

async function main() {
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/health')).ok) break; } catch { /* starting */ } await sleep(100); }

  console.log('HTTP');
  check((await api('/health', { token: null, origin: null })).status === 200, 'GET /health es público');
  check((await api('/api/info', { token: null })).status === 401, 'API sin token -> 401');
  check((await api('/api/info', { token: 'wrong-token-wrong-token' })).status === 401, 'API con token incorrecto -> 401');
  check((await api('/api/info', { token: OLD_TOKEN })).status === 200, 'un segundo token (viejo) también se acepta: se puede rotar');
  check((await api('/api/info', { origin: 'https://evil.example' })).status === 403, 'API desde otro origen -> 403');
  const info = await (await api('/api/info')).json() as any;
  check(Array.isArray(info.colors) && info.colors.length === 8, 'GET /api/info lista 8 colores de jugador');
  check(Array.isArray(info.iceServers) && info.iceServers.length >= 1, 'GET /api/info lista los servidores STUN para conexión directa');
  check(info.limits.coop === 4 && info.mode === 'coop', 'GET /api/info: coop de hasta 4');
  check((await api('/api/rooms', { method: 'POST', body: 'not json' })).status >= 400, 'POST /api/rooms rechaza un cuerpo inválido');
  const created = await room();
  check(/^[A-Z2-9]{5}$/.test(created.code) && created.hostKey.length === 48, `sala creada con código ${created.code}`);
  check((await (await api('/api/rooms/' + created.code)).json() as any).joinable === true, 'GET /api/rooms/:code dice que se puede entrar');
  check((await api('/api/rooms/ZZZZZ')).status === 404, 'sala desconocida -> 404');
  check((await api('/api/admin/stats')).status === 404, 'las estadísticas necesitan el token de administración');
  const st = await (await api('/api/admin/stats', { headers2: { 'x-admin-token': ADMIN } })).json() as any;
  check(st.rooms >= 1 && typeof st.sockets === 'number', 'estadísticas con el token de administración');

  console.log('WebSocket');
  const bad = new Client(ORIGIN, 'wrong-token-wrong-token');
  check(await new Promise((res) => { bad.ws.on('unexpected-response', (_q, r) => res(r.statusCode === 401)); bad.ws.on('open', () => res(false)); }), 'socket con token incorrecto rechazado (401)');
  const evil = new Client('https://evil.example');
  check(await new Promise((res) => { evil.ws.on('unexpected-response', (_q, r) => res(r.statusCode === 403)); evil.ws.on('open', () => res(false)); }), 'socket desde otro origen rechazado (403)');

  const host = new Client(); await host.ready();
  host.send({ t: 'join', code: created.code, name: '  Host<script>  ', key: created.hostKey });
  const hj = await host.wait('joined');
  check(hj.host === true && hj.room.players[0].name === 'Hostscript' && /^[0-9a-f]{48}$/.test(hj.sid), 'el anfitrión entra con la clave; apodo limpio (máx. 10) y sesión');
  const hostColor = hj.room.players[0].color as number;
  check(hostColor === 0 && hj.room.stage === 'lobby', 'el anfitrión tiene el color 0 (original, sin tinte)');

  const g1 = new Client(); await g1.ready();
  g1.send({ t: 'join', code: created.code, name: 'Ana' });
  const g1j = await g1.wait('joined');
  check(g1j.host === false && g1j.you === 1, 'entra un invitado');
  check(g1j.room.players[1].color !== hostColor, 'cada jugador recibe un color distinto');
  g1.inbox.length = 0;
  g1.send({ t: 'color', color: hostColor });
  check((await g1.wait('error')).code === 'taken', 'un color ocupado no se puede elegir');
  const freeColor = [0, 1, 2, 3, 4, 5, 6, 7].find((i) => i !== hostColor && i !== g1j.room.players[1].color)!;
  host.inbox.length = 0;
  g1.send({ t: 'color', color: freeColor });
  const cv = await host.wait('room', 2000, (m) => m.room.players.find((p: any) => p.id === 1)?.color === freeColor);
  check(cv.room.players[1].color === freeColor, 'un color libre sí se puede elegir');

  console.log('Lobby');
  g1.send({ t: 'level', level: 5 });
  check((await g1.wait('error')).code === 'forbidden', 'un invitado no elige el nivel');
  g1.send({ t: 'vote', level: 5 });
  const voted = await host.wait('room', 2000, (m) => m.room.votes.some((v: any) => v.id === 1 && v.level === 5));
  check(!!voted, 'un invitado puede votar un nivel');
  g1.send({ t: 'settings', powerups: false });
  check((await g1.wait('error')).code === 'forbidden', 'un invitado no cambia los ajustes');
  host.send({ t: 'settings', powerups: true });
  const sv = await host.wait('room', 2000, (m) => m.room.settings.powerups === true);
  check(sv.room.settings.powerups === true, 'el anfitrión activa los power-ups de los niveles originales');
  host.send({ t: 'start' });
  check((await host.wait('error')).code === 'not_ready', 'no se puede empezar sin nivel elegido ni todos listos');
  host.send({ t: 'level', level: 0 });
  await sleep(50);
  g1.send({ t: 'ready', ready: true });
  await sleep(100);
  host.send({ t: 'start' });
  check((await host.wait('error')).code === 'not_ready', 'tampoco sin nivel elegido');
  host.send({ t: 'level', level: 2 });
  await sleep(100);
  g1.send({ t: 'ready', ready: false });
  await sleep(100);
  host.send({ t: 'start' });
  check((await host.wait('error')).code === 'not_ready', 'tampoco si alguien no está listo');
  g1.send({ t: 'ready', ready: true });
  await sleep(100);
  host.inbox.length = 0;
  host.send({ t: 'start' });
  const start = await host.wait('start');
  check(start.room.players.length === 2 && start.difficulty.players === 2 && start.level === 2, `empieza el coop: dificultad ${JSON.stringify(start.difficulty)}`);

  console.log('Partida');
  g1.send({ t: 'in', d: { b: 3, q: 7 } });
  const inp = await host.wait('in');
  check(inp.from === 1 && inp.d.b === 3 && inp.d.q === 7, 'los controles del invitado llegan al anfitrión');
  g1.send({ t: 'in', d: { b: 999, q: 0 } });
  check((await g1.wait('error')).code === 'invalid', 'un control fuera de rango se rechaza');
  host.send({ t: 'snap', d: { h: [{ i: 0, x: 1, y: 2 }] } });
  check((await g1.wait('snap')).d.h.length === 1, 'la instantánea del anfitrión llega al invitado');
  g1.send({ t: 'snap', d: { evil: true } });
  await sleep(120);
  check(!host.inbox.some((m) => m.t === 'snap'), 'un invitado no puede mandar instantáneas');
  g1.send({ t: 'rtc', to: 0, d: { k: 'offer', s: 'v=0 sdp falso' } });
  const rtc1 = await host.wait('rtc');
  host.send({ t: 'rtc', to: 1, d: { k: 'answer', s: 'v=0 respuesta' } });
  const rtc2 = await g1.wait('rtc');
  check(rtc1.from === 1 && rtc1.d.k === 'offer' && rtc2.from === 0 && rtc2.d.k === 'answer', 'la señalización WebRTC va y vuelve entre anfitrión e invitado');
  g1.send({ t: 'rtc', to: 1, d: { k: 'ice', c: { candidate: 'x' } } });
  await sleep(120);
  check(!g1.has('rtc'), 'un invitado no puede señalarse a sí mismo');
  const late = new Client(); await late.ready();
  late.send({ t: 'join', code: created.code, name: 'Tarde' });
  check((await late.wait('error')).code === 'started', 'nadie nuevo entra a una partida en curso');

  console.log('Sesiones');
  const sid = g1j.sid as string;
  g1.ws.terminate();
  check((await host.wait('peer', 2000, (m) => m.online === false)).id === 1, 'el anfitrión se entera de que un invitado se cortó');
  const back = new Client(); await back.ready();
  back.send({ t: 'resume', code: created.code, sid });
  const rj = await back.wait('joined');
  check(rj.resumed === true && rj.you === 1 && rj.room.status === 'playing', 'el invitado vuelve a su asiento en plena partida');
  check((await host.wait('peer', 2000, (m) => m.online === true)).id === 1, 'el anfitrión se entera de que volvió');
  const wrong = new Client(); await wrong.ready();
  wrong.send({ t: 'resume', code: created.code, sid: '0'.repeat(48) });
  check((await wrong.wait('error')).code === 'bad_session', 'reanudar con un identificador incorrecto se rechaza');

  // el anfitrión se corta: la partida se termina para todos
  const hostSid = hj.sid as string;
  host.ws.terminate();
  const aborted = await back.wait('ended', 8000);
  check(aborted.d.aborted === true, 'una partida cuyo anfitrión se perdió se termina para todos');
  const host2 = new Client(); await host2.ready();
  host2.send({ t: 'resume', code: created.code, sid: hostSid });
  const h2 = await host2.wait('joined');
  check(h2.host === true && h2.room.status === 'lobby', 'el anfitrión vuelve (como anfitrión) al lobby');

  console.log('Solo y límite');
  const solo = await room();
  const sh = await mk(solo.code, 'Solo', solo.hostKey);
  sh.c.send({ t: 'level', level: 1 });
  await sleep(50);
  sh.c.send({ t: 'start' });
  const soloStart = await sh.c.wait('start');
  check(soloStart.difficulty.players === 1, 'se puede jugar solo (1 jugador)');
  sh.c.send({ t: 'end' });
  await sh.c.wait('ended');
  sh.c.send({ t: 'start' });
  check((await sh.c.wait('start')).room.players.length === 1, 'solo también puede volver a empezar');

  const big = await room();
  const bh = await mk(big.code, 'Uno', big.hostKey);
  const guests: Client[] = [];
  for (let i = 0; i < 3; i++) { const c = new Client(); await c.ready(); c.send({ t: 'join', code: big.code, name: 'P' + i }); await c.wait('joined'); guests.push(c); }
  const fifth = new Client(); await fifth.ready();
  fifth.send({ t: 'join', code: big.code, name: 'Cinco' });
  check((await fifth.wait('error')).code === 'full', 'el coop es de 4 como máximo: el quinto se rechaza');
  bh.c.send({ t: 'kick', id: 1 });
  await guests[0]!.wait('kicked');
  const again = new Client(); await again.ready();
  again.send({ t: 'join', code: big.code, name: 'P0' });
  check((await again.wait('error')).code === 'banned', 'un jugador expulsado no vuelve a esa sala');
  guests[1]!.send({ t: 'kick', id: 0 });
  check((await guests[1]!.wait('error')).code === 'forbidden', 'un invitado no expulsa');

  console.log('Abuso');
  const spam = new Client(); await spam.ready();
  const closed = new Promise<number>((res) => spam.ws.on('close', (code) => res(code)));
  for (let i = 0; i < 400; i++) spam.ws.send(JSON.stringify({ t: 'ping', n: i }));
  check((await closed) === 4008, 'inundar un socket lo cierra (4008)');
  const junk = new Client(); await junk.ready();
  const jc = new Promise<number>((res) => junk.ws.on('close', (code) => res(code)));
  for (let i = 0; i < 6; i++) junk.ws.send('{"t":"nonsense"}');
  check((await jc) === 4003, 'demasiados mensajes inválidos cierran el socket (4003)');
  let blocked = false;
  for (let i = 0; i < 20 && !blocked; i++) blocked = (await api('/api/rooms/AAAA' + 'BCDEFGHJKMNPQRSTUVWXYZ'[i % 22])).status === 429;
  check(blocked, 'adivinar códigos bloquea la dirección (429)');
  const blockedWs = new Client();
  check(await new Promise((res) => { blockedWs.ws.on('unexpected-response', (_q, r) => res(r.statusCode === 429)); blockedWs.ws.on('open', () => res(false)); }), 'una dirección bloqueada tampoco abre sockets');

  for (const c of [host, g1, back, late, wrong, host2, sh.c, bh.c, fifth, again, ...guests]) c.ws.terminate();
}

main().catch((e) => { console.error(e); fails++; }).finally(() => {
  console.log(fails ? `\n${fails} FAILED` : '\nALL CHECKS PASSED');
  child.kill();
  setTimeout(() => process.exit(fails ? 1 : 0), 200);
});
