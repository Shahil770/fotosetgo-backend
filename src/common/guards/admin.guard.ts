import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
  ForbiddenException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { PrismaService } from '../../prisma.service';

@Injectable()
export class AdminGuard implements CanActivate {
  constructor(
    private jwtService: JwtService,
    private prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const authHeader = request.headers['authorization'] || request.headers['Authorization'];

    if (!authHeader || typeof authHeader !== 'string') {
      throw new UnauthorizedException('Admin authorization token is missing.');
    }

    const [bearer, token] = authHeader.split(' ');
    if (bearer?.toLowerCase() !== 'bearer' || !token) {
      throw new UnauthorizedException('Invalid authorization format. Bearer token required.');
    }

    try {
      const payload = this.jwtService.verify(token, {
        secret: process.env.JWT_SECRET || '9f4e2a8c1d7b3e5a0f6c4b2e8d1a7f3e9c5b1d7e3a9f0c2b4d8e6a1f5c3b7e9a',
      });

      // Verify user from DB and ensure role is ADMIN
      const userId = payload.sub || payload.id;
      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, email: true, name: true, role: true, isActive: true },
      });

      if (!user || !user.isActive) {
        throw new UnauthorizedException('Admin account is inactive or not found.');
      }

      if (user.role !== 'ADMIN') {
        throw new ForbiddenException('Access denied. Administrator privileges required.');
      }

      request.user = user;
      request.adminUser = user;
      return true;
    } catch (err: any) {
      if (err instanceof ForbiddenException || err instanceof UnauthorizedException) {
        throw err;
      }
      throw new UnauthorizedException('Invalid or expired admin session token.');
    }
  }
}
