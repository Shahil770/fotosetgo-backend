import { Injectable, UnauthorizedException } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { PrismaService } from '../../prisma.service';

@Injectable()
export class JwtStrategy extends PassportStrategy(Strategy) {
  constructor(private prisma: PrismaService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: process.env.JWT_SECRET || 'supersecretjwtsecret123456!',
    });
  }

  async validate(payload: { sub: string; email: string }) {
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

    // Calculate events-only storage used (from Photo table, excludes portfolio/branding)
    if (user.photographer) {
      const eventsAgg = await this.prisma.photo.aggregate({
        where: { photographerId: user.photographer.id, deletedAt: null },
        _sum: { fileSize: true },
      });
      (user.photographer as any).eventsStorageUsedBytes = eventsAgg._sum.fileSize
        ? eventsAgg._sum.fileSize.toString()
        : '0';
    }

    return user;
  }
}
