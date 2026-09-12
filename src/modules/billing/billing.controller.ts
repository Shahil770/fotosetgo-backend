import { Controller, Post, Get, Patch, Delete, Body, UseGuards, Headers, Param, Query, UnauthorizedException, Inject } from '@nestjs/common';
import { BillingService } from './billing.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PrismaService } from '../../prisma.service';
import Redis from 'ioredis';

@Controller('billing')
export class BillingController {
  constructor(
    private billingService: BillingService,
    private prismaService: PrismaService,
    @Inject('REDIS_CLIENT') private redis: Redis,
  ) {}

  @Get('plans')
  async getPlans() {
    return this.billingService.getPlans();
  }

  @Get('credit-packs')
  async getCreditPacks() {
    return this.billingService.getAiCreditPacks();
  }

  @UseGuards(AdminGuard)
  @Get('admin/credit-packs')
  async adminGetCreditPacks() {
    return this.billingService.adminGetAiCreditPacks();
  }

  @UseGuards(AdminGuard)
  @Post('admin/credit-packs')
  async adminSaveCreditPacks(@Body() body: { packs: any[] }) {
    return this.billingService.adminSaveAiCreditPacks(body.packs);
  }

  /* ==========================================================================
     PROMO CODE ENDPOINTS
     ========================================================================== */

  @UseGuards(JwtAuthGuard)
  @Post('promo/validate')
  async validatePromo(
    @CurrentUser() user: any,
    @Body() body: {
      code: string;
      orderType: 'SUBSCRIPTION' | 'CREDIT_TOPUP';
      baseSubtotalRupees: number;
    }
  ) {
    return this.billingService.validatePromoCode(user.photographer.id, body);
  }

  @UseGuards(AdminGuard)
  @Get('admin/promocodes')
  async adminGetPromoCodes() {
    return this.billingService.adminGetPromoCodes();
  }

  @UseGuards(AdminGuard)
  @Post('admin/promocodes')
  async adminCreatePromoCode(@Body() body: any) {
    return this.billingService.adminCreatePromoCode(body);
  }

  @UseGuards(AdminGuard)
  @Patch('admin/promocodes/:id/status')
  async adminTogglePromoCode(
    @Param('id') id: string,
    @Body() body: { isActive: boolean }
  ) {
    return this.billingService.adminTogglePromoCode(id, body.isActive);
  }

  @UseGuards(AdminGuard)
  @Delete('admin/promocodes/:id')
  async adminDeletePromoCode(@Param('id') id: string) {
    return this.billingService.adminDeletePromoCode(id);
  }

  @UseGuards(JwtAuthGuard)
  @Get('upgrade-preview/:packageId')
  async getUpgradePreview(
    @CurrentUser() user: any,
    @Param('packageId') packageId: string,
    @Query('years') years?: string,
  ) {
    const yearsCount = Math.min(3, Math.max(1, Number(years) || 1));
    return this.billingService.getUpgradePreview(user.photographer.id, packageId, yearsCount);
  }

  @UseGuards(JwtAuthGuard)
  @Post('razorpay/create-order')
  async createRazorpayOrder(
    @CurrentUser() user: any,
    @Body() body: {
      packageId?: string;
      packageName?: string;
      orderType?: 'SUBSCRIPTION' | 'CREDIT_TOPUP';
      creditPackId?: string;
      creditAmountPaise?: number;
      yearsCount?: number;
      promoCode?: string;
    }
  ) {
    return this.billingService.createRazorpayOrder(user.photographer.id, body);
  }

  @UseGuards(JwtAuthGuard)
  @Post('razorpay/verify-payment')
  async verifyRazorpayPayment(
    @CurrentUser() user: any,
    @Body() body: {
      orderId: string;
      paymentId: string;
      signature: string;
      packageId?: string;
      orderType?: 'SUBSCRIPTION' | 'CREDIT_TOPUP';
      creditAmountPaise?: number;
    }
  ) {
    return this.billingService.verifyRazorpayPayment(user.photographer.id, body);
  }

  @Post('razorpay/webhook')
  async razorpayWebhook(
    @Body() body: any,
    @Headers('x-razorpay-signature') signature: string
  ) {
    return this.billingService.handleRazorpayWebhook(body, signature);
  }

  @UseGuards(JwtAuthGuard)
  @Get('invoices')
  async getInvoices(@CurrentUser() user: any) {
    return this.billingService.getInvoices(user.photographer.id);
  }

  @Post('inquiry')
  async submitPlanInquiry(
    @Body() body: {
      photographerId?: string;
      photographerName?: string;
      email?: string;
      phone?: string;
      interestedIn: string;
      eventDate?: string;
      requirements?: string;
      source?: string;
    }
  ) {
    return this.billingService.submitPlanInquiry(body);
  }

  @UseGuards(AdminGuard)
  @Get('admin/inquiries')
  async adminGetInquiries() {
    return this.billingService.adminGetPlanInquiries();
  }

  @UseGuards(AdminGuard)
  @Get('admin/packages')
  async adminGetPackages() {
    // Admin dashboard gets all packages to render the matrix
    return this.prismaService.package.findMany({
      orderBy: { price: 'asc' }
    });
  }

  @UseGuards(AdminGuard)
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
        faceScanCredits?: number; // in Rupees
        firstTimeDiscount1Yr?: number;
        firstTimeDiscount2Yr?: number;
        firstTimeDiscount3Yr?: number;
        standardDiscount1Yr?: number;
        standardDiscount2Yr?: number;
        standardDiscount3Yr?: number;
        tax?: number;
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
          featureBeamLiveCamera?: boolean;
          featureBulkDownload?: boolean;
        }
      }>
    }
  ) {
    for (const plan of body.plans) {
      const maxEventsMb = plan.maxEventsStorageMb !== undefined ? plan.maxEventsStorageMb : (plan.storageGB * 1024);
      const maxPortfolioMb = plan.maxPortfolioStorageMb !== undefined ? plan.maxPortfolioStorageMb : 0;
      const limitEventsBytes = BigInt(maxEventsMb) * BigInt(1024 * 1024);
      const isPortfolioEnabled = plan.features.featurePortfolioWebsite || plan.features.featureCustomBranding;
      const limitPortfolioBytes = isPortfolioEnabled ? BigInt(maxPortfolioMb * 1024 * 1024) : BigInt(0);
      const limitBytes = limitEventsBytes + limitPortfolioBytes;

      await this.prismaService.package.update({
        where: { id: plan.id },
        data: {
          price: plan.priceMonthly * 100, // convert Rs to Paisa
          maxStorageGb: plan.storageGB,
          maxEventsStorageMb: maxEventsMb,
          maxPortfolioStorageMb: maxPortfolioMb,
          faceScanCredits: plan.faceScanCredits !== undefined ? Math.round(plan.faceScanCredits * 100) : 0, // convert Rupees to Paise
          firstTimeDiscount1Yr: plan.firstTimeDiscount1Yr !== undefined ? plan.firstTimeDiscount1Yr : undefined,
          firstTimeDiscount2Yr: plan.firstTimeDiscount2Yr !== undefined ? plan.firstTimeDiscount2Yr : undefined,
          firstTimeDiscount3Yr: plan.firstTimeDiscount3Yr !== undefined ? plan.firstTimeDiscount3Yr : undefined,
          standardDiscount1Yr: plan.standardDiscount1Yr !== undefined ? plan.standardDiscount1Yr : undefined,
          standardDiscount2Yr: plan.standardDiscount2Yr !== undefined ? plan.standardDiscount2Yr : undefined,
          standardDiscount3Yr: plan.standardDiscount3Yr !== undefined ? plan.standardDiscount3Yr : undefined,
          tax: plan.tax !== undefined ? Number(plan.tax) : undefined,
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
          featureBeamLiveCamera: plan.features.featureBeamLiveCamera ?? false,
          featureBulkDownload: plan.features.featureBulkDownload ?? false,
        }
      });

      // Invalidate Redis profile caches for instant reflection
      try {
        const userKeys = await this.redis.keys('cache:jwt:user:*');
        if (userKeys && userKeys.length > 0) {
          await this.redis.del(...userKeys);
        }
      } catch (_) {}

      // Synchronize all active subscriptions tied to this package
      await this.prismaService.subscription.updateMany({
        where: { packageId: plan.id, status: 'ACTIVE' },
        data: {
          limitEventsBytes,
          limitPortfolioBytes,
          limitBytes,
        }
      });

      // Auto-sync events for all photographers currently subscribed to this package
      const eventUpdateData: any = {};
      if (!plan.features.featureAiPhotoSearch) {
        eventUpdateData.faceScanningEnabled = false;
      }
      if (!plan.features.featureAiVideoSearch) {
        eventUpdateData.videoScanningEnabled = false;
      }
      if (!plan.features.featureClientSelection) {
        eventUpdateData.allowFavorites = false;
      }
      if (!plan.features.featureWatermark) {
        eventUpdateData.watermarkEnabled = false;
      }

      if (Object.keys(eventUpdateData).length > 0) {
        await this.prismaService.event.updateMany({
          where: {
            photographer: {
              subscriptions: {
                some: {
                  packageId: plan.id,
                  status: 'ACTIVE'
                }
              }
            }
          },
          data: eventUpdateData
        });
      }
    }

    try {
      const keys = await this.redis.keys('cache:public:event:*');
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (err) {
      console.error('[BillingController] Failed to purge event caches:', err);
    }

    return { success: true };
  }

  @UseGuards(AdminGuard)
  @Get('admin/photographers')
  async adminGetPhotographers() {
    const photographers = await this.prismaService.photographer.findMany({
      include: {
        user: {
          select: {
            name: true,
            email: true,
            phone: true,
            isActive: true,
          }
        },
        subscriptions: {
          where: { status: 'ACTIVE' },
          include: { package: true }
        }
      },
      orderBy: { createdAt: 'desc' }
    });

    return photographers.map(p => ({
      id: p.id,
      name: p.user?.name || p.studioName || 'Unnamed Studio',
      email: p.user?.email || '',
      studioSubdomain: p.studioSubdomain || '',
      plan: p.subscriptions?.[0]?.package?.name || 'FREE',
      creditBalance: p.creditBalance || 0, // in Paise
      storageUsed: Number(p.totalStorageUsedBytes), // in bytes
      storageLimit: Number(p.subscriptions?.[0]?.limitBytes || 5242880000), // in bytes
      status: p.user?.isActive ? 'ACTIVE' : 'INACTIVE',
      joinedDate: p.createdAt.toISOString().split('T')[0],
      startsAt: p.subscriptions?.[0]?.startsAt,
      endsAt: p.subscriptions?.[0]?.endsAt,
    }));
  }

  @UseGuards(AdminGuard)
  @Post('admin/photographers/plan')
  async adminUpdatePhotographerPlan(
    @Body() body: { photographerId: string; packageName: string }
  ) {
    const { photographerId, packageName } = body;
    return this.billingService.upgradePackage(photographerId, { packageName });
  }

  @UseGuards(JwtAuthGuard)
  @Get('credits/history')
  async getCreditHistory(@CurrentUser() user: any) {
    return this.prismaService.creditTransaction.findMany({
      where: { photographerId: user.photographer.id },
      orderBy: { createdAt: 'desc' }
    });
  }

  @UseGuards(AdminGuard)
  @Post('admin/photographers/credits')
  async adminAddPhotographerCredits(
    @Body() body: { photographerId: string; amountRupees: number; mode?: 'ADD' | 'SET' }
  ) {
    const { photographerId, amountRupees, mode = 'ADD' } = body;
    const amountPaise = Math.round(amountRupees * 100);

    const photographer = await this.prismaService.photographer.findUnique({
      where: { id: photographerId }
    });
    if (!photographer) {
      throw new Error('Photographer not found');
    }

    let finalAmountPaise = amountPaise;
    let actionType = 'ADMIN_ADD';
    let desc = `Admin added ₹${amountRupees.toFixed(2)} credits`;

    if (mode === 'SET') {
      finalAmountPaise = amountPaise - photographer.creditBalance;
      actionType = 'ADMIN_SET';
      desc = `Admin updated balance from ₹${(photographer.creditBalance / 100).toFixed(2)} to ₹${amountRupees.toFixed(2)}`;
    }

    const updated = await this.prismaService.photographer.update({
      where: { id: photographerId },
      data: {
        creditBalance: mode === 'SET' ? amountPaise : { increment: amountPaise }
      }
    });

    await this.prismaService.creditTransaction.create({
      data: {
        photographerId,
        amount: finalAmountPaise,
        action: actionType,
        description: desc
      }
    });

    return {
      success: true,
      creditBalance: updated.creditBalance
    };
  }
}
