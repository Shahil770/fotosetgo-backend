import { Controller, Get, Post, Body, Query, Res, UseGuards, Req, Delete, Param, ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';
import { GoogleDriveService } from './google-drive.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { PrismaService } from '../../prisma.service';
import { DriveBackupCronService } from './drive-backup-cron.service';

@Controller('google-drive')
export class GoogleDriveController {
  constructor(
    private readonly googleDriveService: GoogleDriveService,
    private readonly prisma: PrismaService,
    private readonly driveBackupCron: DriveBackupCronService,
  ) {}

  // Auth Redirect Link Generator
  @UseGuards(JwtAuthGuard)
  @Get('auth-url')
  async getAuthUrl(@Req() req: any) {
    const photographerId = req.user.photographer?.id || req.user.id;
    const url = this.googleDriveService.getAuthUrl(photographerId);
    return { url };
  }

  // Auth Callback URL Handler (Google redirects user here after login)
  @Get('callback')
  async handleCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() res: Response,
  ) {
    const dashboardUrl = process.env.DASHBOARD_URL || 
      (process.env.NODE_ENV === 'production' ? 'https://dashboard.fotosetgo.com' : 'http://localhost:3000');
    try {
      const photographerId = state;
      await this.googleDriveService.handleCallback(code, photographerId);
      return res.redirect(`${dashboardUrl}/dashboard/storage?drive=connected`);
    } catch (err) {
      console.error('[GoogleDrive] Auth callback failed:', err);
      return res.redirect(`${dashboardUrl}/dashboard/storage?drive=error`);
    }
  }

  // Disconnect Google Drive
  @UseGuards(JwtAuthGuard)
  @Get('disconnect')
  async disconnectDriveGet(@Req() req: any) {
    const photographerId = req.user.photographer?.id || req.user.id;
    await this.googleDriveService.disconnect(photographerId);
    return { disconnected: true };
  }

  @UseGuards(JwtAuthGuard)
  @Post('disconnect')
  async disconnectDrive(@Req() req: any) {
    const photographerId = req.user.photographer?.id || req.user.id;
    await this.googleDriveService.disconnect(photographerId);
    return { disconnected: true };
  }

  // Get User's Drive Files List
  @UseGuards(JwtAuthGuard)
  @Get('files')
  async getFiles(@Req() req: any, @Query('folderId') folderId?: string) {
    const photographerId = req.user.photographer?.id || req.user.id;
    return this.googleDriveService.listFoldersAndFiles(photographerId, folderId);
  }

  // Get Storage Quota Information
  @UseGuards(JwtAuthGuard)
  @Get('quota')
  async getQuota(@Req() req: any) {
    const photographerId = req.user.photographer?.id || req.user.id;
    return this.googleDriveService.getStorageQuota(photographerId);
  }

  // Toggle auto backup ON/OFF
  @UseGuards(JwtAuthGuard)
  @Post('toggle-auto-backup')
  async toggleAutoBackup(
    @Req() req: any,
    @Body() body: { enabled: boolean },
  ) {
    const photographerId = req.user.photographer?.id || req.user.id;

    if (body.enabled) {
      const activeSub = await this.prisma.subscription.findFirst({
        where: { photographerId, status: 'ACTIVE' },
        include: { package: true },
        orderBy: { createdAt: 'desc' }
      });
      const hasAutoBackup = activeSub?.package ? activeSub.package.featureAutoDriveBackup : false;
      if (!hasAutoBackup) {
        throw new ForbiddenException('Auto Google Drive Backup is only available on PRO plans.');
      }
    }

    await this.prisma.photographer.update({
      where: { id: photographerId },
      data: {
        autoBackupToDrive: body.enabled,
        ...(body.enabled ? { driveBackupFullNotified: false } : {}),
      },
    });

    // If turning ON → trigger immediate backup in background
    if (body.enabled) {
      this.triggerBackupForPhotographer(photographerId).catch(err =>
        console.error('[DriveBackup] Immediate trigger failed:', err)
      );
    }

    return { autoBackupToDrive: body.enabled, immediateBackupTriggered: body.enabled };
  }

  // Direct backup trigger for a single photographer (bypasses cron isRunning guard)
  private async triggerBackupForPhotographer(photographerId: string) {
    const s3Client = (this.driveBackupCron as any).s3Client;
    const bucketName = (this.driveBackupCron as any).bucketName;
    const result = await this.googleDriveService.backupAllPendingPhotos(
      photographerId,
      s3Client,
      bucketName,
      this.prisma,
    );
    console.log(`[DriveBackup] Immediate backup done for ${photographerId}:`, result);
    return result;
  }

  // Manual "Backup Now" button endpoint — returns result directly
  @UseGuards(JwtAuthGuard)
  @Post('run-backup-now')
  async runBackupNow(@Req() req: any) {
    const photographerId = req.user.photographer?.id || req.user.id;
    const result = await this.triggerBackupForPhotographer(photographerId);
    return result;
  }

  // Get backup status — how many photos are backed up vs pending
  @UseGuards(JwtAuthGuard)
  @Get('backup-status')
  async getBackupStatus(@Req() req: any) {
    const photographerId = req.user.photographer?.id || req.user.id;

    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
      select: {
        autoBackupToDrive: true,
        googleDriveConnected: true,
        driveBackupFullNotified: true,
      },
    });

    const totalReady = await this.prisma.photo.count({
      where: { photographerId, status: 'READY', isDeleted: false },
    });

    const backedUp = await this.prisma.photo.count({
      where: { photographerId, status: 'READY', isDeleted: false, backedUpToDrive: true },
    });

    const pending = totalReady - backedUp;

    let isFullNotified = photographer?.driveBackupFullNotified ?? false;
    if (isFullNotified && photographer?.googleDriveConnected) {
      try {
        const spaceCheck = await this.googleDriveService.checkDriveHasSpace(photographerId);
        if (spaceCheck.hasSpace) {
          await this.prisma.photographer.update({
            where: { id: photographerId },
            data: { driveBackupFullNotified: false },
          });
          isFullNotified = false;
        }
      } catch {}
    }

    return {
      autoBackupToDrive: photographer?.autoBackupToDrive ?? false,
      googleDriveConnected: photographer?.googleDriveConnected ?? false,
      driveBackupFullNotified: isFullNotified,
      totalReady,
      backedUp,
      pending,
    };
  }

  // Delete folder or file endpoint
  @UseGuards(JwtAuthGuard)
  @Delete('files/:fileId')
  async deleteItem(
    @Req() req: any,
    @Param('fileId') fileId: string,
  ) {
    const photographerId = req.user.photographer?.id || req.user.id;
    const success = await this.googleDriveService.deleteFileOrFolder(photographerId, fileId);
    return { success };
  }
}
