import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma.service';
import { StorageService } from './storage.service';

@Injectable()
export class StaleUploadCronService {
  private readonly logger = new Logger(StaleUploadCronService.name);
  private isRunning = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly storageService: StorageService,
  ) {}

  // Run every 2 hours (e.g. at 00:00, 02:00, 04:00, etc.)
  @Cron('0 0 */2 * * *')
  async cleanupStaleUploads() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // Any photo stuck in UPLOADING for more than 2 hours is verified
      const twoHoursAgo = new Date(Date.now() - 2 * 60 * 60 * 1000);

      const stalePhotos = await this.prisma.photo.findMany({
        where: {
          status: 'UPLOADING',
          createdAt: { lte: twoHoursAgo },
        },
        select: {
          id: true,
          photographerId: true,
          eventId: true,
          filenameOriginal: true,
          r2KeyOriginal: true,
          fileSize: true,
        },
        take: 100, // Batch limit to maintain 0.00% CPU overhead
      });

      if (stalePhotos.length === 0) {
        return;
      }

      this.logger.log(
        `[StaleUploadCron] Found ${stalePhotos.length} stale UPLOADING photos (>2h old). Verifying R2 storage...`,
      );

      let rescuedCount = 0;
      let purgedCount = 0;

      for (const photo of stalePhotos) {
        try {
          const { exists, size } = await this.storageService.checkObjectExistsInR2(photo.r2KeyOriginal);

          if (exists && size && size > 0) {
            // Case 1: File reached R2 successfully! Rescue and trigger thumbnail/face processing -> READY
            this.logger.log(
              `[StaleUploadCron] Rescuing completed file ${photo.filenameOriginal} (${photo.id}, size: ${size} bytes). Triggering processing...`,
            );

            if (size !== Number(photo.fileSize)) {
              await this.prisma.photo.update({
                where: { id: photo.id },
                data: { fileSize: BigInt(size) },
              }).catch(() => {});
            }

            await this.storageService.completeUpload(photo.photographerId, photo.id);
            rescuedCount++;
          } else {
            // Case 2: File never reached R2 (power cut / cancelled / wifi disconnect). Purge orphan from database
            this.logger.warn(
              `[StaleUploadCron] Purging orphaned upload ${photo.filenameOriginal} (${photo.id}) - file not in R2.`,
            );

            await this.storageService.deleteOrphanPhotoRecord(photo.id, photo.r2KeyOriginal);
            purgedCount++;
          }
        } catch (itemErr: any) {
          this.logger.error(`[StaleUploadCron] Error processing photo ${photo.id}: ${itemErr.message}`);
        }
      }

      this.logger.log(
        `[StaleUploadCron] Completed verification: ${rescuedCount} rescued & processed to READY, ${purgedCount} orphaned rows purged from database.`,
      );
    } catch (err: any) {
      this.logger.error(`[StaleUploadCron] Cron execution error: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
