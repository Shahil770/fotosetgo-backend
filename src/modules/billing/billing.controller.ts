import { Controller, Post, Get, Body, UseGuards } from '@nestjs/common';
import { BillingService } from './billing.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma.service';

@Controller('billing')
export class BillingController {
  constructor(
    private billingService: BillingService,
    private prismaService: PrismaService
  ) {}

  @Get('plans')
  async getPlans() {
    return this.billingService.getPlans();
  }

  @UseGuards(JwtAuthGuard)
  @Post('upgrade')
  async upgradePackage(
    @CurrentUser() user: any,
    @Body() body: { packageName: string; paymentId: string },
  ) {
    return this.billingService.upgradePackage(user.photographer.id, {
      packageName: body.packageName,
    });
  }

  @Get('admin/packages')
  async adminGetPackages() {
    // Admin dashboard gets all packages to render the matrix
    return this.prismaService.package.findMany({
      orderBy: { price: 'asc' }
    });
  }

  @Post('admin/packages')
  async adminSavePackages(
    @Body() body: {
      plans: Array<{
        id: string;
        name: string;
        priceMonthly: number;
        storageGB: number;
        maxEventsStorageMb?: number;
        maxPortfolioStorageMb?: number;
        faceSearchLimit: number;
        features: {
          featureAiPhotoSearch: boolean;
          featureAiVideoSearch: boolean;
          featureCustomBranding: boolean;
          featureClientSelection: boolean;
          featureGuestUpload: boolean;
          featurePortfolioWebsite: boolean;
          featureDigitalBusinessCard: boolean;
          featureAutoDriveBackup: boolean;
          featureDisableDownload: boolean;
          featureWatermark: boolean;
        }
      }>
    }
  ) {
    for (const plan of body.plans) {
      await this.prismaService.package.update({
        where: { id: plan.id },
        data: {
          price: plan.priceMonthly * 100, // convert Rs to Paisa
          maxStorageGb: plan.storageGB,
          maxEventsStorageMb: plan.maxEventsStorageMb !== undefined ? plan.maxEventsStorageMb : (plan.storageGB * 1024),
          maxPortfolioStorageMb: plan.maxPortfolioStorageMb !== undefined ? plan.maxPortfolioStorageMb : 0,
          faceSearchLimit: plan.faceSearchLimit,
          featureAiPhotoSearch: plan.features.featureAiPhotoSearch,
          featureAiVideoSearch: plan.features.featureAiVideoSearch,
          featureCustomBranding: plan.features.featureCustomBranding,
          featureClientSelection: plan.features.featureClientSelection,
          featureGuestUpload: plan.features.featureGuestUpload,
          featurePortfolioWebsite: plan.features.featurePortfolioWebsite,
          featureDigitalBusinessCard: plan.features.featureDigitalBusinessCard,
          featureAutoDriveBackup: plan.features.featureAutoDriveBackup,
          featureDisableDownload: plan.features.featureDisableDownload,
          featureWatermark: plan.features.featureWatermark,
        }
      });
    }
    return { success: true };
  }
}
