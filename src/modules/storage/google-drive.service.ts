import { Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import { PrismaService } from 'src/prisma.service';
import * as fs from 'fs';

@Injectable()
export class GoogleDriveService {
  private readonly logger = new Logger(GoogleDriveService.name);

  constructor(private prisma: PrismaService) { }

  private getOAuthClient() {
    return new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
  }

  // Auth Link Generate
  getAuthUrl(photographerId: string): string {
    const oauth2Client = this.getOAuthClient();
    return oauth2Client.generateAuthUrl({
      access_type: 'offline',
      prompt: 'consent',
      scope: [
        'https://www.googleapis.com/auth/drive',
      ],
      state: photographerId, // pass photographer ID to callback
    });
  }

  // Token callback handler
  async handleCallback(code: string, photographerId: string) {
    const oauth2Client = this.getOAuthClient();
    const { tokens } = await oauth2Client.getToken(code);

    await this.prisma.photographer.update({
      where: { id: photographerId },
      data: {
        googleDriveAccessToken: tokens.access_token,
        googleDriveRefreshToken: tokens.refresh_token || undefined, // refresh token is sent only first time
        googleDriveConnected: true,
      },
    });

    this.logger.log(`Google Drive successfully linked for photographer: ${photographerId}`);
  }

  // Disconnect Drive
  async disconnect(photographerId: string) {
    await this.prisma.photographer.update({
      where: { id: photographerId },
      data: {
        googleDriveAccessToken: null,
        googleDriveRefreshToken: null,
        googleDriveConnected: false,
      },
    });
  }

  // Delete a specific file or folder from Google Drive
  async deleteFileOrFolder(photographerId: string, fileId: string): Promise<boolean> {
    try {
      const auth = await this.getAuthenticatedClient(photographerId);
      const drive = google.drive({ version: 'v3', auth });
      await drive.files.delete({
        fileId: fileId,
        supportsAllDrives: true,
      });
      return true;
    } catch (err) {
      this.logger.error(`Failed to delete Google Drive item ${fileId}: ${err.message}`);
      return false;
    }
  }

  // Authenticate client using stored tokens
  private async getAuthenticatedClient(photographerId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
    });

    if (!photographer || !photographer.googleDriveAccessToken) {
      throw new Error('Google Drive is not connected');
    }

    const oauth2Client = this.getOAuthClient();
    oauth2Client.setCredentials({
      access_token: photographer.googleDriveAccessToken,
      refresh_token: photographer.googleDriveRefreshToken,
    });

    // Handle token expiry auto-refresh
    oauth2Client.on('tokens', async (tokens) => {
      if (tokens.access_token) {
        await this.prisma.photographer.update({
          where: { id: photographerId },
          data: {
            googleDriveAccessToken: tokens.access_token,
            googleDriveRefreshToken: tokens.refresh_token || photographer.googleDriveRefreshToken,
          },
        });
      }
    });

    return oauth2Client;
  }

  private pendingFolderPromises = new Map<string, Promise<string>>();

  // Get or Create Event Folder in Google Drive (thread-safe lock to prevent duplicates)
  async getOrCreateFolder(photographerId: string, folderName: string, parentFolderId?: string): Promise<string> {
    const effectiveParent = parentFolderId || 'root';
    const lockKey = `${photographerId}:${effectiveParent}:${folderName.toLowerCase()}`;

    // If an identical folder creation request is already in progress, wait for it!
    if (this.pendingFolderPromises.has(lockKey)) {
      return await this.pendingFolderPromises.get(lockKey)!;
    }

    const promise = (async () => {
      try {
        const auth = await this.getAuthenticatedClient(photographerId);
        const drive = google.drive({ version: 'v3', auth });

        // Always restrict by parent to prevent duplicates across Drive
        const query = `name = '${folderName.replace(/'/g, "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and '${effectiveParent}' in parents`;

        const res = await drive.files.list({
          q: query,
          spaces: 'drive',
          supportsAllDrives: true,
          includeItemsFromAllDrives: true,
          fields: 'files(id, name, createdTime)',
          orderBy: 'createdTime asc',
        });

        if (res.data.files && res.data.files.length > 0) {
          // Return earliest created folder
          return res.data.files[0].id!;
        }

        // Create new folder
        const fileMetadata: any = {
          name: folderName,
          mimeType: 'application/vnd.google-apps.folder',
          parents: [effectiveParent],
        };

        const folder = await drive.files.create({
          requestBody: fileMetadata,
          fields: 'id',
          supportsAllDrives: true,
        });

        return folder.data.id!;
      } finally {
        this.pendingFolderPromises.delete(lockKey);
      }
    })();

    this.pendingFolderPromises.set(lockKey, promise);
    return await promise;
  }


  // Upload Photo File to Google Drive (legacy method)
  async uploadFile(photographerId: string, stream: any, filename: string, eventName: string): Promise<string | null> {
    try {
      // 1. Root: FotosetGo
      const rootFolderId = await this.getOrCreateFolder(photographerId, 'FotosetGo');
      // 2. Unique per-photographer folder using photographerId (UUID, always unique)
      const photographerFolderId = await this.getOrCreateFolder(photographerId, photographerId, rootFolderId);
      // 3. Event subfolder
      const eventFolderId = await this.getOrCreateFolder(photographerId, eventName, photographerFolderId);

      // 4. Upload File
      const auth = await this.getAuthenticatedClient(photographerId);
      const drive = google.drive({ version: 'v3', auth });

      const fileMetadata = {
        name: filename,
        parents: [eventFolderId],
      };

      const media = {
        body: stream,
      };

      const file = await drive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id, webViewLink',
      });

      this.logger.log(`Photo ${filename} successfully synced to Google Drive folder: ${eventName}`);
      return file.data.id!;
    } catch (err) {
      this.logger.error(`Google Drive sync failed for ${filename}: ${err.message}`);
      return null;
    }
  }

  // List folders and files under a specific parent folder
  async listFoldersAndFiles(photographerId: string, parentFolderId?: string) {
    const auth = await this.getAuthenticatedClient(photographerId);
    const drive = google.drive({ version: 'v3', auth });

    let parentId = parentFolderId || 'root';

    const query = `'${parentId}' in parents and trashed = false`;
    const res = await drive.files.list({
      q: query,
      spaces: 'drive',
      supportsAllDrives: true,
      includeItemsFromAllDrives: true,
      fields: 'files(id, name, mimeType, thumbnailLink, webContentLink, webViewLink, size)',
      pageSize: 100,
    });

    const rawFiles = res.data.files || [];
    // Deduplicate items with identical names and mimeTypes (keeping the first one)
    const seen = new Set<string>();
    const uniqueFiles = rawFiles.filter(item => {
      const key = `${item.mimeType}:${item.name}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return uniqueFiles;
  }

  // Helper to recursively calculate all files size inside a folder in google drive
  async getFolderSize(drive: any, folderId: string): Promise<number> {
    let totalSize = 0;
    try {
      const res = await drive.files.list({
        q: `'${folderId}' in parents and trashed = false`,
        fields: 'files(id, size, mimeType)',
        pageSize: 1000,
      });

      const files = res.data.files || [];
      for (const file of files) {
        if (file.mimeType === 'application/vnd.google-apps.folder') {
          totalSize += await this.getFolderSize(drive, file.id);
        } else if (file.size) {
          totalSize += Number(file.size);
        }
      }
    } catch (err) {
      this.logger.error(`Failed to calculate size for folder ${folderId}: ${err.message}`);
    }
    return totalSize;
  }

  async getStorageQuota(photographerId: string) {
    try {
      const auth = await this.getAuthenticatedClient(photographerId);
      const drive = google.drive({ version: 'v3', auth });

      const res = await drive.about.get({
        fields: 'storageQuota',
      });

      // Try to find the 'FotosetGo' folder and calculate its total size
      let fotosetgoUsage = 0;
      try {
        const folderRes = await drive.files.list({
          q: "name = 'FotosetGo' and mimeType = 'application/vnd.google-apps.folder' and trashed = false",
          fields: 'files(id)',
        });
        if (folderRes.data.files && folderRes.data.files.length > 0) {
          const folderId = folderRes.data.files[0].id!;
          fotosetgoUsage = await this.getFolderSize(drive, folderId);
        }
      } catch (err) {
        this.logger.error(`Failed to get FotosetGo folder usage: ${err.message}`);
      }

      const quota = res.data.storageQuota || {};
      return {
        limit: Number(quota.limit || 0),
        usage: Number(quota.usage || 0),
        usageInDriveTrash: Number(quota.usageInDriveTrash || 0),
        fotosetgoUsage,
      };
    } catch (err) {
      this.logger.warn(`Google Drive authentication failed or expired: ${err.message}`);
      return {
        limit: 0,
        usage: 0,
        usageInDriveTrash: 0,
        fotosetgoUsage: 0,
        error: 'disconnected'
      };
    }
  }


  // Check if Google Drive has enough free space (min 50MB buffer)
  async checkDriveHasSpace(photographerId: string): Promise<{ hasSpace: boolean; freeBytes: number }> {
    try {
      const auth = await this.getAuthenticatedClient(photographerId);
      const drive = google.drive({ version: 'v3', auth });
      const res = await drive.about.get({ fields: 'storageQuota' });
      const quota = res.data.storageQuota || {};
      const limit = Number(quota.limit || 0);
      const usage = Number(quota.usage || 0);
      const freeBytes = limit > 0 ? limit - usage : Infinity;
      const MIN_BUFFER = 50 * 1024 * 1024; // 50 MB minimum free
      return { hasSpace: freeBytes > MIN_BUFFER, freeBytes };
    } catch (err) {
      this.logger.error(`Failed to check Drive quota: ${err.message}`);
      return { hasSpace: false, freeBytes: 0 };
    }
  }

  // Backup a single photo/video to Google Drive
  async backupSinglePhoto(
    photographerId: string,
    photo: { id: string; r2KeyOriginal: string; filenameOriginal: string; driveFileId?: string | null },
    eventName: string,
    s3Client: any,
    bucketName: string,
  ): Promise<string | null> {
    // Skip if already backed up
    if (photo.driveFileId) {
      return photo.driveFileId;
    }

    try {
      const { GetObjectCommand } = await import('@aws-sdk/client-s3');

      // Download from R2 as stream
      const getCommand = new GetObjectCommand({
        Bucket: bucketName,
        Key: photo.r2KeyOriginal,
      });
      const s3Res = await s3Client.send(getCommand);
      if (!s3Res.Body) {
        this.logger.error(`[AutoBackup] Empty body from R2 for photo ${photo.id}`);
        return null;
      }

      // Safety check — never upload thumbnails, only originals
      if (!photo.r2KeyOriginal) {
        this.logger.warn(`[AutoBackup] Skipping ${photo.filenameOriginal} — no r2KeyOriginal`);
        return null;
      }

      // Determine mimeType based on filename extension
      let mimeType = 'application/octet-stream';
      const ext = photo.filenameOriginal.split('.').pop()?.toLowerCase();
      if (ext === 'jpg' || ext === 'jpeg') mimeType = 'image/jpeg';
      else if (ext === 'png') mimeType = 'image/png';
      else if (ext === 'webp') mimeType = 'image/webp';
      else if (ext === 'gif') mimeType = 'image/gif';
      else if (ext === 'mp4') mimeType = 'video/mp4';
      else if (ext === 'mov') mimeType = 'video/quicktime';
      else if (ext === 'avi') mimeType = 'video/x-msvideo';
      else if (ext === 'webm') mimeType = 'video/webm';

      // Folder structure: FotosetGo → photographerId (UUID, always unique) → EventName
      // Using photographerId directly — no DB query needed, guaranteed unique
      const rootFolderId = await this.getOrCreateFolder(photographerId, 'FotosetGo');
      const photographerFolderId = await this.getOrCreateFolder(photographerId, photographerId, rootFolderId);
      const eventFolderId = await this.getOrCreateFolder(photographerId, eventName, photographerFolderId);

      // Upload to Drive
      const auth = await this.getAuthenticatedClient(photographerId);
      const drive = google.drive({ version: 'v3', auth });

      const file = await drive.files.create({
        requestBody: {
          name: photo.filenameOriginal,
          mimeType: mimeType,
          parents: [eventFolderId],
        },
        media: {
          mimeType: mimeType,
          body: s3Res.Body as any,
        },
        fields: 'id',
      });

      const driveFileId = file.data.id!;
      
      // Make the file publicly accessible by link so the frontend can preview/load it
      try {
        await drive.permissions.create({
          fileId: driveFileId,
          requestBody: {
            role: 'reader',
            type: 'anyone',
          },
        });
      } catch (permissionErr) {
        this.logger.warn(`Failed to set public reader permission for ${photo.filenameOriginal}: ${permissionErr.message}`);
      }

      this.logger.log(`[AutoBackup] ✅ ${photo.filenameOriginal} → Drive (${driveFileId})`);
      return driveFileId;
    } catch (err) {
      this.logger.error(`[AutoBackup] ❌ Failed for ${photo.filenameOriginal}: ${err.message}`);
      return null;
    }
  }

  // Backup all pending (not yet backed up) photos for a photographer
  async backupAllPendingPhotos(
    photographerId: string,
    s3Client: any,
    bucketName: string,
    prisma: any,
  ): Promise<{ backed: number; failed: number; skippedDriveFull: boolean }> {
    let backed = 0;
    let failed = 0;
    let skippedDriveFull = false;

    // Fetch pending photos with their event name
    const pendingPhotos = await prisma.photo.findMany({
      where: {
        photographerId,
        backedUpToDrive: false,
        status: 'READY',
        isDeleted: false,
        // Only backup original event media — not thumbnails or other types
        type: { in: ['IMAGE', 'VIDEO'] },
        r2KeyOriginal: { not: '' }, // must have original file key
      },
      include: { event: { select: { title: true } } },
      orderBy: { createdAt: 'asc' },
    });

    if (pendingPhotos.length === 0) return { backed, failed, skippedDriveFull };

    this.logger.log(`[AutoBackup] ${pendingPhotos.length} pending photos for photographer ${photographerId}`);

    for (const photo of pendingPhotos) {
      // Check Drive quota before each upload
      const { hasSpace } = await this.checkDriveHasSpace(photographerId);
      if (!hasSpace) {
        this.logger.warn(`[AutoBackup] Google Drive full for photographer ${photographerId}. Stopping.`);
        skippedDriveFull = true;
        // Auto-disable backup and mark notification flag
        await prisma.photographer.update({
          where: { id: photographerId },
          data: { autoBackupToDrive: false, driveBackupFullNotified: true },
        });
        break;
      }

      const eventName = photo.event?.title || 'Uncategorized';
      const driveFileId = await this.backupSinglePhoto(photographerId, photo, eventName, s3Client, bucketName);

      if (driveFileId) {
        await prisma.photo.update({
          where: { id: photo.id },
          data: { backedUpToDrive: true, driveFileId },
        });
        backed++;
      } else {
        failed++;
      }
    }

    this.logger.log(`[AutoBackup] Done. Backed: ${backed}, Failed: ${failed}, DriveFullStop: ${skippedDriveFull}`);
    return { backed, failed, skippedDriveFull };
  }
}

