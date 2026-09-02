import { Module, Global } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Global()
@Module({
  providers: [
    {
      provide: 'REDIS_CLIENT',
      useFactory: (config: ConfigService) => {
        const host = config.get<string>('REDIS_HOST');
        const port = config.get<number>('REDIS_PORT') || 6379;
        const password = config.get<string>('REDIS_PASSWORD');
        const isLocal = host && (host === '127.0.0.1' || host === 'localhost' || host.startsWith('172.'));
        const client = new Redis({
          host,
          port,
          password: password || undefined,
          tls: isLocal ? undefined : {}, // Disable TLS for local WSL Redis connections, keep enabled for Upstash Cloud
          connectTimeout: 2000, // 2 seconds connect timeout max
          maxRetriesPerRequest: null, // Allow continuous retrying in background without crashing
        });
        client.on('error', (err) => {
          // Log error but do not let it crash the process
          console.error('[Redis] Connection error caught:', err.message);
        });
        return client;
      },
      inject: [ConfigService],
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
