import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import { json, urlencoded } from 'express';
import compression from 'compression';

// Patch BigInt serialization globally to support database BigInt types
(BigInt.prototype as any).toJSON = function () {
  return this.toString();
};

import { ValidationPipe } from '@nestjs/common';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: process.env.NODE_ENV === 'production' ? ['error', 'warn'] : ['log', 'error', 'warn', 'debug', 'verbose'],
  });

  // Enable Gzip/Deflate compression for fast JSON API delivery and massive bandwidth savings
  app.use(compression());

  // Global Input Validation & DTO Whitelist Sanitization (Protects against Parameter Pollution)
  app.useGlobalPipes(new ValidationPipe({ whitelist: true, transform: true, forbidUnknownValues: false }));

  // Body payload limit set to safe 10MB
  app.use(json({ limit: '10mb' }));
  app.use(urlencoded({ limit: '10mb', extended: true }));

  app.setGlobalPrefix('api');

  // Universal CORS Configuration with full Subdomain support (*.fotosetgo.com & local dev)
  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);

      const isAllowed =
        origin === 'https://fotosetgo.com' ||
        origin === 'http://fotosetgo.com' ||
        origin === 'https://dashboard.fotosetgo.com' ||
        origin === 'http://dashboard.fotosetgo.com' ||
        origin === 'https://admin.fotosetgo.com' ||
        origin === 'https://api.fotosetgo.com' ||
        origin.endsWith('.fotosetgo.com') ||
        origin.includes('localhost') ||
        origin.includes('127.0.0.1');

      if (isAllowed) {
        return callback(null, true);
      }
      return callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'HEAD'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept', 'Origin'],
  });

  await app.listen(Number(process.env.PORT) || 5000, '127.0.0.1');
}
bootstrap();
