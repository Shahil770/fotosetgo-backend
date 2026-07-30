import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

@Injectable()
export class BillingService implements OnModuleInit {
  constructor(private prisma: PrismaService) { }

  async onModuleInit() {
    await this.seedPackages();
  }

  async seedPackages() {
    const defaultPackages = [
      {
        name: 'Free',
        maxStorageGb: 5,
        maxEventsStorageMb: 200,
        maxPortfolioStorageMb: 0,
        maxPhotosPerEvent: 50,
        faceSearchLimit: 20,
        allowCustomBranding: false,
        price: 0,
        isActive: true,
        featureAiPhotoSearch: true,
        featureAiVideoSearch: true,
        featureCustomBranding: false,
        featureClientSelection: true,
        featureGuestUpload: false,
        featurePortfolioWebsite: false,
        featureDigitalBusinessCard: false,
        featureAutoDriveBackup: false,
        featureDisableDownload: false,
        featureWatermark: false,
      },
      {
        name: 'Hobby',
        maxStorageGb: 25,
        maxEventsStorageMb: 25000,
        maxPortfolioStorageMb: 0,
        maxPhotosPerEvent: 999999,
        faceSearchLimit: -1,
        allowCustomBranding: false,
        price: 399900,
        isActive: true,
        featureAiPhotoSearch: false,
        featureAiVideoSearch: false,
        featureCustomBranding: false,
        featureClientSelection: true,
        featureGuestUpload: true,
        featurePortfolioWebsite: false,
        featureDigitalBusinessCard: false,
        featureAutoDriveBackup: false,
        featureDisableDownload: false,
        featureWatermark: true,
      },
      {
        name: 'Creator',
        maxStorageGb: 50,
        maxEventsStorageMb: 50000,
        maxPortfolioStorageMb: 2000,
        maxPhotosPerEvent: 999999,
        faceSearchLimit: -1,
        allowCustomBranding: false,
        price: 699900,
        isActive: true,
        featureAiPhotoSearch: true,
        featureAiVideoSearch: false,
        featureCustomBranding: true,
        featureClientSelection: true,
        featureGuestUpload: true,
        featurePortfolioWebsite: true,
        featureDigitalBusinessCard: true,
        featureAutoDriveBackup: false,
        featureDisableDownload: true,
        featureWatermark: true,
      },
      {
        name: 'Studio',
        maxStorageGb: 100,
        maxEventsStorageMb: 100000,
        maxPortfolioStorageMb: 10000,
        maxPhotosPerEvent: 999999,
        faceSearchLimit: -1,
        allowCustomBranding: true,
        price: 1199900,
        isActive: true,
        featureAiPhotoSearch: true,
        featureAiVideoSearch: true,
        featureCustomBranding: true,
        featureClientSelection: true,
        featureGuestUpload: true,
        featurePortfolioWebsite: true,
        featureDigitalBusinessCard: true,
        featureAutoDriveBackup: true,
        featureDisableDownload: true,
        featureWatermark: true,
      },
    ];

    for (const pkg of defaultPackages) {
      const exists = await this.prisma.package.findUnique({
        where: { name: pkg.name }
      });
      if (!exists) {
        await this.prisma.package.create({
          data: pkg
        });
      } else {
        const updateData: any = {};
        if (exists.maxEventsStorageMb === undefined || exists.maxEventsStorageMb === null) {
          updateData.maxEventsStorageMb = pkg.maxEventsStorageMb;
        }
        if (exists.maxPortfolioStorageMb === undefined || exists.maxPortfolioStorageMb === null) {
          updateData.maxPortfolioStorageMb = pkg.maxPortfolioStorageMb;
        }
        if (Object.keys(updateData).length > 0) {
          await this.prisma.package.update({
            where: { name: pkg.name },
            data: updateData
          });
        }
      }
    }
    console.log('[BillingService] Packages seeded/updated successfully in database.');
  }

  async getPlans() {
    return this.prisma.package.findMany({
      where: { isActive: true },
      orderBy: { price: 'asc' },
    });
  }

  async upgradePackage(photographerId: string, data: { packageName: string }) {
    const targetPackage = await this.prisma.package.findUnique({
      where: { name: data.packageName },
    });

    if (!targetPackage) {
      throw new NotFoundException(`Package ${data.packageName} not found`);
    }

    const eventsMb = targetPackage.maxEventsStorageMb || 5000;
    const portfolioMb = targetPackage.maxPortfolioStorageMb || 0;
    const limitEventsBytes = BigInt(eventsMb) * BigInt(1024 * 1024);
    const isPortfolioEnabled = targetPackage.featurePortfolioWebsite || targetPackage.featureCustomBranding;
    const limitPortfolioBytes = isPortfolioEnabled
      ? BigInt(portfolioMb * 1024 * 1024)
      : BigInt(0);
    const limitBytes = limitEventsBytes + limitPortfolioBytes;

    await this.prisma.subscription.updateMany({
      where: { photographerId, status: 'ACTIVE' },
      data: { status: 'EXPIRED' },
    });

    const sub = await this.prisma.subscription.create({
      data: {
        photographerId,
        packageId: targetPackage.id,
        startsAt: new Date(),
        endsAt: new Date(new Date().setFullYear(new Date().getFullYear() + 1)),
        status: 'ACTIVE',
        limitBytes,
        limitEventsBytes,
        limitPortfolioBytes,
        usedBytes: BigInt(0),
      },
    });

    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
    });
    if (photographer) {
      await this.prisma.subscription.update({
        where: { id: sub.id },
        data: { usedBytes: photographer.totalStorageUsedBytes }
      });
    }

    await this.prisma.photographer.update({
      where: { id: photographerId },
      data: {
        activePackageId: targetPackage.id,
      },
    });

    return {
      success: true,
      packageName: targetPackage.name,
      maxStorageGb: targetPackage.maxStorageGb,
      limitBytes: limitBytes.toString(),
    };
  }
}
