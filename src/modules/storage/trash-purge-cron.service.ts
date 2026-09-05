import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma.service';
import { StorageService } from './storage.service';

@Injectable()
export class TrashPurgeCronService {
  private readonly logger = new Logger(TrashPurgeCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
    @Inject('REDIS_CLIENT') private readonly redis: any,
  ) {}

  // Run once daily at 2 AM
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runAutoPurge() {
    const lockKey = 'lock:cron:trash-purge';
    let acquired: any = null;
    try {
      acquired = await this.redis.set(lockKey, '1', 'EX', 1800, 'NX');
    } catch {
      acquired = 'OK';
    }
    if (!acquired) {
      this.logger.log('[TrashPurge] Cron skipped — already running on another cluster instance.');
      return;
    }

    this.logger.log('[TrashPurge] Starting 30-day automated trash purge...');

    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // 1. Purge photos/videos in trash older than 30 days (Batch limit of 500 to keep RAM < 5MB)
      const expiredPhotos = await this.prisma.photo.findMany({
        where: {
          isDeleted: true,
          deletedAt: { lte: thirtyDaysAgo },
        },
        select: { id: true, photographerId: true, filenameOriginal: true },
        take: 500,
      });

      if (expiredPhotos.length > 0) {
        this.logger.log(`[TrashPurge] Found ${expiredPhotos.length} expired photos/videos (>30 days). Purging in high-speed batches...`);

        // Group by photographerId to execute 1 atomic batch delete per photographer
        const photographerPhotoMap = new Map<string, string[]>();
        for (const p of expiredPhotos) {
          const list = photographerPhotoMap.get(p.photographerId) || [];
          list.push(p.id);
          photographerPhotoMap.set(p.photographerId, list);
        }

        for (const [photographerId, photoIds] of photographerPhotoMap.entries()) {
          try {
            await this.storageService.batchDeletePhotos(photographerId, photoIds);
            this.logger.log(`[TrashPurge] Purged batch of ${photoIds.length} photos for photographer: ${photographerId}`);
          } catch (err: any) {
            this.logger.error(`[TrashPurge] Failed to purge photo batch for photographer ${photographerId}: ${err.message}`);
          }
        }
      }

      // 2. Purge events in trash older than 30 days (Batch limit of 50)
      const expiredEvents = await this.prisma.event.findMany({
        where: {
          isDeleted: true,
          deletedAt: { lte: thirtyDaysAgo },
        },
        select: { id: true, photographerId: true, title: true },
        take: 50,
      });

      if (expiredEvents.length > 0) {
        this.logger.log(`[TrashPurge] Found ${expiredEvents.length} expired events (>30 days). Purging...`);

        for (const e of expiredEvents) {
          try {
            await this.storageService.deleteEventObjectsFromR2(e.photographerId, e.id);
            await this.prisma.event.delete({ where: { id: e.id } });
            await this.storageService.recalculateStorage(e.photographerId);
            this.logger.log(`[TrashPurge] Purged event: ${e.title} (${e.id})`);
          } catch (err: any) {
            this.logger.error(`[TrashPurge] Failed to purge event ${e.id}: ${err.message}`);
          }
        }
      }
    } catch (err: any) {
      this.logger.error(`[TrashPurge] Cron execution error: ${err.message}`);
    } finally {
      await this.redis.del(lockKey).catch(() => {});
      this.logger.log('[TrashPurge] Automated trash purge complete.');
    }
  }
}
