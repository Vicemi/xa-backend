// Express: la capa de afuera. Cabeceras de seguridad, CORS, límites de tasa, IP real del cliente, comprobación de
// Cloudflare Access, tope del cuerpo JSON y la API de Elysia montada encima con un pequeño puente Fetch <-> Express.
import cors from 'cors';
import express, { type Express, type RequestHandler } from 'express';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import helmet from 'helmet';
import { config } from './config.js';
import { IP_HEADER } from './api.js';
import { accessOk, clientIp, originAllowed } from './security.js';

/** Corre una app de Elysia (Fetch API: Request -> Response) como middleware de Express. */
function elysiaBridge(app: { handle(r: Request): Promise<Response> | Response }): RequestHandler {
  return async (req, res, next) => {
    try {
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (v !== undefined) headers.set(k, Array.isArray(v) ? v.join(', ') : v);
      headers.set(IP_HEADER, clientIp(req, req.ip));   // la ponemos nosotros, nunca el cliente
      const init: RequestInit = { method: req.method, headers };
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        headers.set('content-type', 'application/json');
        init.body = JSON.stringify(req.body ?? {});
        headers.delete('content-length');
      }
      const url = `${req.protocol}://${req.get('host') ?? 'localhost'}${req.originalUrl}`;
      const r = await app.handle(new Request(url, init));
      res.status(r.status);
      r.headers.forEach((v, k) => { if (k.toLowerCase() !== 'content-length') res.setHeader(k, v); });
      res.send(Buffer.from(await r.arrayBuffer()));
    } catch (e) {
      next(e);
    }
  };
}

export function buildHttp(api: { handle(r: Request): Promise<Response> | Response }): Express {
  const app = express();
  app.disable('x-powered-by');
  const tp = config.trustProxy;
  app.set('trust proxy', tp === 'true' ? true : tp === 'false' ? false : /^\d+$/.test(tp) ? Number(tp) : tp);

  app.use(helmet());
  app.use(cors({
    origin: (origin, cb) => cb(null, config.allowedOrigins.includes('*') || originAllowed(origin ?? undefined)),
    allowedHeaders: ['content-type', 'x-xa-token', 'authorization'],
    methods: ['GET', 'POST', 'OPTIONS'],
    maxAge: 600,
  }));

  const limiter = (limit: number) => rateLimit({
    windowMs: 60_000, limit, standardHeaders: 'draft-8', legacyHeaders: false,
    keyGenerator: (req) => ipKeyGenerator(clientIp(req, req.ip)),
    message: { error: 'rate_limited' },
  });
  app.use(limiter(config.httpRatePerMinute));
  app.post('/api/rooms', limiter(config.createRoomPerMinute));

  // comprobación de origen para navegadores (el token ya protege la API; esto evita que otro sitio use un token filtrado)
  app.use('/api', (req, res, next) => {
    if (req.method !== 'OPTIONS' && !originAllowed(req.headers.origin)) { res.status(403).json({ error: 'forbidden_origin' }); return; }
    next();
  });
  // Cloudflare Access (Zero Trust), solo cuando está configurado como obligatorio
  app.use(async (req, res, next) => {
    if (config.cfAccessRequired && req.path !== '/health' && !(await accessOk(req.headers))) { res.status(401).json({ error: 'access_required' }); return; }
    next();
  });

  app.use(express.json({ limit: '2kb' }));
  app.use(['/api', '/health'], elysiaBridge(api));
  app.use((_req, res) => { res.status(404).json({ error: 'not_found' }); });
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use(((err, _req, res, _next) => {
    const bad = (err as { status?: number })?.status;
    res.status(bad && bad < 500 ? bad : 500).json({ error: bad && bad < 500 ? 'bad_request' : 'server_error' });
  }) as express.ErrorRequestHandler);
  return app;
}
