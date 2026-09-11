import { Injectable, Logger } from '@nestjs/common';
import { google } from 'googleapis';
import { PrismaService } from 'src/prisma.service';

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


  // Backup all pending (not yet backed up) photos for a photographer via Cloudflare Worker (Zero VPS Bandwidth)
  async backupAllPendingPhotos(
    photographerId: string,
    s3Client: any,
    bucketName: string,
    prisma: any,
  ): Promise<{ backed: number; failed: number; skippedDriveFull: boolean }> {
    let backed = 0;
    let failed = 0;
    let skippedDriveFull = false;

    // 1. Fetch pending photos with their event details
    const pendingPhotos = await prisma.photo.findMany({
      where: {
        photographerId,
        backedUpToDrive: false,
        status: 'READY',
        isDeleted: false,
        type: { in: ['IMAGE', 'VIDEO'] },
        r2KeyOriginal: { not: '' },
      },
      include: { event: { select: { title: true } } },
      orderBy: { createdAt: 'asc' },
      take: 12, // Optimal batch size for Cloudflare 30s serverless stream
    });

    if (pendingPhotos.length === 0) return { backed: 0, failed: 0, skippedDriveFull: false };

    this.logger.log(`[AutoBackup] ${pendingPhotos.length} pending photos found for photographer ${photographerId}`);

    // 2. Check Drive quota before dispatching
    const { hasSpace } = await this.checkDriveHasSpace(photographerId);
    if (!hasSpace) {
      this.logger.warn(`[AutoBackup] Google Drive full for photographer ${photographerId}. Disabling auto-backup.`);
      await prisma.photographer.update({
        where: { id: photographerId },
        data: { autoBackupToDrive: false, driveBackupFullNotified: true },
      });
      return { backed: 0, failed: 0, skippedDriveFull: true };
    }

    const workerUrl = process.env.DRIVE_BACKUP_WORKER_URL;
    const workerSecret = process.env.DRIVE_WORKER_SECRET;
    const backendAppUrl = process.env.APP_URL;
    if (!workerUrl || !workerSecret || !backendAppUrl) {
      this.logger.error('CRITICAL: DRIVE_BACKUP_WORKER_URL, DRIVE_WORKER_SECRET or APP_URL is not defined in environment variables!');
      throw new Error('Drive backup worker configuration missing in environment variables');
    }
    const webhookUrl = `${backendAppUrl}/api/public/webhook/drive-backup-complete`;

    try {
      // 3. Get fresh OAuth Access Token for Google Drive
      const auth = await this.getAuthenticatedClient(photographerId);
      const tokenRes = await auth.getAccessToken();
      const accessToken = tokenRes.token;

      if (!accessToken) {
        throw new Error('Could not retrieve valid Google Drive access token');
      }

      // 4. Resolve folder structure: FotosetGo → photographerId → EventName
      const rootFolderId = await this.getOrCreateFolder(photographerId, 'FotosetGo');
      const photographerFolderId = await this.getOrCreateFolder(photographerId, photographerId, rootFolderId);

      const eventFolderCache = new Map<string, string>();
      const tasks: any[] = [];

      for (const photo of pendingPhotos) {
        const eventName = photo.event?.title || 'Uncategorized';
        let eventFolderId = eventFolderCache.get(eventName);
        if (!eventFolderId) {
          eventFolderId = await this.getOrCreateFolder(photographerId, eventName, photographerFolderId);
          eventFolderCache.set(eventName, eventFolderId);
        }

        tasks.push({
          photoId: photo.id,
          r2Key: photo.r2KeyOriginal,
          filename: photo.filenameOriginal,
          mimeType: photo.mimeType || 'image/jpeg',
          fileSize: photo.fileSizeBytes ? Number(photo.fileSizeBytes) : undefined,
          googleAccessToken: accessToken,
          eventFolderId,
          webhookUrl,
          secretKey: workerSecret,
        });
      }

      // 5. Dispatch batch directly to Cloudflare Edge Worker (0% VPS Bandwidth)
      this.logger.log(`[AutoBackup] 🚀 Dispatching ${tasks.length} tasks to Cloudflare Edge Worker (${workerUrl})...`);
      const workerRes = await fetch(`${workerUrl}/backup-batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-worker-secret': workerSecret,
        },
        body: JSON.stringify({ tasks, webhookUrl, secretKey: workerSecret }),
      });

      if (workerRes.ok) {
        this.logger.log(`[AutoBackup] ✅ ${tasks.length} backup tasks queued on Cloudflare Edge successfully!`);
        return { backed: tasks.length, failed: 0, skippedDriveFull: false };
      } else {
        const errText = await workerRes.text();
        this.logger.error(`[AutoBackup] Cloudflare Worker response not ok (${workerRes.status}): ${errText}`);
        return { backed: 0, failed: tasks.length, skippedDriveFull: false };
      }

    } catch (workerErr: any) {
      const isAuthError =
        workerErr.message?.includes('invalid_grant') ||
        workerErr.message?.includes('Google Drive is not connected') ||
        workerErr.message?.includes('invalid_token') ||
        workerErr.message?.includes('Could not retrieve valid Google Drive access token');

      if (isAuthError) {
        this.logger.warn(`[AutoBackup] Google Drive access token expired/revoked for photographer ${photographerId}. Disabling auto-backup.`);
        await prisma.photographer.update({
          where: { id: photographerId },
          data: {
            autoBackupToDrive: false,
            googleDriveConnected: false,
            googleDriveAccessToken: null,
          },
        }).catch(() => { });
      } else {
        this.logger.error(`[AutoBackup] Cloudflare Worker dispatch error for photographer ${photographerId}: ${workerErr.message}`);
      }
      return { backed: 0, failed: pendingPhotos.length, skippedDriveFull: false };
    }
  }
}

