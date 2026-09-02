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

  // Production vs Local Environment-aware CORS with full Subdomain support (*.localhost:3000 & *.fotosetgo.com)
  app.enableCors({
    origin: (origin, callback) => {
      // Allow requests with no origin (like mobile apps, curl, server-to-server)
      if (!origin) return callback(null, true);

      if (process.env.NODE_ENV === 'production') {
        const isAllowedProd =
          origin === 'https://fotosetgo.com' ||
          origin === 'https://admin.fotosetgo.com' ||
          origin === 'https://api.fotosetgo.com' ||
          origin.endsWith('.fotosetgo.com') ||
          origin.includes('localhost') ||
          origin.includes('127.0.0.1');
        return callback(null, isAllowedProd);
      } else {
        // Development mode: Allow localhost, 127.0.0.1, and subdomains like chitrkalaclicks.localhost:3000
        const isAllowedDev =
          origin.includes('localhost') ||
          origin.includes('127.0.0.1');
        return callback(null, isAllowedDev);
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With'],
  });

  await app.listen(process.env.PORT ?? 5000);
}
bootstrap();
