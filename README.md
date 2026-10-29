# xa-backend

Servidor de **salas y retransmisión** del modo **cooperativo online de hasta 4 jugadores** del port web de *Xa*: [xa-portweb](https://github.com/Vicemi/Xa-portweb).

- **Express** es la capa de afuera: cabeceras de seguridad (helmet), CORS, límites de tasa, IP real detrás de Cloudflare, verificación opcional de Cloudflare Access y el servidor HTTP/WebSocket.
- **Elysia** define la API HTTP con rutas y cuerpos validados (TypeBox); se monta dentro de Express. Los mensajes del WebSocket se validan con los mismos esquemas.
- Es **usable por cualquiera**: este repositorio es todo lo que hace falta para montar tu propio servidor y apuntar el juego hacia él.

> **Cómo funciona una partida.** El navegador del **anfitrión** (quien crea la sala) simula el mundo y manda el estado ~30 veces por segundo; los **invitados** mandan sus controles y dibujan lo que reciben. El servidor solo guarda el lobby (nombres, colores, "listo", votos de nivel) y reenvía mensajes, así que no necesita nada del juego y casi no gasta CPU.

---

## Inicio rápido (local)

Necesitás Node 22 o superior.

```sh
git clone https://github.com/Vicemi/xa-backend.git
cd xa-backend
npm install
cp .env.example .env        # y editá GAME_TOKEN (npm run token genera uno)
npm run dev                 # http://localhost:8787
```

Comprobar que anda:

```sh
curl http://localhost:8787/health          # {"ok":true,...}
npm test                                   # prueba de punta a punta (salas, relé, sesiones, límites, coop de 1 a 4)
```

Producción:

```sh
npm run build && npm start
# o con Docker:
docker compose up -d --build
```

---

## Variables de entorno (`.env`)

Todo se configura en el archivo `.env` (hay un modelo comentado en [`.env.example`](.env.example)). El servidor **no arranca** si falta `GAME_TOKEN`.

| Variable | Por defecto | Para qué sirve |
| :--- | :--- | :--- |
| `PORT` | `8787` | Puerto en el que escucha. |
| `HOST` | `0.0.0.0` | Dirección de escucha. Con un túnel de Cloudflare en la misma máquina podés usar `127.0.0.1`. |
| `GAME_TOKEN` | *(obligatorio)* | Clave compartida con el juego (`PUBLIC_XA_BACKEND_TOKEN`). 16–128 caracteres `A-Z a-z 0-9 . _ -`. `npm run token` genera una. Pueden ser **varios separados por coma** para rotar el token sin cortar el servicio. |
| `ALLOWED_ORIGINS` | `*` | Sitios que pueden usar el servidor, separados por coma y sin `/` final. Poné ahí el dominio del juego. `*` solo para desarrollo. |
| `TRUST_PROXY` | `1` | Cantidad de proxies delante del servidor (Express *trust proxy*). Con Cloudflare Tunnel: `1`. |
| `TRUST_CLOUDFLARE` | `false` | `true` = la IP del visitante sale de `CF-Connecting-IP`. Activalo **solo** si todo el tráfico entra por Cloudflare. |
| `CF_ACCESS_TEAM_DOMAIN` / `CF_ACCESS_AUD` / `CF_ACCESS_REQUIRED` | vacío / `false` | Verificación opcional del JWT de Cloudflare Access. |
| `MAX_ROOMS` | `200` | Salas simultáneas. |
| `ROOM_IDLE_MINUTES` | `30` | Una sala sin actividad se cierra. |
| `MAX_COOP_PLAYERS` | `4` | Jugadores por sala (1 a 4; 1 = jugar solo). |
| `MAX_ROOMS_PER_IP` | `3` | Salas abiertas a la vez por IP. |
| `RECONNECT_GRACE_SECONDS` | `45` | Cuánto se guarda el asiento de quien perdió la conexión (recarga de la página, corte de red). |
| `HOST_PLAY_GRACE_SECONDS` | `12` | Cuánto espera una partida a un anfitrión desconectado antes de terminarse para todos. |
| `JOIN_FAIL_LIMIT` / `JOIN_BLOCK_MINUTES` | `12` / `5` | Intentos fallidos de entrar a una sala por minuto antes de bloquear la IP (evita adivinar códigos). |
| `MAX_STRIKES` | `5` | Mensajes inválidos antes de cerrar el socket. |
| `ADMIN_TOKEN` | vacío | Si se define, habilita `GET /api/admin/stats` (cabecera `x-admin-token`) con contadores sin datos personales. |
| `MAX_CONNECTIONS_PER_IP` | `8` | WebSockets abiertos por IP. |
| `HTTP_RATE_PER_MINUTE` | `60` | Pedidos HTTP por minuto y por IP. |
| `CREATE_ROOM_PER_MINUTE` | `6` | Salas creadas por minuto y por IP. |
| `WS_MESSAGES_PER_SECOND` | `90` | Mensajes por segundo de cada conexión (el juego usa ~30–60). |
| `WS_MAX_PAYLOAD_BYTES` | `65536` | Tamaño máximo de un mensaje (las instantáneas del mundo son chicas). |
| `DIFFICULTY_PER_PLAYER` | `0.10` | Cada jugador extra hace a los enemigos un 10 % más duros. |
| `ENEMY_COUNT_PER_PLAYER` | `0.75` | Enemigos extra por jugador extra (2 jugadores = ×1,75). |
| `BOSS_HP_PER_PLAYER` | `0.5` | Vida extra de los jefes por jugador extra. |
| `DIFFICULTY_CAP` | `3` | Tope de los multiplicadores. |
| `SOLO_GRACE_SECONDS` | `25` | Segundos que alguien puede estar solo antes de que la dificultad empiece a subir. |
| `SOLO_RAMP_PER_SECOND` | `0.02` | Cuánto sube la dificultad por segundo solo pasado ese tiempo (+2 %/s). |
| `SOLO_PENALTY_CAP` | `1.6` | Tope del castigo por estar solo. |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn` o `error`. |

---

## Conectar el juego (frontend)

El juego se compila con **dos variables de entorno** que le dicen dónde está tu backend:

| Variable del **frontend** | Valor |
| :--- | :--- |
| `PUBLIC_XA_BACKEND_URL` | La dirección https de este servidor, sin `/` final. Ej.: `https://xa-api.tudominio.com` |
| `PUBLIC_XA_BACKEND_TOKEN` | El mismo valor que `GAME_TOKEN` del `.env` del backend. |

**En Cloudflare Pages:** proyecto → *Settings* → *Variables and Secrets* → agregalas (en *Production* y, si querés, en *Preview*) y **volvé a desplegar**: las variables `PUBLIC_*` se incorporan a la página al compilar, no se leen en el navegador en tiempo de ejecución.

**En local:** creá un `.env` en la raíz del frontend:

```env
PUBLIC_XA_BACKEND_URL=http://127.0.0.1:8787
PUBLIC_XA_BACKEND_TOKEN=el-mismo-token-del-backend
```

> **Sobre el token.** Como las variables `PUBLIC_*` terminan dentro de la página, el token **no es una contraseña**: es una clave del juego que mantiene afuera el tráfico casual y otros sitios (junto con `ALLOWED_ORIGINS`). La protección real contra abusos son los límites de tasa, el tope de salas/conexiones, la validación de cada mensaje y que el servidor no ejecuta nada de lo que recibe.

Si las variables no están definidas, el juego muestra que el modo online no está configurado y el resto sigue funcionando.

---

## Reglas del juego que aplica el servidor

- **Salas**: un código de 5 caracteres (`A-Z` sin `O/I/L` y `2-9`, aleatorio con `crypto`). Se crea con `POST /api/rooms`, que también devuelve una **clave de anfitrión** secreta; solo quien la tiene puede ser el anfitrión.
- **Coop de 1 a 4**: pueden jugar menos; incluso uno solo puede empezar. El anfitrión no puede empezar hasta que **todos estén listos**, estén conectados y haya **elegido un nivel**.
- **Nombres y colores**: el apodo se recorta a **10 caracteres**. El **anfitrión siempre tiene el color 0 ("Original")**: el juego no le pone tinte, conserva los colores del sprite de Xa. Los invitados reciben el primer color libre de 1 en adelante (violeta, naranja, azul, turquesa, …): distintos entre sí y **sin coincidir con los colores de los power-ups** (cian, verde, rojo y amarillo). El 0 no se puede elegir ni cambiar.
- **Etapas de la sala** (`room.stage`): `lobby` (se arma la sala: nombres, «listo») y `browse` (el anfitrión dijo **«todo listo»** con `go`; recorre los menús del juego y los demás **miran** su estado de menús y **votan**). Quien entra con la etapa `browse` abierta entra ya listo; si alguien cancela su «listo» en `browse`, la sala vuelve a `lobby`.
- **Niveles**: cualquier jugador puede **votar** un nivel; solo el **anfitrión** decide el nivel definitivo (`level`) y solo él empieza la partida (`start`). Qué niveles se pueden elegir lo define el progreso **del anfitrión** (lo guarda su navegador; viaja en el estado de menús).
- **Power-ups**: en los niveles originales el anfitrión puede activarlos o desactivarlos (`settings.powerups`), pero **contra los jefes siempre están activos** (lo aplica el juego, no el servidor).
- **Sesiones**: al entrar, cada jugador recibe un identificador de sesión secreto (solo se guarda su hash). Si se corta la conexión o se recarga la página, el asiento se conserva `RECONNECT_GRACE_SECONDS` y se vuelve con `resume`; también se puede volver **entrando de nuevo con el código de sala y el mismo apodo** mientras el asiento esté libre (incluso en plena partida). Los asientos que nadie reclama se liberan y las salas sin nadie se cierran.
- **Casos límite**: 4 jugadores como máximo *contando al anfitrión* (el quinto recibe `error full`; el cliente además lo comprueba antes con `GET /api/rooms/:code`). Un jugador que pierde la conexión conserva su asiento `RECONNECT_GRACE_SECONDS`; mientras tanto el anfitrión no puede dar «todo listo» ni empezar (`error not_ready`). Un expulsado (`kick`) recibe `kicked` y no puede volver. Si el anfitrión se va (`leave`) o su asiento vence, todos reciben `closed` (`host_left`) y la sala desaparece; en la etapa `browse` el anfitrión puede perder la conexión hasta `RECONNECT_GRACE_SECONDS` (los demás ven «perdió la conexión»).
- Si el anfitrión recarga la página en plena partida, la partida (que vivía en esa página) se termina para todos y vuelven al lobby con sus asientos. Si se va para siempre, la sala se cierra.

---

## API y protocolo

HTTP (todas salvo `/health` exigen el token en `x-xa-token: <token>` o `Authorization: Bearer <token>`, y un `Origin` permitido):

| Ruta | Descripción |
| :--- | :--- |
| `GET /health` | Sonda de estado (pública). |
| `GET /api/info` | Colores, límites, dificultad y servidores ICE. |
| `POST /api/rooms` | Crea una sala: `{ code, hostKey, max }`. |
| `GET /api/rooms/:code` | Estado público de una sala (existe, jugadores, si se puede entrar). Adivinar códigos bloquea la IP un rato. |
| `GET /api/admin/stats` | Contadores (salas, jugadores, conexiones, memoria). Solo con `ADMIN_TOKEN` y la cabecera `x-admin-token`. |

WebSocket: `wss://tu-servidor/ws`, con los sub-protocolos `xa-v1` y `token.<GAME_TOKEN>` (el navegador no puede mandar cabeceras, por eso el token viaja ahí y no en la URL). Mensajes JSON; el primero debe ser `join` dentro de los 10 s.

| Cliente → servidor | Quién | Efecto |
| :--- | :--- | :--- |
| `{t:"join", code, name, key?}` | todos | Entra a la sala (`key` = clave de anfitrión, solo del creador). |
| `{t:"resume", code, sid}` | todos | Vuelve al asiento propio con el identificador de sesión. |
| `{t:"color", color}` / `{t:"ready", ready}` | jugador | Color (0–7, único) y «listo». |
| `{t:"vote", level}` | jugador | Voto consultivo de nivel (0 = sacar el voto). |
| `{t:"level", level}` / `{t:"settings", powerups}` | anfitrión | Nivel de la partida / power-ups de los niveles originales. |
| `{t:"kick", id}` / `{t:"start"}` | anfitrión | Expulsar / empezar. |
| `{t:"go", on}` | anfitrión | «Todo listo» (`on:true`: pasa a la etapa `browse`; se rechaza con `error not_ready` si falta alguien listo o conectado) / volver al lobby (`on:false`). |
| `{t:"menu", d}` | anfitrión | Estado de sus menús (JSON ≤ 2000 caracteres; el juego manda `{s, i, p, l, d, f}`: pantalla, botón, mapa, nodo, niveles completados y perfectos). Se reenvía a los demás y se guarda para quien entre o vuelva. |
| `{t:"rtc", to, d}` | todos | Señalización WebRTC (oferta / respuesta / ICE); el servidor solo la reenvía. |
| `{t:"in", d:{b,q}}` | invitado | Controles (bits: left 1, right 2, up 4, down 8, fire 16, jump 32 + secuencia) → solo al anfitrión. |
| `{t:"snap", d}` | anfitrión | Estado del mundo → a los invitados. |
| `{t:"end", d?}` | anfitrión | Termina la partida: todos vuelven al lobby. |

El servidor responde con `joined`, `room` (estado del lobby, con `stage`), `menu` (el estado de menús del anfitrión), `start` (con la dificultad, el nivel y los ajustes), `in`, `snap`, `ended`, `left`, `peer`, `rtc`, `kicked`, `replaced`, `closed`, `error` y `pong`. `joined` trae el identificador de sesión (`sid`). Los mensajes del lobby se validan con TypeBox; de `in`/`snap` solo se mira el tamaño: el servidor nunca interpreta ni ejecuta su contenido.

## Latencia: conexión directa entre jugadores (WebRTC)

El relé del servidor añade el viaje de ida y vuelta hasta el servidor a cada control y a cada imagen. Por eso, al empezar la partida, los navegadores intentan **conectarse directamente entre sí** (WebRTC, canales de datos) y el servidor solo hace de «presentador»: reenvía las ofertas, respuestas y candidatos ICE (`rtc`).

- Con el enlace directo, los controles y el estado viajan sin pasar por el servidor y el retraso baja al ping directo entre jugadores.
- **Si no se puede (NAT estricto, red móvil) o se corta, todo sigue por el relé**, sin que el jugador haga nada.
- `ICE_SERVERS` (JSON, ver `.env.example`): servidores STUN/TURN que se entregan a los navegadores. Por defecto, STUN públicos de Google y Cloudflare (gratis). Para que el enlace directo funcione también con redes estrictas hace falta un servidor **TURN** (por ejemplo [coturn](https://github.com/coturn/coturn) en tu VPS).

## Seguridad, en resumen

Tokens comparados en tiempo constante y rotables · identificadores de sesión secretos (solo su hash en memoria) con asiento reservado y liberación automática · bloqueo de IP al adivinar códigos de sala · tope de salas por IP · controles validados (rango de bits) · cierre del socket tras varios mensajes inválidos · expulsión con veto por sala · aviso a los clientes al apagar el servidor · orígenes permitidos (HTTP y WebSocket) · límite de pedidos por IP · límite de salas creadas por IP · tope de salas y de conexiones por IP · tope de mensajes por segundo y de tamaño por conexión · todos los mensajes validados · apodos limpiados · acciones de anfitrión comprobadas en el servidor · `helmet` · cuerpo JSON de máx. 2 kB · sin estado en disco.

## Limitaciones conocidas

- El mundo corre en el navegador del anfitrión: **tiene que mantener la pestaña visible** (si el navegador la suspende, la partida se congela y los invitados ven «se perdió la conexión» a los 12 s).
- Los invitados juegan con la latencia de ida y vuelta al anfitrión; el enlace directo WebRTC la reduce mucho.
- El anfitrión es quien manda: es un juego entre amigos, no hay protección contra un anfitrión tramposo.

## Estructura

```text
src/
  index.ts      arranque
  config.ts     variables de entorno
  http.ts       Express: seguridad, CORS, límites, puente hacia Elysia
  api.ts        Elysia: /health y /api/*
  ws.ts         WebSocket: lobby y retransmisión
  rooms.ts      salas, colores, votos, reglas del lobby
  protocol.ts   esquemas de los mensajes
  security.ts   token, orígenes, IP real, Cloudflare Access, presupuesto de mensajes
  game.ts       colores y dificultad cooperativa
scripts/smoke.ts   prueba de punta a punta (npm test)
```

## Créditos

Servidor escrito con la ayuda de un agente de IA, con [Vicemi](https://vicemi.dev) como director del proyecto. *Xa* es de sus autores originales; este es un proyecto de fans sin fines de lucro.
