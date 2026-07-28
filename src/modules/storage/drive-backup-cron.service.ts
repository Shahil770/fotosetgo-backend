import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { PrismaService } from '../../prisma.service';
import { GoogleDriveService } from './google-drive.service';
import { S3Client } from '@aws-sdk/client-s3';

@Injectable()
export class DriveBackupCronService {
  private readonly logger = new Logger(DriveBackupCronService.name);
  private isRunning = false; // Prevent overlapping cron executions

  readonly s3Client: S3Client;
  readonly bucketName: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly googleDriveService: GoogleDriveService,
  ) {
    this.bucketName = process.env.R2_BUCKET_NAME || 'fotosetgo-photos';
    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: process.env.R2_ENDPOINT_URL || '',
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      },
      forcePathStyle: true,
    });
  }

  // Run every 15 minutes — also callable directly for immediate trigger
  @Cron('0 */15 * * * *')
  async runAutoBackup() {
    if (this.isRunning) {
      this.logger.warn('[DriveBackup] Cron skipped — previous run still in progress.');
      return;
    }

    this.isRunning = true;
    this.logger.log('[DriveBackup] Starting auto backup cron job...');

    try {
      // Find all photographers with auto backup enabled, Drive connected, and active subscription containing featureAutoDriveBackup
      const photographers = await this.prisma.photographer.findMany({
        where: {
          autoBackupToDrive: true,
          googleDriveConnected: true,
          googleDriveAccessToken: { not: null },
          subscriptions: {
            some: {
              status: 'ACTIVE',
              package: { featureAutoDriveBackup: true }
            }
          }
        },
        select: { id: true },
      });

      if (photographers.length === 0) {
        this.logger.log('[DriveBackup] No photographers with auto backup enabled.');
        return;
      }

      this.logger.log(`[DriveBackup] Processing ${photographers.length} photographer(s)...`);

      for (const photographer of photographers) {
        try {
          const result = await this.googleDriveService.backupAllPendingPhotos(
            photographer.id,
            this.s3Client,
            this.bucketName,
            this.prisma,
          );

          if (result.skippedDriveFull) {
            this.logger.warn(`[DriveBackup] Drive full for ${photographer.id} — auto backup disabled.`);
          } else {
            this.logger.log(`[DriveBackup] ${photographer.id}: +${result.backed} backed, ${result.failed} failed.`);
          }
        } catch (err) {
          this.logger.error(`[DriveBackup] Error for photographer ${photographer.id}: ${err.message}`);
        }
      }
    } finally {
      this.isRunning = false;
      this.logger.log('[DriveBackup] Cron job complete.');
    }
  }
}
