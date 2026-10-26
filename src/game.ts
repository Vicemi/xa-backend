// Lo que el servidor sabe del juego: la paleta de colores de los jugadores y cómo cambia la dificultad del coop.
//
// En Xa todos juegan con el mismo héroe: lo que distingue a cada amigo es el color. La paleta evita a propósito los
// colores de los power-ups (cristal cian, poción verde, batería roja, engranajes amarilla) para que nunca se confundan
// con un efecto del juego.
import { config } from './config.js';

/** Colores de jugador (aleatorios y distintos entre sí; ninguno coincide con un power-up). */
export const COLORS = [
  { name: 'Violeta', hex: '#a855f7' },
  { name: 'Naranja', hex: '#ff8a2b' },
  { name: 'Rosa', hex: '#ff5ec4' },
  { name: 'Azul', hex: '#4f7dff' },
  { name: 'Blanco', hex: '#f4f0e6' },
  { name: 'Marrón', hex: '#c08a4a' },
  { name: 'Magenta', hex: '#e040a0' },
  { name: 'Turquesa', hex: '#20c9a0' },
] as const;

export interface Settings { powerups: boolean }

/** En los niveles originales el anfitrión puede activar los power-ups (solo online); contra los jefes siempre están. */
export function defaultSettings(): Settings { return { powerups: true }; }
export function cleanSettings(s: { powerups: boolean }): Settings { return { powerups: !!s.powerups }; }

export interface Difficulty {
  players: number;
  /** multiplicador de la vida de los enemigos */
  hp: number;
  /** multiplicador de cuántos enemigos aparecen */
  count: number;
  /** multiplicador de la vida de los jefes (ya incluye `hp`) */
  boss: number;
  /** segundos que alguien puede estar solo antes de que suba la dificultad */
  soloGraceSeconds: number;
  /** cuánto sube por segundo solo pasado ese tiempo */
  soloRampPerSecond: number;
  /** tope del castigo por estar solo */
  soloCap: number;
}

/** Dificultad cooperativa base para `n` jugadores conectados. El castigo por estar solo lo aplica el anfitrión en vivo. */
export function difficultyOf(n: number): Difficulty {
  const d = config.difficulty;
  const players = Math.max(1, Math.min(config.maxCoopPlayers, n));
  const hp = Math.min(d.cap, 1 + d.hpPerPlayer * (players - 1));
  const count = Math.min(d.cap, 1 + d.countPerPlayer * (players - 1));
  const boss = Math.min(d.cap * 2, (1 + d.bossHpPerPlayer * (players - 1)) * hp);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    players,
    hp: r(hp),
    count: r(count),
    boss: r(boss),
    soloGraceSeconds: d.soloGraceSeconds,
    soloRampPerSecond: d.soloRampPerSecond,
    soloCap: d.soloCap,
  };
}
