import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma.service';
import { StorageService } from './storage.service';

@Injectable()
export class TrashPurgeCronService {
  private readonly logger = new Logger(TrashPurgeCronService.name);
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {}

  // Run once daily at 2 AM
  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async runAutoPurge() {
    if (this.isRunning) return;
    this.isRunning = true;
    this.logger.log('[TrashPurge] Starting 30-day automated trash purge...');

    try {
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      // 1. Purge photos/videos in trash older than 30 days
      const expiredPhotos = await this.prisma.photo.findMany({
        where: {
          isDeleted: true,
          deletedAt: { lte: thirtyDaysAgo },
        },
        select: { id: true, photographerId: true, filenameOriginal: true },
      });

      this.logger.log(`[TrashPurge] Found ${expiredPhotos.length} expired photos/videos (>30 days). Purging...`);

      for (const p of expiredPhotos) {
        try {
          await this.storageService.deletePhoto(p.photographerId, p.id);
          this.logger.log(`[TrashPurge] Purged photo: ${p.filenameOriginal} (${p.id})`);
        } catch (err) {
          this.logger.error(`[TrashPurge] Failed to purge photo ${p.id}: ${err.message}`);
        }
      }

      // 2. Purge events in trash older than 30 days
      const expiredEvents = await this.prisma.event.findMany({
        where: {
          isDeleted: true,
          deletedAt: { lte: thirtyDaysAgo },
        },
        select: { id: true, photographerId: true, title: true },
      });

      this.logger.log(`[TrashPurge] Found ${expiredEvents.length} expired events (>30 days). Purging...`);

      for (const e of expiredEvents) {
        try {
          await this.storageService.deleteEventObjectsFromR2(e.photographerId, e.id);
          await this.prisma.event.delete({ where: { id: e.id } });
          await this.storageService.recalculateStorage(e.photographerId);
          this.logger.log(`[TrashPurge] Purged event: ${e.title} (${e.id})`);
        } catch (err) {
          this.logger.error(`[TrashPurge] Failed to purge event ${e.id}: ${err.message}`);
        }
      }
    } catch (err) {
      this.logger.error(`[TrashPurge] Cron execution error: ${err.message}`);
    } finally {
      this.isRunning = false;
      this.logger.log('[TrashPurge] Automated trash purge complete.');
    }
  }
}
