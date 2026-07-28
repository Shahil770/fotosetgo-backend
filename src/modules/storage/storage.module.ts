import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { PrismaService } from '../../prisma.service';
import { StorageService } from './storage.service';
import { StorageController } from './storage.controller';
import { PublicStorageController } from './public-storage.controller';
import { GoogleDriveService } from './google-drive.service';
import { GoogleDriveController } from './google-drive.controller';
import { DriveBackupCronService } from './drive-backup-cron.service';
import { TrashPurgeCronService } from './trash-purge-cron.service';
import { StaleUploadCronService } from './stale-upload-cron.service';

@Module({
  imports: [ScheduleModule.forRoot()],
  controllers: [StorageController, PublicStorageController, GoogleDriveController],
  providers: [StorageService, PrismaService, GoogleDriveService, DriveBackupCronService, TrashPurgeCronService, StaleUploadCronService],
  exports: [StorageService, GoogleDriveService],
})
export class StorageModule {}

