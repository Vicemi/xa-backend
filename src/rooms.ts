// Salas: un código, un lobby (nombres, colores, listo, votos de nivel, ajustes) y un relé entre el anfitrión y los
// invitados. El navegador del anfitrión simula el mundo; el servidor solo guarda el lobby y reenvía mensajes, así que
// no necesita lógica del juego.
//
// Sesiones: cada jugador recibe un identificador de sesión secreto al entrar. Si la conexión se corta (recarga, corte
// de red) el asiento se guarda RECONNECT_GRACE_SECONDS y el jugador vuelve con `resume` (o entrando de nuevo con el
// mismo apodo mientras el asiento esté libre). Un asiento que nadie reclama se libera: no hay jugadores fantasma ni
// salas huérfanas.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { WebSocket } from 'ws';
import { config } from './config.js';
import { COLORS, HOST_COLOR, cleanSettings, defaultSettings, difficultyOf, type Difficulty, type Settings } from './game.js';

export type Status = 'lobby' | 'playing';
/** lobby = armando la sala; browse = el anfitrión ya dijo "todo listo" y recorre los menús (los demás lo miran y votan). */
export type Stage = 'lobby' | 'browse';
/** Dónde está cada jugador mientras corre una partida: lobby = en la pantalla online (fuera del nivel), play = jugando,
 *  watch = mirando como espectador. Fuera de partida todos están en `lobby`. La conexión (lostAt) va aparte. */
export type At = 'lobby' | 'play' | 'watch';
export interface Player {
  id: number;
  name: string;
  /** índice en COLORS (único en la sala, aleatorio, nunca igual al color de un power-up) */
  color: number;
  ready: boolean;
  ws: WebSocket | null;
  sidHash: Buffer;
  ipHash: string;
  /** cuándo se perdió la conexión (null = conectado) */
  lostAt: number | null;
  at: At;
  /** cuándo salió del nivel en plena partida (null = no salió): si no vuelve en AWAY_LIMIT_SECONDS la partida termina */
  awayAt: number | null;
}
export interface Room {
  code: string;
  status: Status;
  stage: Stage;
  /** último estado de menús que mandó el anfitrión (para quien entra o vuelve a media etapa) */
  menu: unknown;
  settings: Settings;
  hostKeyHash: Buffer;
  hostId: number | null;
  players: Map<number, Player>;
  creatorIp: string;
  /** hashes de dirección de los jugadores expulsados: no pueden volver a esta sala */
  banned: Set<string>;
  /** nivel elegido por el anfitrión (0 = todavía no eligió) */
  level: number;
  /** voto de nivel de cada jugador (id -> nivel) */
  votes: Map<number, number>;
  /** dificultad fijada al empezar (la recibe también quien vuelve a la partida) */
  difficulty: Difficulty | null;
  createdAt: number;
  lastActive: number;
}
export interface RoomView {
  code: string;
  status: Status;
  stage: Stage;
  hostId: number | null;
  max: number;
  settings: Settings;
  level: number;
  votes: { id: number; level: number }[];
  /** at = dónde está; away = segundos que le quedan para volver al nivel (solo si salió en plena partida) */
  players: { id: number; name: string; color: number; ready: boolean; host: boolean; online: boolean; at: At; away?: number }[];
  difficulty: Difficulty;
}

export type RoomError = 'taken' | 'not_found' | 'full' | 'started' | 'bad_key' | 'forbidden' | 'invalid' | 'limit' | 'bad_session' | 'banned' | 'blocked' | 'no_level';

// Sin 0/O/1/I/L: fácil de dictar en voz alta.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const sha = (s: string) => createHash('sha256').update(s).digest();
const shaHex = (s: string) => createHash('sha256').update(s).digest('hex').slice(0, 32);

export const maxPlayers = (): number => config.maxCoopPlayers;

/** Lo que decidió el barrido: el llamador avisa a los sockets. */
export type SweepEvent =
  | { kind: 'removed'; room: Room; player: Player; closed: boolean; others: Player[]; reason?: 'host' | 'alone' }
  | { kind: 'match_aborted'; room: Room; reason: 'host_lost' | 'away_timeout'; name?: string }
  | { kind: 'idle'; room: Room };

export class Rooms {
  private rooms = new Map<string, Room>();

  get size(): number { return this.rooms.size; }
  get(code: string): Room | undefined { return this.rooms.get(code); }
  all(): Room[] { return [...this.rooms.values()]; }

  private newCode(): string {
    for (let i = 0; i < 50; i++) {
      let c = '';
      for (let k = 0; k < 5; k++) c += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      if (!this.rooms.has(c)) return c;
    }
    throw new Error('could not find a free room code');
  }

  create(ip: string): { room: Room; hostKey: string } | RoomError {
    if (this.rooms.size >= config.maxRooms) return 'limit';
    const mine = this.all().filter((r) => r.creatorIp === ip).length;
    if (mine >= config.maxRoomsPerIp) return 'limit';
    const hostKey = randomBytes(24).toString('hex');
    const now = Date.now();
    const room: Room = {
      code: this.newCode(), status: 'lobby', stage: 'lobby', menu: null, settings: defaultSettings(), hostKeyHash: sha(hostKey), hostId: null,
      players: new Map(), creatorIp: ip, banned: new Set(), level: 0, votes: new Map(), difficulty: null, createdAt: now, lastActive: now,
    };
    this.rooms.set(room.code, room);
    return { room, hostKey };
  }

  view(room: Room): RoomView {
    const players = [...room.players.values()].sort((a, b) => a.id - b.id);
    const now = Date.now();
    const away = (p: Player) => (p.awayAt === null ? {} : { away: Math.max(0, Math.ceil((p.awayAt + config.awayLimitSeconds * 1000 - now) / 1000)) });
    return {
      code: room.code, status: room.status, stage: room.stage, hostId: room.hostId, max: maxPlayers(), settings: room.settings,
      level: room.level,
      votes: players.filter((p) => room.votes.has(p.id)).map((p) => ({ id: p.id, level: room.votes.get(p.id)! })),
      players: players.map((p) => ({ id: p.id, name: p.name, color: p.color, ready: p.ready, host: p.id === room.hostId, online: p.lostAt === null, at: p.at, ...away(p) })),
      difficulty: difficultyOf(players.length),
    };
  }

  /** El primer color libre para un invitado (el 0 es del anfitrión; nunca coincide con los de los power-ups). */
  private guestColor(room: Room, except: number): number {
    const used = new Set([...room.players.values()].filter((o) => o.id !== except).map((o) => o.color));
    const free = COLORS.map((_, i) => i).filter((i) => i !== HOST_COLOR && !used.has(i));
    return free[0] ?? 1;
  }

  private connected(p: Player): boolean { return p.lostAt === null && !!p.ws; }

  /** Un identificador de sesión nuevo para un jugador (solo se guarda su hash). */
  private issue(p: Player): string {
    const sid = randomBytes(24).toString('hex');
    p.sidHash = sha(sid);
    return sid;
  }

  join(code: string, name: string, key: string | undefined, ws: WebSocket, ip: string): { room: Room; player: Player; sid: string; claimed: boolean; replaced?: WebSocket | null } | RoomError {
    const room = this.rooms.get(code);
    if (!room) return 'not_found';
    const ipHash = shaHex(ip);
    if (room.banned.has(ipHash)) return 'banned';
    const isHost = key !== undefined && room.hostId === null && key.length > 0 && timingSafeEqual(sha(key), room.hostKeyHash);
    if (key !== undefined && !isHost && room.hostId === null) return 'bad_key';
    if (room.hostId === null && !isHost) return 'forbidden';   // el creador tiene que llegar primero, con la clave de la sala

    // Alguien puede recuperar su asiento entrando de nuevo con el mismo apodo: cuando se cortó la conexión o, en plena
    // partida, aunque la conexión vieja parezca viva (una pestaña congelada, una segunda pestaña): la nueva la reemplaza.
    const lower = name.toLowerCase();
    const seat = [...room.players.values()].find((p) => p.name.toLowerCase() === lower && p.id !== room.hostId && (p.lostAt !== null || room.status === 'playing'));
    if (seat) {
      const replaced = seat.ws && seat.ws !== ws ? seat.ws : null;
      seat.ws = ws; seat.lostAt = null; seat.ipHash = ipHash;
      room.lastActive = Date.now();
      return { room, player: seat, sid: this.issue(seat), claimed: true, replaced };
    }

    // con la partida en curso también se puede entrar: queda en la pantalla online y elige jugar o mirar
    if (room.players.size >= maxPlayers()) return 'full';
    let id = 0;
    while (room.players.has(id)) id++;
    const player: Player = { id, name, color: 0, ready: false, ws, sidHash: Buffer.alloc(32), ipHash, lostAt: null, at: 'lobby', awayAt: null };
    const sid = this.issue(player);
    player.color = isHost ? HOST_COLOR : this.guestColor(room, id);
    room.players.set(id, player);
    if (isHost) { room.hostId = id; player.ready = true; }
    else if (room.stage === 'browse' || room.status === 'playing') player.ready = true;   // entra con los menús abiertos o la partida en curso: no frena al anfitrión
    room.lastActive = Date.now();
    return { room, player, sid, claimed: false, replaced: null };
  }

  /** Vuelve con el identificador de sesión recibido al entrar (recarga de página, reconexión). El socket viejo, si hay, se reemplaza. */
  resume(code: string, sid: string, ws: WebSocket, ip: string): { room: Room; player: Player; replaced: WebSocket | null } | RoomError {
    const room = this.rooms.get(code);
    if (!room) return 'not_found';
    const h = sha(sid);
    const player = [...room.players.values()].find((p) => timingSafeEqual(p.sidHash, h));
    if (!player) return 'bad_session';
    const ipHash = shaHex(ip);
    if (room.banned.has(ipHash)) return 'banned';
    const replaced = player.ws && player.ws !== ws ? player.ws : null;
    player.ws = ws;
    player.lostAt = null;
    player.ipHash = ipHash;
    room.lastActive = Date.now();
    return { room, player, replaced };
  }

  /** La conexión de un jugador se cerró: el asiento se guarda un rato. Devuelve false si el socket ya fue reemplazado. */
  lost(room: Room, player: Player, ws: WebSocket): boolean {
    if (player.ws !== ws) return false;
    player.ws = null;
    player.lostAt = Date.now();
    return true;
  }

  /** Saca a un jugador para siempre. Si se va el anfitrión se cierra la sala (el navegador del anfitrión corre el juego);
   *  si se va el último invitado (no por expulsión) y queda solo el anfitrión, también: no hay con quién jugar. */
  leave(room: Room, player: Player, closeIfAlone = true): { closed: boolean; others: Player[]; reason?: 'host' | 'alone' } {
    room.players.delete(player.id);
    room.votes.delete(player.id);
    player.ws = null;
    room.lastActive = Date.now();
    const others = [...room.players.values()];
    if (player.id === room.hostId || (closeIfAlone && others.length === 1 && others[0]!.id === room.hostId)) {
      this.rooms.delete(room.code);
      return { closed: true, others, reason: player.id === room.hostId ? 'host' : 'alone' };
    }
    return { closed: false, others };
  }

  /** Invitado en plena partida: sale del nivel a la pantalla online (lobby), vuelve a jugar (play) o mira (watch). */
  setAt(room: Room, p: Player, at: At): RoomError | null {
    if (room.status !== 'playing') return 'invalid';
    if (p.id === room.hostId) return 'forbidden';   // si el anfitrión sale del nivel, termina la partida (`end`)
    if (p.at === at) return null;
    // el reloj de los minutos para volver corre desde que dejó de jugar (mirar también cuenta como haber vuelto)
    p.awayAt = at === 'lobby' ? (p.at === 'play' ? Date.now() : p.awayAt) : null;
    p.at = at;
    room.lastActive = Date.now();
    return null;
  }

  kick(room: Room, host: Player, id: number): { target: Player } | RoomError {
    if (host.id !== room.hostId) return 'forbidden';
    const target = room.players.get(id);
    if (!target || target.id === host.id) return 'invalid';
    room.banned.add(target.ipHash);
    return { target };
  }

  setColor(room: Room, p: Player, color: number): RoomError | null {
    if (room.status !== 'lobby') return 'started';
    if (color < 0 || color >= COLORS.length) return 'invalid';
    if ([...room.players.values()].some((o) => o.id !== p.id && o.color === color)) return 'taken';
    if (p.id === room.hostId || color === HOST_COLOR) return p.color === color ? null : 'invalid';   // el 0 (original) es fijo del anfitrión
    p.color = color;
    room.lastActive = Date.now();
    return null;
  }

  setReady(room: Room, p: Player, ready: boolean): void {
    if (room.status === 'lobby' && p.id !== room.hostId) p.ready = ready;
    room.lastActive = Date.now();
    // si alguien cancela su "listo" con los menús abiertos, la sala vuelve al lobby
    if (!ready && room.stage === 'browse' && room.status === 'lobby' && p.id !== room.hostId) { room.stage = 'lobby'; room.menu = null; }
  }

  /** "Todo listo" del anfitrión (on) o volver al lobby (off). Devuelve un texto con el motivo si no se puede. */
  go(room: Room, p: Player, on: boolean): RoomError | string | null {
    if (p.id !== room.hostId) return 'forbidden';
    if (room.status !== 'lobby') return 'started';
    if (on) {
      const ps = [...room.players.values()];
      if (ps.some((o) => o.lostAt !== null)) return 'Falta un jugador que perdió la conexión';
      const wait = ps.filter((o) => !o.ready).map((o) => o.name);
      if (wait.length) return 'Todavía no están listos: ' + wait.join(', ');
    }
    room.stage = on ? 'browse' : 'lobby';
    room.menu = null;
    room.lastActive = Date.now();
    return null;
  }

  /** El anfitrión publica el estado de sus menús. */
  setMenu(room: Room, p: Player, d: unknown): boolean {
    if (p.id !== room.hostId || room.status !== 'lobby') return false;
    if (JSON.stringify(d).length > 2000) return false;
    room.menu = d;
    room.lastActive = Date.now();
    return true;
  }

  /** Voto consultivo de nivel: el anfitrión decide si lo usa. */
  vote(room: Room, p: Player, level: number): void {
    if (room.status !== 'lobby') return;
    if (level === 0) room.votes.delete(p.id);
    else room.votes.set(p.id, level);
    room.lastActive = Date.now();
  }

  /** El anfitrión elige el nivel de la partida. */
  setLevel(room: Room, p: Player, level: number): RoomError | null {
    if (p.id !== room.hostId) return 'forbidden';
    if (room.status !== 'lobby') return 'started';
    room.level = level;
    room.lastActive = Date.now();
    return null;
  }

  setSettings(room: Room, p: Player, s: { powerups: boolean }): RoomError | null {
    if (p.id !== room.hostId) return 'forbidden';
    if (room.status !== 'lobby') return 'started';
    room.settings = cleanSettings(s);
    room.lastActive = Date.now();
    return null;
  }

  /** Por qué la sala todavía no puede empezar (null = puede). */
  startProblem(room: Room): string | null {
    const ps = [...room.players.values()];
    if (ps.length === 0) return 'La sala está vacía';
    if (ps.some((p) => p.lostAt !== null)) return 'Falta un jugador que perdió la conexión';
    if (ps.some((p) => !p.ready)) return 'Todavía no están todos listos';
    if (room.level === 0) return 'El anfitrión todavía no eligió un nivel';
    return null;
  }

  start(room: Room, p: Player): RoomError | string | null {
    if (p.id !== room.hostId) return 'forbidden';
    if (room.status !== 'lobby') return 'started';
    const why = this.startProblem(room);
    if (why) return why;
    room.status = 'playing';
    room.difficulty = difficultyOf([...room.players.values()].filter((o) => o.lostAt === null).length);
    for (const o of room.players.values()) { o.at = 'play'; o.awayAt = null; }
    room.lastActive = Date.now();
    return null;
  }

  /** La partida terminó (el anfitrión ganó, perdió o salió del nivel; se perdió al anfitrión; o alguien no volvió a
   *  tiempo): todos vuelven a la selección de nivel (etapa `browse`, todos listos) y el anfitrión elige el siguiente. */
  end(room: Room): void {
    room.status = 'lobby';
    room.stage = 'browse';
    room.menu = null;
    room.votes.clear();
    room.difficulty = null;
    for (const o of room.players.values()) { o.ready = true; o.at = 'lobby'; o.awayAt = null; }
    room.lastActive = Date.now();
  }

  touch(room: Room): void { room.lastActive = Date.now(); }

  /** Libera los asientos que nadie reclamó, termina partidas sin anfitrión y cierra salas ociosas. */
  sweep(): SweepEvent[] {
    const events: SweepEvent[] = [];
    const now = Date.now();
    const grace = config.reconnectGraceSeconds * 1000;
    const hostGrace = config.hostPlayGraceSeconds * 1000;
    for (const room of this.all()) {
      if (!this.rooms.has(room.code)) continue;
      const host = room.hostId !== null ? room.players.get(room.hostId) : undefined;
      if (room.status === 'playing' && host && host.lostAt !== null && now - host.lostAt > hostGrace) {
        this.end(room);
        events.push({ kind: 'match_aborted', room, reason: 'host_lost' });
      }
      // un invitado salió del nivel y no volvió (ni a jugar ni a mirar) a tiempo: termina para todos
      const gone = room.status === 'playing' ? [...room.players.values()].find((p) => p.awayAt !== null && now - p.awayAt > config.awayLimitSeconds * 1000) : undefined;
      if (gone) {
        this.end(room);
        events.push({ kind: 'match_aborted', room, reason: 'away_timeout', name: gone.name });
      }
      for (const p of [...room.players.values()]) {
        if (p.lostAt !== null && now - p.lostAt > grace) {
          const r = this.leave(room, p);
          events.push({ kind: 'removed', room, player: p, closed: r.closed, others: r.others, reason: r.reason });
          if (r.closed) break;
        }
      }
      if (this.rooms.has(room.code) && room.lastActive < now - config.roomIdleMinutes * 60_000) {
        this.rooms.delete(room.code);
        events.push({ kind: 'idle', room });
      }
    }
    return events;
  }

  stats(): { rooms: number; players: number; connected: number; playing: number } {
    let players = 0, connected = 0, playing = 0;
    for (const r of this.rooms.values()) {
      if (r.status === 'playing') playing++;
      for (const p of r.players.values()) { players++; if (this.connected(p)) connected++; }
    }
    return { rooms: this.rooms.size, players, connected, playing };
  }
}
