import { Injectable, CanActivate, ExecutionContext, ForbiddenException, mixin, Type } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

export const FeatureGuard = (requiredFeature: string): Type<CanActivate> => {
  @Injectable()
  class FeatureGuardMixin implements CanActivate {
    constructor(private prisma: PrismaService) {}

    async canActivate(context: ExecutionContext): Promise<boolean> {
      const request = context.switchToHttp().getRequest();
      const user = request.user;
      
      // If user session metadata check fails
      if (!user || !user.photographer || !user.photographer.id) {
        throw new ForbiddenException('User authentication mismatch or photographer scope missing.');
      }

      const activeSub = await this.prisma.subscription.findFirst({
        where: { 
          photographerId: user.photographer.id, 
          status: 'ACTIVE' 
        },
        include: {
          package: true
        },
        orderBy: { createdAt: 'desc' },
        take: 1
      });

      if (!activeSub) {
        throw new ForbiddenException('No active pricing plan subscription found. Please purchase a plan.');
      }

      // Read feature flag value from active package configuration
      const hasAccess = activeSub.package ? (activeSub.package as any)[requiredFeature] : false;
      
      if (!hasAccess) {
        throw new ForbiddenException(
          `This action requires a pricing plan upgrade. Feature not active: ${requiredFeature}`
        );
      }

      return true;
    }
  }

  return mixin(FeatureGuardMixin);
};
