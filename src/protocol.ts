// Esquemas de mensajes (TypeBox, el validador de Elysia). Todo lo que manda un cliente pasa por uno de estos esquemas.
import { t } from 'elysia';
import { Value } from '@sinclair/typebox/value';
import { COLORS } from './game.js';

export const Name = t.String({ minLength: 1, maxLength: 32 });   // crudo; cleanName() lo recorta a 10
export const Code = t.String({ pattern: '^[A-Z2-9]{5}$' });
export const Color = t.Integer({ minimum: 0, maximum: COLORS.length - 1 });
/** Nivel votado / elegido: 0 = ninguno, 1-16 originales, 101-112 extras (y mapas propios). */
export const Level = t.Integer({ minimum: 0, maximum: 999 });

/** Lo que el anfitrión / los invitados se retransmiten (estado del juego). El servidor nunca mira adentro, solo su tamaño. */
const Blob = t.Any();

const Sid = t.String({ pattern: '^[0-9a-f]{48}$' });

export const ClientMessage = t.Union([
  t.Object({ t: t.Literal('join'), code: Code, name: Name, key: t.Optional(t.String({ maxLength: 64 })) }),
  t.Object({ t: t.Literal('resume'), code: Code, sid: Sid }),
  t.Object({ t: t.Literal('color'), color: Color }),
  t.Object({ t: t.Literal('ready'), ready: t.Boolean() }),
  t.Object({ t: t.Literal('vote'), level: Level }),
  t.Object({ t: t.Literal('level'), level: Level }),
  t.Object({ t: t.Literal('settings'), powerups: t.Boolean() }),
  t.Object({ t: t.Literal('kick'), id: t.Integer({ minimum: 0, maximum: 7 }) }),
  t.Object({ t: t.Literal('start') }),
  // Señalización WebRTC entre el anfitrión y un invitado (oferta / respuesta / candidato ICE); el servidor solo la reenvía.
  t.Object({ t: t.Literal('rtc'), to: t.Integer({ minimum: 0, maximum: 7 }), d: t.Object({ k: t.Union([t.Literal('offer'), t.Literal('answer'), t.Literal('ice')]), s: t.Optional(t.String({ maxLength: 12000 })), c: t.Optional(t.Any()) }) }),
  // Controles del invitado: bits de abajo (left 1, right 2, up 4, down 8, fire 16, jump 32) + secuencia.
  t.Object({ t: t.Literal('in'), d: t.Object({ b: t.Integer({ minimum: 0, maximum: 63 }), q: t.Integer({ minimum: 0, maximum: 65535 }) }) }),
  t.Object({ t: t.Literal('snap'), d: Blob }),
  t.Object({ t: t.Literal('end'), d: t.Optional(Blob) }),
  t.Object({ t: t.Literal('ping'), n: t.Optional(t.Number()) }),
  t.Object({ t: t.Literal('leave') }),
]);
export type ClientMessageT = { t: string; [k: string]: unknown };

export function parseClientMessage(raw: string): ClientMessageT | null {
  let data: unknown;
  try { data = JSON.parse(raw); } catch { return null; }
  return Value.Check(ClientMessage as never, data) ? (data as ClientMessageT) : null;
}

export const CreateRoomBody = t.Object({}, { additionalProperties: false });
export const CodeParams = t.Object({ code: Code });

/** Limpia un apodo: solo caracteres imprimibles, espacios colapsados, máximo 10 (como los nombres del juego). */
export function cleanName(s: string): string {
  const out = s.normalize('NFKC').replace(/[^\p{L}\p{N} _.\-]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 10);
  return out || 'Xa';
}
