import {
  Injectable,
  CanActivate,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class ScannerGuard implements CanActivate {
  constructor(private configService: ConfigService) {}

  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    const providedKey =
      request.headers['x-worker-key'] ||
      (request.headers['authorization'] || '').replace(/^Bearer\s+/i, '');

    const expectedKey =
      this.configService.get<string>('WORKER_SECRET_KEY') ||
      'c78f9a2e4b1d6e5a8f0c3b2e9d7a1f5e';

    if (!providedKey || providedKey !== expectedKey) {
      throw new UnauthorizedException(
        'Invalid, expired, or missing Worker Secret Key authorization.',
      );
    }

    return true;
  }
}
