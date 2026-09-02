import { Injectable, UnauthorizedException, Inject } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma.service';
import Redis from 'ioredis';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(
    private prisma: PrismaService,
    @Inject('REDIS_CLIENT') private redis: Redis,
  ) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'supersecretjwtsecret123456!',
    });
  }

  async validate(payload: { sub: string; email: string }) {
    const cacheKey = `cache:jwt:user:${payload.sub}`;

    // 1. Try fetching from ultra-fast in-memory Redis cache (sub-millisecond response)
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (_) {
      // Graceful fallback if Redis is temporarily offline: continue to DB
    }

    // 2. Query database when cache misses
    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      include: {
        photographer: {
          include: {
            subscriptions: {
              where: { status: 'ACTIVE' },
              include: { package: true },
            },
          },
        },
      },
    });

    if (!user || !user.isActive) {
      throw new UnauthorizedException('User is inactive or not found');
    }

    // Fast zero-query storage resolution: use direct stored totalStorageUsedBytes
    if (user.photographer) {
      (user.photographer as any).eventsStorageUsedBytes = user.photographer.totalStorageUsedBytes?.toString() || '0';
    }

    // 3. Cache the resolved user object in Redis for 120s (prevents heavy repeated SQL JOIN queries)
    try {
      await this.redis.setex(cacheKey, 120, JSON.stringify(user));
    } catch (_) {
      // Non-blocking catch
    }

    return user;
  }
}
