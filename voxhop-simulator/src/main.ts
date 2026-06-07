import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import { WsAdapter } from '@nestjs/platform-ws';
import { AppModule } from './app.module';
import { join } from 'path';
import * as fs from 'fs';

/**
 * VoxHop Simulator — NestJS bootstrap
 *
 * M-01: COOP/COEP app.use() middleware MUST be registered BEFORE useStaticAssets().
 *       Getting this wrong breaks SharedArrayBuffer silently.
 * ER-05: Self-signed cert fallback for startup before make issue-cert runs.
 */
async function bootstrap() {
  // ─── TLS Configuration (ER-05) ─────────────────────────────────────────────
  // Priority: 1) Let's Encrypt cert  2) Self-signed fallback  3) HTTP only
  const leCertPath = '/etc/letsencrypt/live/simulator.voxhop.borshik.net/fullchain.pem';
  const leKeyPath = '/etc/letsencrypt/live/simulator.voxhop.borshik.net/privkey.pem';
  const selfSignedCertPath = join(__dirname, '..', 'certs', 'self-signed.crt');
  const selfSignedKeyPath = join(__dirname, '..', 'certs', 'self-signed.key');

  let httpsOptions: { key: Buffer; cert: Buffer } | undefined;

  if (fs.existsSync(leCertPath) && fs.existsSync(leKeyPath)) {
    httpsOptions = {
      key: fs.readFileSync(leKeyPath),
      cert: fs.readFileSync(leCertPath),
    };
    console.log('[voxhop-simulator] Using Let\'s Encrypt TLS certificate');
  } else if (fs.existsSync(selfSignedCertPath) && fs.existsSync(selfSignedKeyPath)) {
    httpsOptions = {
      key: fs.readFileSync(selfSignedKeyPath),
      cert: fs.readFileSync(selfSignedCertPath),
    };
    console.log('[voxhop-simulator] Using self-signed TLS certificate (run make issue-cert for production cert)');
  } else {
    console.log('[voxhop-simulator] No TLS certificate found — running in HTTP mode');
  }

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    httpsOptions,
    logger: ['log', 'warn', 'error'],
  });

  // ─── M-12: Native WS adapter — MUST be registered before listen() ─────────
  // Without this, NestJS defaults to socket.io and crashes with "No driver selected".
  // @nestjs/platform-ws provides the raw ws driver that SimulatorGateway expects.
  app.useWebSocketAdapter(new WsAdapter(app));

  // ─── M-01: COOP/COEP middleware BEFORE useStaticAssets() ─────────────────
  // CRITICAL: This ordering is mandatory. Registering COOP/COEP after
  // useStaticAssets() silently omits the headers from static file responses,
  // breaking SharedArrayBuffer availability (ER-01).
  if (process.env.COOP_COEP_ENABLED !== 'false') {
    app.use((_req: any, res: any, next: any) => {
      res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
      res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
      next();
    });
  }

  // ─── Static file serving (React SPA) — AFTER COOP/COEP middleware (M-01) ─
  const staticDir = join(__dirname, '..', 'static');
  if (fs.existsSync(staticDir)) {
    app.useStaticAssets(staticDir);
  }

  // ─── Port configuration ───────────────────────────────────────────────────
  // SIMULATOR_PORT defaults to 4443 for local dev (avoid needing root for 443).
  // Docker Compose maps host:443 → container:443 (SIMULATOR_PORT unset in Docker).
  const port = parseInt(process.env.SIMULATOR_PORT ?? '4443', 10);

  await app.listen(port);
  console.log(`[voxhop-simulator] Listening on port ${port} (${httpsOptions ? 'HTTPS' : 'HTTP'})`);
}

bootstrap();
