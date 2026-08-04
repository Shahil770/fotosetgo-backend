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
        return new Redis({
          host,
          port,
          password,
          tls: {}, // SSL/TLS enabled for Upstash connection secure mode
        });
      },
      inject: [ConfigService],
    },
  ],
  exports: ['REDIS_CLIENT'],
})
export class RedisModule {}
