import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma.service';

@Injectable()
export class StaleUploadCronService {
  private readonly logger = new Logger(StaleUploadCronService.name);
  private isRunning = false;

  constructor(private readonly prisma: PrismaService) {}

  // Run every hour to clean up stale uploads
  @Cron('0 0 * * * *')
  async cleanupStaleUploads() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      // Any photo stuck in UPLOADING for more than 30 minutes is considered stale
      const thirtyMinutesAgo = new Date(Date.now() - 30 * 60 * 1000);

      const stalePhotos = await this.prisma.photo.findMany({
        where: {
          status: 'UPLOADING',
          createdAt: { lte: thirtyMinutesAgo },
        },
        select: { id: true, filenameOriginal: true, eventId: true },
      });

      if (stalePhotos.length === 0) {
        return;
      }

      this.logger.warn(
        `[StaleUploadCleanup] Found ${stalePhotos.length} stale UPLOADING photos (>30min). Marking as FAILED...`,
      );

      const ids = stalePhotos.map((p) => p.id);

      await this.prisma.photo.updateMany({
        where: { id: { in: ids } },
        data: { status: 'FAILED' },
      });

      for (const p of stalePhotos) {
        this.logger.warn(
          `[StaleUploadCleanup] Marked FAILED: ${p.filenameOriginal} (${p.id}) in event ${p.eventId}`,
        );
      }

      this.logger.log(`[StaleUploadCleanup] Done. ${stalePhotos.length} stale uploads cleaned up.`);
    } catch (err) {
      this.logger.error(`[StaleUploadCleanup] Error during cleanup: ${err.message}`);
    } finally {
      this.isRunning = false;
    }
  }
}
