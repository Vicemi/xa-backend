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
import { COLORS, cleanSettings, defaultSettings, difficultyOf, type Difficulty, type Settings } from './game.js';

export type Status = 'lobby' | 'playing';
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
}
export interface Room {
  code: string;
  status: Status;
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
  createdAt: number;
  lastActive: number;
}
export interface RoomView {
  code: string;
  status: Status;
  hostId: number | null;
  max: number;
  settings: Settings;
  level: number;
  votes: { id: number; level: number }[];
  players: { id: number; name: string; color: number; ready: boolean; host: boolean; online: boolean }[];
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
  | { kind: 'removed'; room: Room; player: Player; closed: boolean; others: Player[] }
  | { kind: 'match_aborted'; room: Room }
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
      code: this.newCode(), status: 'lobby', settings: defaultSettings(), hostKeyHash: sha(hostKey), hostId: null,
      players: new Map(), creatorIp: ip, banned: new Set(), level: 0, votes: new Map(), createdAt: now, lastActive: now,
    };
    this.rooms.set(room.code, room);
    return { room, hostKey };
  }

  view(room: Room): RoomView {
    const players = [...room.players.values()].sort((a, b) => a.id - b.id);
    return {
      code: room.code, status: room.status, hostId: room.hostId, max: maxPlayers(), settings: room.settings,
      level: room.level,
      votes: players.filter((p) => room.votes.has(p.id)).map((p) => ({ id: p.id, level: room.votes.get(p.id)! })),
      players: players.map((p) => ({ id: p.id, name: p.name, color: p.color, ready: p.ready, host: p.id === room.hostId, online: p.lostAt === null })),
      difficulty: difficultyOf(players.length),
    };
  }

  /** Un color libre al azar (los colores de la paleta nunca coinciden con los de los power-ups). */
  private randomColor(room: Room, except: number): number {
    const used = new Set([...room.players.values()].filter((o) => o.id !== except).map((o) => o.color));
    const free = COLORS.map((_, i) => i).filter((i) => !used.has(i));
    if (free.length === 0) return -1;
    return free[randomInt(free.length)]!;
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

    if (room.status !== 'lobby') return 'started';
    if (room.players.size >= maxPlayers()) return 'full';
    let id = 0;
    while (room.players.has(id)) id++;
    const player: Player = { id, name, color: 0, ready: false, ws, sidHash: Buffer.alloc(32), ipHash, lostAt: null };
    const sid = this.issue(player);
    player.color = Math.max(0, this.randomColor(room, id));
    room.players.set(id, player);
    if (isHost) { room.hostId = id; player.ready = true; }
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

  /** Saca a un jugador para siempre. Si se va el anfitrión se cierra la sala (el navegador del anfitrión corre el juego). */
  leave(room: Room, player: Player): { closed: boolean; others: Player[] } {
    room.players.delete(player.id);
    room.votes.delete(player.id);
    player.ws = null;
    room.lastActive = Date.now();
    if (player.id === room.hostId) {
      const others = [...room.players.values()];
      this.rooms.delete(room.code);
      return { closed: true, others };
    }
    return { closed: false, others: [...room.players.values()] };
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
    p.color = color;
    room.lastActive = Date.now();
    return null;
  }

  setReady(room: Room, p: Player, ready: boolean): void {
    if (room.status === 'lobby') p.ready = ready;
    room.lastActive = Date.now();
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
    if (ps.length === 0) return 'The room is empty';
    if (ps.some((p) => p.lostAt !== null)) return 'Waiting for a player who lost the connection';
    if (ps.some((p) => !p.ready)) return 'Waiting for everybody to be ready';
    if (room.level === 0) return 'The host needs to choose a level';
    return null;
  }

  start(room: Room, p: Player): RoomError | string | null {
    if (p.id !== room.hostId) return 'forbidden';
    if (room.status !== 'lobby') return 'started';
    const why = this.startProblem(room);
    if (why) return why;
    room.status = 'playing';
    room.lastActive = Date.now();
    return null;
  }

  /** La partida terminó (lo dice el anfitrión, o se perdió al anfitrión): todos vuelven al lobby. */
  end(room: Room): void {
    room.status = 'lobby';
    room.votes.clear();
    for (const o of room.players.values()) o.ready = o.id === room.hostId;
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
        events.push({ kind: 'match_aborted', room });
      }
      for (const p of [...room.players.values()]) {
        if (p.lostAt !== null && now - p.lostAt > grace) {
          const r = this.leave(room, p);
          events.push({ kind: 'removed', room, player: p, closed: r.closed, others: r.others });
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
