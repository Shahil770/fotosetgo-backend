import { Injectable, NotFoundException, OnModuleInit, BadRequestException, UnauthorizedException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { Prisma } from '@prisma/client';
import { S3Client, PutObjectCommand, GetObjectCommand, PutBucketCorsCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import { GoogleDriveService } from './google-drive.service';
import { exec } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';

import { NodeHttpHandler } from '@smithy/node-http-handler';
import * as http from 'http';
import * as https from 'https';

import ffmpegPath from 'ffmpeg-static';
import * as ffprobe from 'ffprobe-static';

const execPromise = promisify(exec);
const ffprobePath = ffprobe.path;

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private s3Client: S3Client;
  private bucketName: string;
  private readonly urlCache = new Map<string, { url: string; expiresAt: number }>();
  private readonly activeEventScans = new Set<string>();
  private workerDispatchCounter = 0;

  constructor(
    private prisma: PrismaService,
    private googleDriveService: GoogleDriveService,
  ) {
    this.bucketName = process.env.R2_BUCKET_NAME || 'fotosetgo-photos';

    const httpAgent = new http.Agent({
      keepAlive: true,
      maxSockets: 500,
    });
    const httpsAgent = new https.Agent({
      keepAlive: true,
      maxSockets: 500,
    });

    const endpoint = process.env.R2_ENDPOINT_URL || '';
    if (!endpoint) {
      this.logger.error('CRITICAL: R2_ENDPOINT_URL is not defined in environment variables!');
    } else {
      this.logger.log(`Initializing R2 S3Client with endpoint: ${endpoint}`);
    }

    const faceEngine = process.env.FACE_ENGINE_URL || '';
    this.logger.log(`FACE_ENGINE_URL configured as: [${faceEngine}]`);

    this.s3Client = new S3Client({
      region: 'auto',
      endpoint: endpoint,
      credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
      },
      forcePathStyle: true,
      requestHandler: new NodeHttpHandler({
        httpAgent,
        httpsAgent,
        connectionTimeout: 15000,
        socketTimeout: 45000,
      }),
    });

    this.startWorkerKeepAlivePingLoop();
  }

  private startWorkerKeepAlivePingLoop(): void {
    // Every 10 minutes, ping all configured Go Workers so they stay 100% awake 24/7 on Render
    setInterval(() => {
      const rawUrls = process.env.THUMBNAIL_WORKER_URLS || process.env.THUMBNAIL_WORKER_URL || '';
      if (!rawUrls) return;
      const workerUrls = rawUrls.split(',').map(u => u.trim()).filter(Boolean);
      for (const url of workerUrls) {
        fetch(`${url.replace(/\/$/, '')}/health`).catch(() => { });
      }
    }, 10 * 60 * 1000);
  }


  async onModuleInit() {
    try {
      // Configure CORS rule on the R2 bucket programmatically to allow uploads from browser
      const corsCommand = new PutBucketCorsCommand({
        Bucket: this.bucketName,
        CORSConfiguration: {
          CORSRules: [
            {
              AllowedHeaders: ['*'],
              AllowedMethods: ['GET', 'PUT', 'POST', 'DELETE', 'HEAD'],
              AllowedOrigins: ['*'], // Allow all origins for dev/prod flexibility
              ExposeHeaders: [],
              MaxAgeSeconds: 3000,
            },
          ],
        },
      });
      await this.s3Client.send(corsCommand);
      console.log(`[StorageService] Successfully applied CORS rules to R2 bucket: ${this.bucketName}`);
    } catch (err) {
      console.error(`[StorageService] Failed to apply CORS rules to R2 bucket:`, err.message);
    }
    await this.seedPortfolioThemes();
  }

  async seedPortfolioThemes() {
    try {
      const defaultThemes = [
        {
          key: 'ELEGANT',
          name: 'Elegant Serif',
          description: 'Warm cream, serif typography, luxury editorial feel',
          previewBg: 'bg-[#faf8f5]',
          componentName: 'ElegantTheme',
          isDefault: true,
          sortOrder: 1,
          isActive: true
        },
        {
          key: 'MODERN_DARK',
          name: 'Sleek Dark',
          description: 'Deep navy-black, neon gold highlights, glassmorphic cards',
          previewBg: 'bg-[#060813]',
          componentName: 'ModernDarkTheme',
          isDefault: false,
          sortOrder: 2,
          isActive: true
        },
        {
          key: 'BOLD_MINIMAL',
          name: 'Brutalist Minimal',
          description: 'Stark white, 4px solid black borders, raw bold aesthetic',
          previewBg: 'bg-white',
          componentName: 'BoldMinimalTheme',
          isDefault: false,
          sortOrder: 3,
          isActive: true
        },
        {
          key: 'CINEMATIC',
          name: 'Cinematic Polaroid',
          description: 'Split screen layout, handwriting typography & polaroid showcase cards',
          previewBg: 'bg-[#0d0d12]',
          componentName: 'CinematicTheme',
          isDefault: false,
          sortOrder: 4,
          isActive: true
        },
        {
          key: 'VINTAGE_LUXURY',
          name: 'Vintage Luxury',
          description: 'Deep emerald backdrop, elegant gold text, vintage luxury serif typography',
          previewBg: 'bg-[#03150e]',
          componentName: 'VintageLuxuryTheme',
          isDefault: false,
          sortOrder: 5,
          isActive: true
        }
      ];

      for (const theme of defaultThemes) {
        await this.prisma.portfolioTheme.upsert({
          where: { key: theme.key },
          update: {
            name: theme.name,
            description: theme.description,
            previewBg: theme.previewBg,
            componentName: theme.componentName
          },
          create: {
            ...theme
          }
        });
      }
      console.log('[StorageService] Portfolio themes layout metadata synced in database.');
    } catch (err) {
      console.error('[StorageService] Failed to seed portfolio themes:', err);
    }
  }

  async startUploadBatch(photographerId: string, eventId: string, totalFiles: number) {
    return this.prisma.uploadBatch.create({
      data: {
        eventId,
        photographerId,
        totalFiles,
        status: 'PROCESSING',
      },
    });
  }

  async getUploadPresignedUrl(photographerId: string, eventId: string, data: { filename: string; mimeType: string; fileSize: number; uploadBatchId?: string }) {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, photographerId },
    });

    if (!event) {
      throw new NotFoundException('Event not found or ownership mismatch');
    }

    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
      include: {
        subscriptions: {
          where: { status: 'ACTIVE' },
          orderBy: { startsAt: 'desc' },
          take: 1,
          include: { package: true }
        }
      }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer not found');
    }

    const activeSubscription = photographer.subscriptions[0];
    if (!activeSubscription) {
      throw new BadRequestException('No active subscription found. Please subscribe to a plan to start uploading.');
    }

    // Dynamic dual limit resolution: take the maximum of package limit vs subscription stored limit
    const pkgMb = activeSubscription.package?.maxEventsStorageMb ?? 5000;
    const pkgLimitBytes = BigInt(pkgMb) * BigInt(1024 * 1024);
    const subLimitBytes = activeSubscription.limitEventsBytes ?? activeSubscription.limitBytes ?? BigInt(0);
    const limitBytes = pkgLimitBytes > subLimitBytes ? pkgLimitBytes : subLimitBytes;

    // Calculate events-only used bytes (exclude portfolio/branding files)
    const eventsUsedAgg = await this.prisma.photo.aggregate({
      where: { photographerId, deletedAt: null, status: 'READY' },
      _sum: { fileSize: true },
    });
    const eventsUsedBytes = eventsUsedAgg._sum.fileSize
      ? BigInt(eventsUsedAgg._sum.fileSize.toString())
      : BigInt(0);

    if (eventsUsedBytes + BigInt(data.fileSize) > limitBytes) {
      throw new BadRequestException('Events storage limit exceeded. Please upgrade your plan.');
    }

    const isVideo = data.mimeType.startsWith('video/') || data.filename.match(/\.(mp4|mkv|mov|webm)$/i);
    const fileUuid = uuidv4();
    const cleanFilename = data.filename.replace(/[^a-zA-Z0-9.-]/g, '_');

    // Set dynamic R2 Path under unified photographer folder
    const objectKey = isVideo
      ? `${photographerId}/events/${eventId}/videos/${fileUuid}_${cleanFilename}`
      : `${photographerId}/events/${eventId}/photos/${fileUuid}_${cleanFilename}`;


    // Create a mock photo entry in database
    const photo = await this.prisma.photo.create({
      data: {
        eventId,
        photographerId,
        filenameOriginal: data.filename,
        filenameStored: `${fileUuid}_${cleanFilename}`,
        r2KeyOriginal: objectKey,
        mimeType: data.mimeType,
        fileSize: BigInt(data.fileSize),
        status: 'UPLOADING',
        type: isVideo ? 'VIDEO' : 'IMAGE',
        uploadBatchId: data.uploadBatchId || undefined,
      },
    });

    // Generate signed upload URL from Cloudflare R2
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ContentType: data.mimeType,
    });

    // Expires in 5 minutes (300 seconds)
    const uploadUrl = await getSignedUrl(this.s3Client, command, { expiresIn: 300 });

    return {
      photoId: photo.id,
      objectKey,
      uploadUrl,
    };
  }

  async completeGuestUpload(photoId: string) {
    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      include: { event: true }
    });

    if (!photo) {
      throw new NotFoundException('Photo not found');
    }

    // Verify photographer storage usage increment
    await this.prisma.photographer.update({
      where: { id: photo.photographerId },
      data: {
        totalStorageUsedBytes: {
          increment: photo.fileSize
        }
      }
    });

    const activeSub = await this.prisma.subscription.findFirst({
      where: { photographerId: photo.photographerId, status: 'ACTIVE' },
      orderBy: { startsAt: 'desc' }
    });

    if (activeSub) {
      await this.prisma.subscription.update({
        where: { id: activeSub.id },
        data: {
          usedBytes: {
            increment: photo.fileSize
          }
        }
      });
    }

    // Maintain PENDING_APPROVAL status until photographer approves
    const updatedPhoto = await this.prisma.photo.update({
      where: { id: photoId },
      data: { status: 'PENDING_APPROVAL' }
    });

    return updatedPhoto;
  }

  async getEventPendingPhotos(photographerId: string, eventId: string) {
    return this.prisma.photo.findMany({
      where: { eventId, photographerId, status: 'PENDING_APPROVAL' },
      orderBy: { createdAt: 'desc' }
    });
  }

  async approveGuestPhoto(photographerId: string, photoId: string) {
    const photo = await this.prisma.photo.findFirst({
      where: { id: photoId, photographerId, status: 'PENDING_APPROVAL' }
    });

    if (!photo) {
      throw new NotFoundException('Pending guest photo not found');
    }

    // Transition status to PROCESSING to kickstart thumbnail and face analysis
    const updatedPhoto = await this.prisma.photo.update({
      where: { id: photoId },
      data: { status: 'PROCESSING', thumbnailStatus: 'PENDING' }
    });

    if (photo.type === 'VIDEO') {
      this.runBackgroundVideoProcessing(photographerId, photoId, photo.eventId, photo.r2KeyOriginal, photo.uploadBatchId).catch(err => {
        console.error('[StorageService] Background video processing failed:', err);
      });
    } else {
      // Cloudflare Worker se thumbnail generate karwao (await HTTP dispatch)
      await this.triggerCloudflareWorker(photoId, photo.r2KeyOriginal).catch(err => {
        this.logger.error(`[approveGuestPhoto] Worker trigger error for ${photoId}: ${err.message}`);
      });
    }

    return updatedPhoto;
  }

  async rejectGuestPhoto(photographerId: string, photoId: string) {
    const photo = await this.prisma.photo.findFirst({
      where: { id: photoId, photographerId, status: 'PENDING_APPROVAL' }
    });

    if (!photo) {
      throw new NotFoundException('Pending guest photo not found');
    }

    // 1. Revert photographer storage usage footprint
    await this.prisma.photographer.update({
      where: { id: photographerId },
      data: {
        totalStorageUsedBytes: {
          decrement: photo.fileSize
        }
      }
    });

    const activeSub = await this.prisma.subscription.findFirst({
      where: { photographerId, status: 'ACTIVE' },
      orderBy: { startsAt: 'desc' }
    });

    if (activeSub) {
      await this.prisma.subscription.update({
        where: { id: activeSub.id },
        data: {
          usedBytes: {
            decrement: photo.fileSize
          }
        }
      });
    }

    // 2. Delete from R2 bucket
    if (photo.r2KeyOriginal) {
      try {
        await this.s3Client.send(new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: photo.r2KeyOriginal,
        }));
      } catch (err: any) {
        this.logger.error(`[rejectGuestPhoto] Failed to delete R2 file: ${err.message}`);
      }
    }

    // 3. Delete DB record
    await this.prisma.photo.delete({ where: { id: photoId } });

    return { success: true };
  }

  async getGuestUploadPresignedUrl(slug: string, data: { filename: string; mimeType: string; fileSize: number }) {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      include: {
        photographer: {
          include: {
            subscriptions: {
              where: { status: 'ACTIVE' },
              orderBy: { startsAt: 'desc' },
              take: 1
            }
          }
        }
      }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (!event.allowGuestUploads) {
      throw new BadRequestException('Guest uploads are not enabled for this event');
    }

    // 1. Verify Photographer level storage limit
    const photographer = event.photographer;
    const activeSubscription = photographer.subscriptions[0];
    const limitBytes = activeSubscription?.limitEventsBytes ?? activeSubscription?.limitBytes ?? BigInt(5000 * 1024 * 1024);
    const totalStorageUsedBytes = photographer.totalStorageUsedBytes || BigInt(0);

    if (totalStorageUsedBytes + BigInt(data.fileSize) > limitBytes) {
      throw new BadRequestException('Photographer storage space is full. Cannot accept guest uploads.');
    }

    // 2. Verify Event Guest Upload Limits
    // Calculate current guest uploads count and total size
    const guestPhotosStats = await this.prisma.photo.aggregate({
      where: { eventId: event.id, isGuestUpload: true },
      _count: { id: true },
      _sum: { fileSize: true }
    });

    const currentGuestCount = guestPhotosStats._count.id || 0;
    const currentGuestSize = guestPhotosStats._sum.fileSize ? BigInt(guestPhotosStats._sum.fileSize.toString()) : BigInt(0);

    // Limit check: File count limit
    if (currentGuestCount >= event.maxGuestUploadFiles) {
      throw new BadRequestException(`Guest upload file limit reached (${event.maxGuestUploadFiles} files max).`);
    }

    // Limit check: Storage size limit
    if (currentGuestSize + BigInt(data.fileSize) > event.maxGuestUploadStorage) {
      const maxMB = Math.round(Number(event.maxGuestUploadStorage) / 1024 / 1024);
      throw new BadRequestException(`Guest upload storage size limit reached (${maxMB} MB max).`);
    }

    const isVideo = data.mimeType.startsWith('video/') || data.filename.match(/\.(mp4|mkv|mov|webm)$/i);
    const fileUuid = uuidv4();
    const cleanFilename = data.filename.replace(/[^a-zA-Z0-9.-]/g, '_');

    // Set R2 Path
    const objectKey = isVideo
      ? `${photographer.id}/events/${event.id}/videos/${fileUuid}_${cleanFilename}`
      : `${photographer.id}/events/${event.id}/photos/${fileUuid}_${cleanFilename}`;

    // Create Photo entry with PENDING_APPROVAL status
    const photo = await this.prisma.photo.create({
      data: {
        eventId: event.id,
        photographerId: photographer.id,
        filenameOriginal: data.filename,
        filenameStored: `${fileUuid}_${cleanFilename}`,
        r2KeyOriginal: objectKey,
        mimeType: data.mimeType,
        fileSize: BigInt(data.fileSize),
        status: 'PENDING_APPROVAL',
        type: isVideo ? 'VIDEO' : 'IMAGE',
        isGuestUpload: true
      },
    });

    // Generate signed upload URL from Cloudflare R2
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ContentType: data.mimeType,
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, { expiresIn: 300 });

    return {
      photoId: photo.id,
      uploadUrl,
    };
  }

  async completeUpload(photographerId: string, photoId: string) {
    this.logger.log(`[completeUpload] Browser upload complete signal received for photoId: ${photoId}`);
    const photo = await this.prisma.photo.findFirst({
      where: { id: photoId, photographerId },
    });

    if (!photo) {
      throw new NotFoundException('Photo not found');
    }

    await this.prisma.photographer.update({
      where: { id: photographerId },
      data: {
        totalStorageUsedBytes: {
          increment: photo.fileSize
        }
      }
    });

    const activeSub = await this.prisma.subscription.findFirst({
      where: { photographerId, status: 'ACTIVE' },
      orderBy: { startsAt: 'desc' }
    });

    if (activeSub) {
      await this.prisma.subscription.update({
        where: { id: activeSub.id },
        data: {
          usedBytes: {
            increment: photo.fileSize
          }
        }
      });
    }

    // Increment uploadedFiles in the active UploadBatch if exists
    if (photo.uploadBatchId) {
      await this.prisma.uploadBatch.update({
        where: { id: photo.uploadBatchId },
        data: {
          uploadedFiles: { increment: 1 }
        }
      }).catch(err => console.error('[StorageService] Failed to update batch upload counter:', err));
    }

    const updatedPhoto = await this.prisma.photo.update({
      where: { id: photoId },
      data: { status: 'PROCESSING', thumbnailStatus: 'PENDING' }
    });

    // Modal Cloud Engine handles thumbnails for both Photos and Videos seamlessly
    await this.triggerCloudflareWorker(photoId, photo.r2KeyOriginal).catch(err => {
      this.logger.error(`[completeUpload] Thumbnail engine trigger error for ${photoId}: ${err.message}`);
    });

    if (photo.type === 'VIDEO') {
      this.runBackgroundVideoProcessing(photographerId, photoId, photo.eventId, photo.r2KeyOriginal, photo.uploadBatchId).catch(err => {
        console.error('[StorageService] Background video duration extraction failed:', err);
      });
    }

    this.syncToGoogleDriveInBackground(photographerId, photo).catch(err => {
      console.error('[StorageService] Background Google Drive sync trigger failed:', err);
    });

    return updatedPhoto;
  }

  async cancelUpload(photographerId: string, photoId: string) {
    // Called when browser-side R2 upload failed or was cancelled
    const photo = await this.prisma.photo.findFirst({
      where: { id: photoId, photographerId, status: 'UPLOADING' },
    });

    if (!photo) {
      // Already processed or doesn't belong to this user — ignore silently
      return { cancelled: false };
    }

    // Delete the file from Cloudflare R2 if it was partially or fully uploaded
    if (photo.r2KeyOriginal) {
      try {
        const deleteCmd = new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: photo.r2KeyOriginal,
        });
        await this.s3Client.send(deleteCmd);
        this.logger.log(`[cancelUpload] Deleted orphaned R2 object: ${photo.r2KeyOriginal}`);
      } catch (r2Err: any) {
        this.logger.error(`[cancelUpload] Failed to delete R2 object ${photo.r2KeyOriginal}: ${r2Err.message}`);
      }
    }

    await this.prisma.photo.delete({ where: { id: photoId } });
    this.logger.log(`[cancelUpload] Removed orphaned UPLOADING entry for photo ${photoId}`);
    return { cancelled: true };
  }

  private async syncToGoogleDriveInBackground(photographerId: string, photo: any) {
    try {
      const photographer = await this.prisma.photographer.findUnique({
        where: { id: photographerId },
      });

      if (!photographer || !photographer.googleDriveConnected) {
        return;
      }

      const event = await this.prisma.event.findUnique({
        where: { id: photo.eventId },
      });

      if (!event) return;

      const command = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: photo.r2KeyOriginal,
      });
      const response = await this.s3Client.send(command);

      if (!response.Body) {
        throw new Error('R2 response body is empty');
      }

      await this.googleDriveService.uploadFile(
        photographerId,
        response.Body,
        photo.filenameOriginal || `photo_${photo.id}.jpg`,
        event.title || 'Event Gallery'
      );
    } catch (err) {
      console.error(`[StorageService] Google Drive background sync failed for photo ${photo.id}:`, err.message);
    }
  }

  private async updateBatchProgress(uploadBatchId: string | null | undefined, isSuccess: boolean) {
    if (!uploadBatchId) return;
    try {
      const batch = await this.prisma.uploadBatch.update({
        where: { id: uploadBatchId },
        data: {
          processedFiles: isSuccess ? { increment: 1 } : undefined,
          failedFiles: !isSuccess ? { increment: 1 } : undefined,
        },
        include: {
          photos: true
        }
      });

      // If all files processed, mark batch as COMPLETED
      if (batch.processedFiles + batch.failedFiles >= batch.totalFiles) {
        await this.prisma.uploadBatch.update({
          where: { id: uploadBatchId },
          data: { status: 'COMPLETED' }
        });
      }
    } catch (err) {
      console.error('[StorageService] Failed to update batch progress:', err);
    }
  }

  private async runBackgroundVideoProcessing(
    photographerId: string,
    photoId: string,
    eventId: string,
    r2KeyOriginal: string,
    uploadBatchId?: string | null
  ) {
    // Check if video photo has been trashed/deleted in the meantime
    const currentVideo = await this.prisma.photo.findUnique({
      where: { id: photoId }
    });
    if (!currentVideo || currentVideo.isDeleted) {
      console.log(`[StorageService] Video ${photoId} is deleted/trashed. Skipping video processing.`);
      await this.updateBatchProgress(uploadBatchId, true);
      return;
    }

    // Defer processing for pending guest uploads
    if (currentVideo.status === 'PENDING_APPROVAL') {
      console.log(`[StorageService] Video ${photoId} is pending approval. Deferring processing until approved.`);
      await this.updateBatchProgress(uploadBatchId, true);
      return;
    }
    let duration = 0;
    const computedThumbKey = r2KeyOriginal.includes('/videos/') 
      ? r2KeyOriginal.replace('/videos/', '/thumbs/').replace(/\.[^/.]+$/, '.jpg')
      : r2KeyOriginal.replace('/photos/', '/thumbs/').replace(/\.[^/.]+$/, '.jpg');

    try {
      // 1. Get Signed URL for 0-RAM Metadata extraction
      const getCmd = new GetObjectCommand({ Bucket: this.bucketName, Key: r2KeyOriginal });
      const videoSignedUrl = await getSignedUrl(this.s3Client, getCmd, { expiresIn: 3600 });

      // 2. Safe Duration Extraction (ffprobe-static removed to prevent Linux Segfaults on HTTPS URLs)
      duration = 0;

      // 3. Video Face Scanning (Check Global & Event Toggles)
      const photographer = await this.prisma.photographer.findUnique({
        where: { id: photographerId },
      });
      const event = await this.prisma.event.findUnique({
        where: { id: eventId },
      });

      let faceCount = 0;
      let hasFaces = false;

      if (photographer?.videoFaceScanningEnabled && event?.videoScanningEnabled) {
        const faceEngineUrl = process.env.FACE_ENGINE_URL || 'https://sahilshah778800--face-engine-fastapi-app.modal.run';

        try {
          // Call Modal GPU Video Indexing Endpoint (/faces/index-video)
          const response = await fetch(`${faceEngineUrl}/faces/index-video`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'x-api-key': process.env.MODAL_API_KEY || 'default-secret-key-123'
            },
            body: JSON.stringify({ videoUrl: videoSignedUrl }),
          });

          if (response.ok) {
            const result = await response.json();
            if (result.faces && result.faces.length > 0) {
              hasFaces = true;
              faceCount = result.faces.length;

              const faceData = result.faces.map((f: any) => ({
                photoId,
                eventId,
                photographerId,
                faceIndex: f.faceIndex,
                bboxX: f.bbox.x,
                bboxY: f.bbox.y,
                bboxW: f.bbox.w,
                bboxH: f.bbox.h,
                confidence: f.confidence,
                embedding: f.embedding,
                timestamp: f.timestamp || 0,
              }));

              const values = faceData.map((f: any) => {
                const vectorStr = `[${f.embedding.join(',')}]`;
                return `('${uuidv4()}', '${f.photoId}', '${f.eventId}', '${f.photographerId}', ${f.faceIndex}, ${f.bboxX}, ${f.bboxY}, ${f.bboxW}, ${f.bboxH}, ${f.confidence}, '${vectorStr}'::vector, NULL, ${f.timestamp})`;
              }).join(',');

              await this.prisma.$executeRawUnsafe(`
                INSERT INTO face_embeddings ("id", "photoId", "eventId", "photographerId", "faceIndex", "bboxX", "bboxY", "bboxW", "bboxH", "confidence", "embedding", "clusterId", "timestamp")
                VALUES ${values}
              `);
            }
          }
        } catch (videoScanErr) {
          this.logger.error(`[StorageService] Modal video face scan failed for video ${photoId}:`, videoScanErr);
        }
      }

      // Update database record with Modal generated thumbnail key & duration
      await this.prisma.photo.update({
        where: { id: photoId },
        data: {
          status: 'READY',
          thumbnailStatus: 'READY',
          faceScanStatus: 'READY',
          hasFaces,
          faceCount,
          r2KeyThumb: computedThumbKey,
          thumbnailUrl: `https://pub-d4d6b7ea94e00e300402.r2.dev/${computedThumbKey}`,
          duration,
        },
      });

      // Auto-backup to Google Drive if enabled (non-blocking)
      this.triggerAutoBackupIfEnabled(photographerId, photoId).catch(err =>
        console.error('[AutoBackup] Video trigger failed:', err)
      );

      await this.updateBatchProgress(uploadBatchId, true);
    } catch (err) {
      console.error(`[StorageService] Video background processing failed for ${photoId}:`, err);
      await this.prisma.photo.update({
        where: { id: photoId },
        data: { status: 'FAILED' },
      }).catch(() => { });

      await this.updateBatchProgress(uploadBatchId, false);
    }
  }

  private async runBackgroundFaceIndexing(
    photographerId: string,
    photoId: string,
    eventId: string,
    r2KeyOriginal: string,
    uploadBatchId?: string | null
  ) {
    // Check if photo has been trashed/deleted in the meantime
    const currentPhoto = await this.prisma.photo.findUnique({
      where: { id: photoId }
    });
    if (!currentPhoto || currentPhoto.isDeleted) {
      console.log(`[StorageService] Photo ${photoId} is deleted/trashed. Skipping face indexing.`);
      await this.updateBatchProgress(uploadBatchId, true);
      return;
    }

    // Defer indexing for pending guest uploads
    if (currentPhoto.status === 'PENDING_APPROVAL') {
      console.log(`[StorageService] Photo ${photoId} is pending approval. Deferring face indexing.`);
      await this.updateBatchProgress(uploadBatchId, true);
      return;
    }

    let faceCount = 0;
    let hasFaces = false;
    let thumbKey: string | null = currentPhoto.r2KeyThumb || null;

    try {
      const event = await this.prisma.event.findUnique({ where: { id: eventId } });
      let imageBuffer: Buffer | null = null;

      try {
        // If thumbnail is missing, generate it from original
        if (!thumbKey) {
          const getCommand = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: r2KeyOriginal,
          });
          const s3Response = await this.s3Client.send(getCommand);
          if (!s3Response.Body) {
            throw new Error('S3 response body is empty');
          }
          imageBuffer = Buffer.from(await s3Response.Body.transformToByteArray());

          // Generate 300px display thumbnail
          const thumbBuffer = await sharp(imageBuffer)
            .resize(300)
            .jpeg({ quality: 80 })
            .toBuffer();

          thumbKey = `${photographerId}/events/${eventId}/thumbs/${photoId}.jpg`;
          await this.s3Client.send(new PutObjectCommand({
            Bucket: this.bucketName,
            Key: thumbKey,
            Body: thumbBuffer,
            ContentType: 'image/jpeg',
          }));
        }
      } catch (thumbErr) {
        console.error(`[StorageService] Post-upload thumbnail generation failed for photo ${photoId}:`, thumbErr);
      }

      if (!event?.faceScanningEnabled) {
        await this.prisma.photo.update({
          where: { id: photoId },
          data: {
            status: 'READY',
            hasFaces: false,
            faceCount: 0,
            r2KeyThumb: thumbKey,
          },
        });

        // Auto-backup to Google Drive if enabled (non-blocking)
        this.triggerAutoBackupIfEnabled(photographerId, photoId).catch(err =>
          console.error('[AutoBackup] Photo trigger failed:', err)
        );

        await this.updateBatchProgress(uploadBatchId, true);
        return;
      }

      // Use the Original photo URL for maximum clarity AI Face Indexing
      const origCommand = new GetObjectCommand({ Bucket: this.bucketName, Key: r2KeyOriginal });
      const faceIndexUrl = await getSignedUrl(this.s3Client, origCommand, { expiresIn: 600 });

      // Call FastAPI Face Engine with thumbnail URL
      const faceEngineUrl = process.env.FACE_ENGINE_URL || 'http://127.0.0.1:8000';
      const response = await fetch(`${faceEngineUrl}/faces/index-photo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.MODAL_API_KEY || 'default-secret-key-123'
        },
        body: JSON.stringify({ imageUrl: faceIndexUrl }),
      });

      if (response.ok) {
        const result = await response.json();
        faceCount = result.faceCount || 0;
        hasFaces = faceCount > 0;

        // Delete any existing face embeddings for this photo first to prevent duplicates
        await this.prisma.faceEmbedding.deleteMany({
          where: { photoId }
        });

        if (result.faces && result.faces.length > 0) {
          // Fetch existing face embeddings with assigned clusterIds to implement auto-learning feedback
          interface RawExistingFace {
            clusterId: string;
            embeddingStr: string;
          }
          const existingFaces = await this.prisma.$queryRaw<RawExistingFace[]>`
            SELECT "clusterId", "embedding"::text as "embeddingStr"
            FROM face_embeddings
            WHERE "eventId" = ${eventId} AND "clusterId" IS NOT NULL
          `;

          const faceData = result.faces.map((f: any) => {
            const newEmb = f.embedding;
            let assignedClusterId: string | null = null;

            if (Array.isArray(newEmb) && existingFaces.length > 0) {
              let maxSimilarity = -1;
              let bestClusterId: string | null = null;

              for (const ext of existingFaces) {
                let extEmb: any = ext.embeddingStr;
                if (typeof extEmb === 'string') {
                  try { extEmb = JSON.parse(extEmb); } catch { continue; }
                }
                const extEmbArray = extEmb as number[];
                const newEmbArray = newEmb as number[];
                if (!Array.isArray(extEmbArray) || extEmbArray.length !== newEmbArray.length) continue;

                // Compute Dot Product (Cosine Similarity since vectors are normalized)
                let dotProduct = 0;
                for (let i = 0; i < newEmbArray.length; i++) {
                  dotProduct += newEmbArray[i] * extEmbArray[i];
                }

                // Threshold 0.45 (Strict match for auto-inheritance of clusterId)
                if (dotProduct > 0.45 && dotProduct > maxSimilarity) {
                  maxSimilarity = dotProduct;
                  bestClusterId = ext.clusterId;
                }
              }

              if (bestClusterId) {
                assignedClusterId = bestClusterId;
              }
            }

            return {
              photoId,
              eventId,
              photographerId,
              faceIndex: f.faceIndex,
              bboxX: f.bbox.x,
              bboxY: f.bbox.y,
              bboxW: f.bbox.w,
              bboxH: f.bbox.h,
              confidence: f.confidence,
              embedding: f.embedding,
              clusterId: assignedClusterId,
            };
          });

          // Generate raw insert SQL for face embeddings to support Unsupported vector(512) type
          const values = faceData.map(f => {
            const vectorStr = `[${f.embedding.join(',')}]`;
            const clusterIdVal = f.clusterId ? `'${f.clusterId}'` : 'NULL';
            return `('${uuidv4()}', '${f.photoId}', '${f.eventId}', '${f.photographerId}', ${f.faceIndex}, ${f.bboxX}, ${f.bboxY}, ${f.bboxW}, ${f.bboxH}, ${f.confidence}, '${vectorStr}'::vector, ${clusterIdVal})`;
          }).join(',');

          await this.prisma.$executeRawUnsafe(`
            INSERT INTO face_embeddings ("id", "photoId", "eventId", "photographerId", "faceIndex", "bboxX", "bboxY", "bboxW", "bboxH", "confidence", "embedding", "clusterId")
            VALUES ${values}
          `);
        }

        await this.prisma.photo.update({
          where: { id: photoId },
          data: {
            status: 'READY',
            faceScanStatus: 'READY',
            hasFaces,
            faceCount,
            r2KeyThumb: thumbKey,
          },
        });

        // Auto-backup to Google Drive if enabled (non-blocking)
        this.triggerAutoBackupIfEnabled(photographerId, photoId).catch(err =>
          console.error('[AutoBackup] Photo trigger failed:', err)
        );

        await this.updateBatchProgress(uploadBatchId, true);
      } else {
        const errText = await response.text();
        console.error(`FastAPI returned non-200 status for photo ${photoId}: ${response.status} - ${errText}`);
        await this.prisma.photo.update({
          where: { id: photoId },
          data: {
            status: 'FAILED',
            r2KeyThumb: thumbKey,
          }
        });

        await this.updateBatchProgress(uploadBatchId, false);
      }
    } catch (err) {
      console.error('[StorageService] FastAPI background face recognition failed:', err);
      await this.prisma.photo.update({
        where: { id: photoId },
        data: {
          status: 'FAILED',
          r2KeyThumb: thumbKey,
        }
      }).catch(e => console.error('Failed to set FAILED status:', e));

      await this.updateBatchProgress(uploadBatchId, false);
    } finally {
      // Previews are no longer created, so no deletion is necessary
    }
  }

  async getReadUrl(key: string): Promise<string> {
    const cached = this.urlCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now + 300000) { // 5 minutes buffer
      return cached.url;
    }
    const getCommand = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });
    const url = await getSignedUrl(this.s3Client, getCommand, { expiresIn: 3600 }); // 1 hour expiration
    this.urlCache.set(key, { url, expiresAt: now + 3600000 });
    return url;
  }

  private async extractEmbedding(selfieFile: any): Promise<number[] | null> {
    const faceEngineUrl = process.env.FACE_ENGINE_URL || 'http://localhost:8000';
    let resizedSelfieBuffer = selfieFile.buffer;
    try {
      resizedSelfieBuffer = await sharp(selfieFile.buffer)
        .resize(600)
        .jpeg({ quality: 85 })
        .toBuffer();
    } catch (resizeErr) {
      console.error('Failed to resize selfie image before face extraction:', resizeErr);
    }

    const formData = new FormData();
    const blob = new Blob([resizedSelfieBuffer], { type: selfieFile.mimetype || 'image/jpeg' });
    formData.append('selfie', blob, selfieFile.originalname || 'selfie.jpg');

    try {
      const response = await fetch(`${faceEngineUrl}/faces/extract`, {
        method: 'POST',
        headers: {
          'x-api-key': process.env.MODAL_API_KEY || 'default-secret-key-123'
        },
        body: formData,
      });

      if (!response.ok) {
        const errBody = await response.text();
        console.error(`[StorageService] FastAPI extract failed: status=${response.status}, body=${errBody}`);
        return null;
      }

      const result = await response.json();
      if (result.faceCount > 0 && result.embedding) {
        return result.embedding;
      }
      return null;
    } catch (err) {
      console.error('[StorageService] FastAPI background face extraction failed:', err);
      return null;
    }
  }

  async searchFace(photographerId: string, selfieFile: any, eventId?: string) {
    if (!selfieFile) return [];

    const queryEmbedding = await this.extractEmbedding(selfieFile);
    if (!queryEmbedding || queryEmbedding.length === 0) {
      return [];
    }

    const vectorStr = `[${queryEmbedding.join(',')}]`;
    const threshold = 0.40;

    let results: any[] = [];
    try {
      if (eventId) {
        results = await this.prisma.$queryRaw<any[]>`
          SELECT DISTINCT "photoId", 1 - (embedding <=> ${vectorStr}::vector) as similarity
          FROM face_embeddings
          WHERE "photographerId" = ${photographerId}
            AND "eventId" = ${eventId}
            AND 1 - (embedding <=> ${vectorStr}::vector) >= ${threshold}
          ORDER BY similarity DESC
          LIMIT 100
        `;
      } else {
        results = await this.prisma.$queryRaw<any[]>`
          SELECT DISTINCT "photoId", 1 - (embedding <=> ${vectorStr}::vector) as similarity
          FROM face_embeddings
          WHERE "photographerId" = ${photographerId}
            AND 1 - (embedding <=> ${vectorStr}::vector) >= ${threshold}
          ORDER BY similarity DESC
          LIMIT 100
        `;
      }
    } catch (sqlErr) {
      console.error('[StorageService] pgvector query failed:', sqlErr);
      return [];
    }

    const matchedPhotoIds = results.map((r) => r.photoId);
    if (matchedPhotoIds.length === 0) {
      return [];
    }

    const matchedPhotos = await this.prisma.photo.findMany({
      where: {
        id: { in: matchedPhotoIds },
        status: 'READY',
        isDeleted: false,
      },
      include: {
        event: true,
      },
    });

    return Promise.all(
      matchedPhotos.map(async (photo) => {
        const r2Key = photo.event.allowDownload
          ? photo.r2KeyOriginal
          : (photo.r2KeyThumb || photo.r2KeyOriginal);

        const url = await this.getReadUrl(r2Key);
        const thumbUrl = photo.r2KeyThumb
          ? await this.getReadUrl(photo.r2KeyThumb)
          : url;
        return {
          id: photo.id,
          url,
          thumbUrl,
          filenameOriginal: photo.filenameOriginal,
          fileSize: Number(photo.fileSize),
          tags: photo.hasFaces ? ['face'] : ['general'],
          allowDownload: photo.event.allowDownload,
          eventId: photo.eventId,
        };
      }),
    );
  }

  async getPublicEvents() {
    return this.prisma.event.findMany({
      where: { visibility: 'PUBLIC', status: 'PUBLISHED' },
      select: {
        id: true,
        title: true,
        slug: true,
        eventDate: true,
        location: true,
      },
    });
  }

  async searchFacePublic(selfieFile: any, eventId?: string, passcode?: string) {
    if (!selfieFile) return [];

    let eventIdsFilter: string[] = [];

    if (eventId && eventId !== 'all') {
      const event = await this.prisma.event.findUnique({
        where: { id: eventId }
      });
      if (!event) {
        throw new NotFoundException('Event not found');
      }

      if (event.status === 'DRAFT') {
        throw new BadRequestException('This event is currently in draft and cannot be searched.');
      }

      // Allow public face search within event without passcode (only returns matching face photos)
      const processingCount = await this.prisma.photo.count({
        where: {
          eventId,
          status: { in: ['UPLOADING', 'PROCESSING'] }
        }
      });
      if (processingCount > 0) {
        throw new BadRequestException('Indexing is in progress. Please try again in a few moments.');
      }

      eventIdsFilter = [eventId];
    } else {
      const publicEvents = await this.prisma.event.findMany({
        where: { visibility: 'PUBLIC', status: 'PUBLISHED' },
        select: { id: true },
      });
      eventIdsFilter = publicEvents.map(e => e.id);
    }

    if (eventIdsFilter.length === 0) {
      return [];
    }

    const queryEmbedding = await this.extractEmbedding(selfieFile);
    if (!queryEmbedding || queryEmbedding.length === 0) {
      return [];
    }

    const vectorStr = `[${queryEmbedding.join(',')}]`;
    const threshold = 0.40;

    let results: any[] = [];
    try {
      results = await this.prisma.$queryRaw<any[]>`
        SELECT DISTINCT "photoId", 1 - (embedding <=> ${vectorStr}::vector) as similarity
        FROM face_embeddings
        WHERE "eventId" = ANY(${eventIdsFilter})
          AND 1 - (embedding <=> ${vectorStr}::vector) >= ${threshold}
        ORDER BY similarity DESC
        LIMIT 100
      `;
    } catch (sqlErr) {
      console.error('[StorageService] pgvector public query failed:', sqlErr);
      return [];
    }

    const matchedPhotoIds = results.map((r) => r.photoId);
    if (matchedPhotoIds.length === 0) {
      return [];
    }

    const matchedPhotos = await this.prisma.photo.findMany({
      where: {
        id: { in: matchedPhotoIds },
        status: 'READY',
        isDeleted: false,
      },
      include: {
        event: { include: { photographer: true } },
      },
    });

    return Promise.all(
      matchedPhotos.map(async (photo) => {
        const event = photo.event;
        const isWatermarked = event.watermarkEnabled;

        let url = '';
        let thumbUrl = '';

        const hideDirectStorageUrl = isWatermarked || (event && !event.allowDownload);

        if (hideDirectStorageUrl) {
          const apiBase = process.env.PUBLIC_API_URL || 'http://localhost:5000';
          url = `${apiBase}/api/public/events/${event.slug}/photos/${photo.id}/view`;
          thumbUrl = `${apiBase}/api/public/events/${event.slug}/photos/${photo.id}/view?thumb=true`;
        } else {
          url = await this.getReadUrl(photo.r2KeyOriginal);
          thumbUrl = photo.r2KeyThumb ? await this.getReadUrl(photo.r2KeyThumb) : url;
        }

        return {
          id: photo.id,
          filenameOriginal: photo.filenameOriginal,
          url,
          thumbUrl,
          tags: photo.hasFaces ? ['face'] : ['general'],
          allowDownload: photo.event.allowDownload,
          eventId: photo.eventId,
          type: photo.type || 'IMAGE',
          duration: photo.duration || 0,
        };
      }),
    );
  }

  async deletePhoto(photographerId: string, photoId: string) {
    const photo = await this.prisma.photo.findFirst({
      where: { id: photoId, photographerId }
    });

    if (!photo) {
      throw new NotFoundException('Photo not found');
    }

    // Check if other photo records are referencing the same R2 key
    const duplicateCount = await this.prisma.photo.count({
      where: { r2KeyOriginal: photo.r2KeyOriginal }
    });

    try {
      // Only delete from R2 if this is the ONLY database photo record pointing to this key
      if (duplicateCount <= 1) {
        // 1. Delete original high-res photo from R2
        const command = new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: photo.r2KeyOriginal
        });
        await this.s3Client.send(command);

        // 2. Delete generated thumbnail from R2 if it exists
        if (photo.r2KeyThumb) {
          const thumbCommand = new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: photo.r2KeyThumb
          });
          await this.s3Client.send(thumbCommand);
        }

        // 3. Delete generated face-scan preview from R2 if it exists
        const facePreviewKey = `${photographerId}/events/${photo.eventId}/previews/${photoId}.jpg`;
        const previewCommand = new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: facePreviewKey
        });
        await this.s3Client.send(previewCommand).catch(() => { });
      }
    } catch (err) {
      console.error('Failed to delete photo or thumbnail from R2:', err);
    }

    // Delete photo record first
    const deleteResult = await this.prisma.photo.delete({
      where: { id: photoId }
    });

    // Recalculate actual storage immediately to prevent size discrepancy
    await this.recalculateStorage(photographerId);

    return deleteResult;
  }


  async getGuestUploadLimitsStatus(slug: string) {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      select: {
        id: true,
        allowGuestUploads: true,
        maxGuestUploadFiles: true,
        maxGuestUploadStorage: true
      }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const guestPhotosStats = await this.prisma.photo.aggregate({
      where: { eventId: event.id, isGuestUpload: true },
      _count: { id: true },
      _sum: { fileSize: true }
    });

    const maxFiles = event.maxGuestUploadFiles || 0;
    const maxStorage = event.maxGuestUploadStorage ? event.maxGuestUploadStorage.toString() : '0';

    return {
      allowGuestUploads: event.allowGuestUploads,
      maxGuestUploadFiles: maxFiles,
      maxGuestUploadStorage: maxStorage,
      currentGuestCount: guestPhotosStats._count.id || 0,
      currentGuestSize: guestPhotosStats._sum.fileSize ? guestPhotosStats._sum.fileSize.toString() : '0'
    };
  }
  async calculateStorageFromR2(userIdOrPhotographerId: string): Promise<bigint> {
    const photographer = await this.prisma.photographer.findFirst({
      where: {
        OR: [
          { id: userIdOrPhotographerId },
          { userId: userIdOrPhotographerId }
        ]
      }
    });

    if (!photographer) return BigInt(0);
    const photographerId = photographer.id;

    let totalBytes = BigInt(0);
    let isTruncated = true;
    let continuationToken: string | undefined = undefined;

    // Unified single pass scan under `${photographerId}/`
    while (isTruncated) {
      try {
        const command = new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: `${photographerId}/`,
          ContinuationToken: continuationToken,
        });

        const response: any = await this.s3Client.send(command);
        if (response.Contents) {
          for (const item of response.Contents) {
            if (item.Size) {
              totalBytes += BigInt(item.Size);
            }
          }
        }
        isTruncated = response.IsTruncated || false;
        continuationToken = response.NextContinuationToken;
      } catch (err) {
        console.error(`[R2StorageCalc] Error listing prefix ${photographerId}/:`, err);
        isTruncated = false;
      }
    }

    return totalBytes;
  }

  // Helper to fetch all active R2 database keys for a photographer (Events, Portfolio, Branding, Cards)
  private async getAllPhotographerActiveDbKeys(photographerId: string): Promise<Set<string>> {
    const dbKeysSet = new Set<string>();

    // 1. Event Photos & Media
    const dbPhotos = await this.prisma.photo.findMany({
      where: { photographerId },
      select: { r2KeyOriginal: true, r2KeyThumb: true }
    });
    dbPhotos.forEach(p => {
      if (p.r2KeyOriginal) {
        dbKeysSet.add(p.r2KeyOriginal);
        const basename = p.r2KeyOriginal.split('/').pop();
        if (basename) dbKeysSet.add(basename);
      }
      if (p.r2KeyThumb) {
        dbKeysSet.add(p.r2KeyThumb);
        const basename = p.r2KeyThumb.split('/').pop();
        if (basename) dbKeysSet.add(basename);
      }
    });

    // 2. Portfolio Showcase Photos
    const portfolioPhotos = await this.prisma.portfolioPhoto.findMany({
      where: { photographerId },
      select: { r2KeyOriginal: true, r2KeyThumb: true }
    });
    portfolioPhotos.forEach(p => {
      if (p.r2KeyOriginal) {
        dbKeysSet.add(p.r2KeyOriginal);
        dbKeysSet.add(`${photographerId}/portfolio/${p.r2KeyOriginal}`);
        const basename = p.r2KeyOriginal.split('/').pop();
        if (basename) dbKeysSet.add(basename);
      }
      if (p.r2KeyThumb) {
        dbKeysSet.add(p.r2KeyThumb);
        dbKeysSet.add(`${photographerId}/portfolio/${p.r2KeyThumb}`);
        const basename = p.r2KeyThumb.split('/').pop();
        if (basename) dbKeysSet.add(basename);
      }
    });

    // 3. Photographer Settings (Branding, Watermarks, Hero, About, Reels, Business Cards)
    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
      include: { businessCard: true }
    });

    if (photographer) {
      const addKey = (k: string | null | undefined, prefix: string) => {
        if (!k) return;
        let keyStr = k;
        if (k.includes('key=')) {
          const match = k.match(/key=([^&]+)/);
          if (match) keyStr = decodeURIComponent(match[1]);
        } else if (k.startsWith('http://') || k.startsWith('https://')) {
          const match = decodeURIComponent(k).match(/((?:[a-f0-9-]+\/)?portfolio\/reels\/[^?#]+)/);
          if (match) keyStr = match[1];
        }

        dbKeysSet.add(keyStr);
        dbKeysSet.add(`${photographerId}/${prefix}/${keyStr}`);
        const basename = keyStr.split('/').pop();
        if (basename) dbKeysSet.add(basename);
      };

      addKey(photographer.watermarkImageKey, 'branding');
      addKey(photographer.studioLogoKey, 'branding');
      addKey(photographer.studioHeroBannerKey, 'branding');
      addKey(photographer.portfolioHeroImageKey, 'portfolio');
      addKey(photographer.portfolioAboutImageKey, 'portfolio');
      addKey(photographer.portfolioVideoUrl, 'portfolio');
      addKey(photographer.portfolioBtsUrl, 'portfolio');

      if (photographer.portfolioReels && Array.isArray(photographer.portfolioReels)) {
        (photographer.portfolioReels as any[]).forEach(reel => {
          if (reel.r2Key) addKey(reel.r2Key, 'portfolio');
          if (reel.key) addKey(reel.key, 'portfolio');
          if (reel.url) addKey(reel.url, 'portfolio');
          if (reel.videoUrl) addKey(reel.videoUrl, 'portfolio');
        });
      }

      if (photographer.businessCard) {
        const bc = photographer.businessCard as any;
        if (bc.avatarKey) addKey(bc.avatarKey, 'business-cards');
        if (bc.logoKey) addKey(bc.logoKey, 'business-cards');
        if (bc.qrKey) addKey(bc.qrKey, 'business-cards');
      }
    }

    return dbKeysSet;
  }

  // Get detailed R2 storage breakdown by category (Events, Portfolio, Branding)
  async getStorageBreakdown(userIdOrPhotographerId: string) {
    const photographer = await this.prisma.photographer.findFirst({
      where: {
        OR: [
          { id: userIdOrPhotographerId },
          { userId: userIdOrPhotographerId }
        ]
      }
    });

    if (!photographer) {
      return { eventsBytes: 0, portfolioBytes: 0, brandingBytes: 0, totalBytes: 0 };
    }

    const photographerId = photographer.id;
    let eventsBytes = BigInt(0);
    let portfolioBytes = BigInt(0);
    let brandingBytes = BigInt(0);
    let wasteBytes = BigInt(0);
    let wastePhotosSize = BigInt(0);
    let wasteVideosSize = BigInt(0);
    let wastePhotosCount = 0;
    let wasteVideosCount = 0;

    // Retrieve full set of active database keys across events, portfolio, branding, and digital cards
    const dbKeysSet = await this.getAllPhotographerActiveDbKeys(photographerId);

    // Scan all objects under photographer prefix directly from R2 to classify them
    let isTruncated = true;
    let continuationToken: string | undefined = undefined;
    while (isTruncated) {
      try {
        const command = new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: `${photographerId}/`,
          ContinuationToken: continuationToken,
        });
        const response: any = await this.s3Client.send(command);
        if (response.Contents) {
          for (const item of response.Contents) {
            const key = item.Key || '';
            const size = BigInt(item.Size || 0);

            if (key.includes('/temp_frames/')) continue; // Skip temporary scanning frames

            const basename = key.split('/').pop() || '';
            const isLinked = dbKeysSet.has(key) || dbKeysSet.has(basename);

            if (isLinked) {
              if (key.includes('/portfolio/')) {
                portfolioBytes += size;
              } else if (key.includes('/branding/') || key.includes('/business-cards/')) {
                brandingBytes += size;
              } else {
                eventsBytes += size;
              }
            } else {
              // File exists in R2 but is NOT linked in DB (Orphaned / Waste across Events, Portfolio & Branding)
              wasteBytes += size;
              const isVideo = key.match(/\.(mp4|mkv|mov|webm|avi)$/i);
              if (isVideo) {
                wasteVideosSize += size;
                wasteVideosCount++;
              } else {
                wastePhotosSize += size;
                wastePhotosCount++;
              }
            }
          }
        }
        isTruncated = response.IsTruncated || false;
        continuationToken = response.NextContinuationToken;
      } catch (err) {
        isTruncated = false;
      }
    }

    // Get Trash Bytes from DB
    const trashSum = await this.prisma.photo.aggregate({
      where: { photographerId, isDeleted: true },
      _sum: { fileSize: true },
    });
    const trashBytes = trashSum._sum.fileSize ? BigInt(trashSum._sum.fileSize.toString()) : BigInt(0);

    const liveEventsBytes = eventsBytes > trashBytes ? eventsBytes - trashBytes : eventsBytes;
    const totalBytes = eventsBytes + portfolioBytes + brandingBytes;

    // Sync valid live bytes to DB asynchronously to update sidebar widget
    this.prisma.photographer.update({
      where: { id: photographerId },
      data: { totalStorageUsedBytes: totalBytes }
    }).catch(() => { });

    // Retrieve active subscription and package dual limits
    const activeSub = await this.prisma.subscription.findFirst({
      where: { photographerId, status: 'ACTIVE' },
      include: { package: true }
    });

    const featurePortfolioWebsite = !!(activeSub?.package?.featurePortfolioWebsite);
    const featureCustomBranding = !!(activeSub?.package?.featureCustomBranding);
    const isPortfolioEnabled = featurePortfolioWebsite || featureCustomBranding;

    const maxEventsStorageMb = activeSub?.package?.maxEventsStorageMb ?? 200;
    const maxPortfolioStorageMb = activeSub?.package?.maxPortfolioStorageMb ?? 0;

    const limitEventsBytes = maxEventsStorageMb * 1024 * 1024;
    const limitPortfolioBytes = isPortfolioEnabled ? maxPortfolioStorageMb * 1024 * 1024 : 0;

    return {
      eventsBytes: Number(liveEventsBytes),
      portfolioBytes: Number(portfolioBytes),
      brandingBytes: Number(brandingBytes),
      trashBytes: Number(trashBytes),
      wasteBytes: Number(wasteBytes),
      wastePhotosSize: Number(wastePhotosSize),
      wasteVideosSize: Number(wasteVideosSize),
      wastePhotosCount,
      wasteVideosCount,
      totalBytes: Number(totalBytes),
      limitEventsBytes,
      limitPortfolioBytes,
      maxEventsStorageMb,
      maxPortfolioStorageMb,
      featurePortfolioWebsite,
      featureCustomBranding,
      isPortfolioEnabled,
    };
  }


  // Soft delete a single photo or video (Move to Trash)
  async softDeletePhoto(photographerId: string, photoId: string) {
    const photo = await this.prisma.photo.findFirst({
      where: { id: photoId, photographerId, isDeleted: false },
    });

    if (!photo) {
      throw new NotFoundException('Photo or Video not found');
    }

    await this.prisma.photo.update({
      where: { id: photoId },
      data: { isDeleted: true, deletedAt: new Date() },
    });

    return { success: true, message: 'Item moved to trash' };
  }

  // Soft delete multiple photos or videos (Batch Move to Trash)
  async batchSoftDeletePhotos(photographerId: string, photoIds: string[]) {
    await this.prisma.photo.updateMany({
      where: { id: { in: photoIds }, photographerId },
      data: { isDeleted: true, deletedAt: new Date() },
    });

    return { success: true, count: photoIds.length };
  }

  // Get all Trash items (Deleted Events and Deleted Photos/Videos)
  async getTrashData(photographerId: string) {
    const deletedEvents = await this.prisma.event.findMany({
      where: { photographerId, isDeleted: true },
      orderBy: { deletedAt: 'desc' },
      include: {
        _count: { select: { photos: true } },
      },
    });

    const deletedPhotos = await this.prisma.photo.findMany({
      where: { photographerId, isDeleted: true },
      orderBy: { deletedAt: 'desc' },
      include: {
        event: { select: { id: true, title: true, isDeleted: true } },
      },
    });

    const photosWithUrls = await Promise.all(
      deletedPhotos.map(async (photo) => {
        const url = await this.getReadUrl(photo.r2KeyOriginal);
        const thumbUrl = photo.r2KeyThumb ? await this.getReadUrl(photo.r2KeyThumb) : url;
        return {
          ...photo,
          fileSizeNum: Number(photo.fileSize),
          url,
          thumbUrl,
        };
      }),
    );

    return {
      events: deletedEvents,
      photos: photosWithUrls,
    };
  }

  // Restore photo/video from Trash (optionally move to targetEventId if parent event deleted)
  async restorePhoto(photographerId: string, photoId: string, targetEventId?: string) {
    const photo = await this.prisma.photo.findFirst({
      where: { id: photoId, photographerId, isDeleted: true },
      include: { event: { select: { isDeleted: true } } },
    });

    if (!photo) {
      throw new NotFoundException('Deleted item not found in trash');
    }

    let finalEventId = photo.eventId;

    // If targetEventId is provided (e.g. user selected a new active event)
    if (targetEventId) {
      const targetEvent = await this.prisma.event.findFirst({
        where: { id: targetEventId, photographerId, isDeleted: false },
      });
      if (!targetEvent) {
        throw new NotFoundException('Target active event not found');
      }
      finalEventId = targetEventId;
    } else if (photo.event.isDeleted) {
      throw new BadRequestException('PARENT_EVENT_DELETED');
    }

    await this.prisma.photo.update({
      where: { id: photoId },
      data: {
        eventId: finalEventId,
        isDeleted: false,
        deletedAt: null,
      },
    });

    await this.prisma.faceEmbedding.updateMany({
      where: { photoId, photographerId },
      data: {
        eventId: finalEventId,
        clusterId: null,
      },
    });

    return { success: true, message: 'Item restored successfully' };
  }

  // Empty Trash: Hard delete ALL deleted events and deleted photos/videos permanently
  async emptyTrash(photographerId: string) {
    // 1. Get all soft-deleted photos
    const deletedPhotos = await this.prisma.photo.findMany({
      where: { photographerId, isDeleted: true },
      select: { id: true },
    });

    if (deletedPhotos.length > 0) {
      await this.batchDeletePhotos(photographerId, deletedPhotos.map(p => p.id));
    }

    // 2. Get all soft-deleted events
    const deletedEvents = await this.prisma.event.findMany({
      where: { photographerId, isDeleted: true },
      select: { id: true },
    });

    for (const e of deletedEvents) {
      try {
        await this.deleteEventObjectsFromR2(photographerId, e.id);
        await this.prisma.event.delete({ where: { id: e.id } });
      } catch (err) {
        console.error(`[EmptyTrash] Failed to purge event ${e.id}:`, err);
      }
    }

    await this.recalculateStorage(photographerId);

    return { success: true, message: 'Trash emptied successfully' };
  }


  // Delete all objects under an event from Cloudflare R2 bucket
  async deleteEventObjectsFromR2(photographerId: string, eventId: string) {
    const prefix = `${photographerId}/events/${eventId}/`;
    let isTruncated = true;
    let continuationToken: string | undefined = undefined;

    while (isTruncated) {
      try {
        const listCommand = new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });

        const listResponse: any = await this.s3Client.send(listCommand);
        if (listResponse.Contents && listResponse.Contents.length > 0) {
          const deleteParams = {
            Bucket: this.bucketName,
            Delete: {
              Objects: listResponse.Contents.map((obj: any) => ({ Key: obj.Key })),
              Quiet: true
            }
          };
          await this.s3Client.send(new DeleteObjectsCommand(deleteParams));
        }

        isTruncated = listResponse.IsTruncated || false;
        continuationToken = listResponse.NextContinuationToken;
      } catch (err) {
        console.error(`[deleteEventObjectsFromR2] Error deleting prefix ${prefix}:`, err);
        isTruncated = false;
      }
    }
  }


  // Helper to recalculate actual live storage usage directly from Cloudflare R2 bucket to prevent drift
  async recalculateStorage(photographerId: string): Promise<bigint> {
    const breakdown = await this.getStorageBreakdown(photographerId);
    const actualBytes = BigInt(breakdown.eventsBytes + breakdown.portfolioBytes + breakdown.brandingBytes);

    // Update photographer record in database
    await this.prisma.photographer.update({
      where: { id: photographerId },
      data: { totalStorageUsedBytes: actualBytes }
    });

    // Update active subscription used bytes
    const activeSub = await this.prisma.subscription.findFirst({
      where: { photographerId, status: 'ACTIVE' },
      orderBy: { startsAt: 'desc' }
    });
    if (activeSub) {
      await this.prisma.subscription.update({
        where: { id: activeSub.id },
        data: { usedBytes: actualBytes }
      });
    }

    return actualBytes;
  }


  async batchDeletePhotos(photographerId: string, photoIds: string[]) {
    if (!photoIds || photoIds.length === 0) return { deleted: 0 };

    // Fetch all valid photos belonging to this photographer
    const photos = await this.prisma.photo.findMany({
      where: { id: { in: photoIds }, photographerId }
    });

    if (photos.length === 0) return { deleted: 0 };

    // Collect all R2 keys to delete
    const keysToDelete: string[] = [];
    for (const photo of photos) {
      if (photo.r2KeyOriginal) keysToDelete.push(photo.r2KeyOriginal);
      if (photo.r2KeyThumb) keysToDelete.push(photo.r2KeyThumb);
      keysToDelete.push(`${photographerId}/events/${photo.eventId}/previews/${photo.id}.jpg`);
    }

    // Delete in chunks of 1000 via DeleteObjectsCommand (S3 Batch Delete)
    if (keysToDelete.length > 0) {
      const chunkSize = 1000;
      for (let i = 0; i < keysToDelete.length; i += chunkSize) {
        const chunk = keysToDelete.slice(i, i + chunkSize);
        try {
          await this.s3Client.send(new DeleteObjectsCommand({
            Bucket: this.bucketName,
            Delete: {
              Objects: chunk.map(k => ({ Key: k })),
              Quiet: true
            }
          }));
        } catch (err) {
          console.error('[batchDeletePhotos] R2 chunk delete error:', err);
        }
      }
    }

    // Delete all photo records from DB at ONCE (cascade deletes FaceEmbeddings, FavoritePhotos)
    const result = await this.prisma.photo.deleteMany({
      where: { id: { in: photos.map(p => p.id) } }
    });

    // Recalculate actual storage in background
    this.recalculateStorage(photographerId).catch(err =>
      console.error('[batchDeletePhotos] Recalculate storage error:', err)
    );

    return { deleted: result.count };
  }

  async batchRestorePhotos(photographerId: string, photoIds: string[], targetEventId?: string) {
    if (!photoIds || photoIds.length === 0) return { restored: 0 };

    // Find all deleted photos belonging to photographer
    const photos = await this.prisma.photo.findMany({
      where: { id: { in: photoIds }, photographerId, isDeleted: true },
      include: { event: { select: { isDeleted: true } } }
    });

    if (photos.length === 0) return { restored: 0 };

    const validPhotoIds: string[] = [];
    for (const photo of photos) {
      if (!targetEventId && photo.event?.isDeleted) {
        // Skip photos whose parent event is deleted unless targetEventId is specified
        continue;
      }
      validPhotoIds.push(photo.id);
    }

    if (validPhotoIds.length === 0) {
      throw new BadRequestException('PARENT_EVENT_DELETED');
    }

    const updateData: any = {
      isDeleted: false,
      deletedAt: null,
    };
    if (targetEventId) {
      updateData.eventId = targetEventId;
    }

    // Update all photo records at ONCE
    const result = await this.prisma.photo.updateMany({
      where: { id: { in: validPhotoIds } },
      data: updateData
    });

    // Update face embeddings at ONCE
    const faceEmbedData: any = { clusterId: null };
    if (targetEventId) faceEmbedData.eventId = targetEventId;
    await this.prisma.faceEmbedding.updateMany({
      where: { photoId: { in: validPhotoIds }, photographerId },
      data: faceEmbedData
    });

    return { restored: result.count };
  }

  async clearWasteStorage(photographerId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId }
    });
    if (!photographer) throw new NotFoundException('Photographer not found');

    // Retrieve comprehensive DB set across events, portfolio, branding, and digital cards
    const dbKeysSet = await this.getAllPhotographerActiveDbKeys(photographerId);
    const keysToDelete: string[] = [];

    // Scan all R2 files to locate waste
    let isTruncated = true;
    let continuationToken: string | undefined = undefined;
    while (isTruncated) {
      try {
        const command = new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: `${photographerId}/`,
          ContinuationToken: continuationToken,
        });
        const response: any = await this.s3Client.send(command);
        if (response.Contents) {
          for (const item of response.Contents) {
            const key = item.Key || '';
            if (key.includes('/temp_frames/')) continue; // Skip temporary face scanning frames

            const basename = key.split('/').pop() || '';
            const isLinked = dbKeysSet.has(key) || dbKeysSet.has(basename);

            if (!isLinked) {
              keysToDelete.push(key);
            }
          }
        }
        isTruncated = response.IsTruncated || false;
        continuationToken = response.NextContinuationToken;
      } catch (err) {
        isTruncated = false;
      }
    }

    if (keysToDelete.length === 0) return { clearedCount: 0 };

    // Batch delete waste objects from R2
    const batchSize = 1000;
    let deletedCount = 0;
    for (let i = 0; i < keysToDelete.length; i += batchSize) {
      const chunk = keysToDelete.slice(i, i + batchSize);
      try {
        await this.s3Client.send(new DeleteObjectsCommand({
          Bucket: this.bucketName,
          Delete: {
            Objects: chunk.map(key => ({ Key: key }))
          }
        }));
        deletedCount += chunk.length;
      } catch (err: any) {
        this.logger.error(`[clearWasteStorage] Batch delete chunk failed: ${err.message}`);
      }
    }

    // Recalculate storage size
    await this.recalculateStorage(photographerId);

    return { clearedCount: deletedCount };
  }


  async batchMove(photographerId: string, photoIds: string[], targetEventId: string) {

    const event = await this.prisma.event.findFirst({
      where: { id: targetEventId, photographerId }
    });
    if (!event) {
      throw new NotFoundException('Target event not found');
    }

    const updatePhotosResult = await this.prisma.photo.updateMany({
      where: {
        id: { in: photoIds },
        photographerId
      },
      data: {
        eventId: targetEventId
      }
    });

    await this.prisma.faceEmbedding.updateMany({
      where: {
        photoId: { in: photoIds },
        photographerId
      },
      data: {
        eventId: targetEventId,
        clusterId: null // Reset the cluster ID so it reclusters in the target event
      }
    });

    return updatePhotosResult;
  }

  async batchCopy(photographerId: string, photoIds: string[], targetEventId: string) {
    const event = await this.prisma.event.findFirst({
      where: { id: targetEventId, photographerId }
    });
    if (!event) {
      throw new NotFoundException('Target event not found');
    }

    const photosToCopy = await this.prisma.photo.findMany({
      where: {
        id: { in: photoIds },
        photographerId
      }
    });

    const newPhotosData: any[] = [];
    let sizeAccumulator = BigInt(0);

    for (const p of photosToCopy) {
      newPhotosData.push({
        eventId: targetEventId,
        photographerId,
        filenameOriginal: p.filenameOriginal,
        filenameStored: p.filenameStored,
        r2KeyOriginal: p.r2KeyOriginal,
        mimeType: p.mimeType,
        fileSize: p.fileSize,
        status: p.status,
        hasFaces: p.hasFaces,
        faceCount: p.faceCount
      });
      sizeAccumulator += p.fileSize;
    }

    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
      include: {
        subscriptions: {
          where: { status: 'ACTIVE' },
          orderBy: { startsAt: 'desc' },
          take: 1
        }
      }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer not found');
    }

    const activeSubscription = photographer.subscriptions[0];
    const limitBytes = activeSubscription?.limitEventsBytes ?? activeSubscription?.limitBytes ?? BigInt(5000 * 1024 * 1024);
    const totalStorageUsedBytes = photographer.totalStorageUsedBytes || BigInt(0);

    if (totalStorageUsedBytes + sizeAccumulator > limitBytes) {
      throw new BadRequestException('Storage limit exceeded. Please upgrade your plan.');
    }

    await this.prisma.photo.createMany({
      data: newPhotosData
    });

    await this.prisma.photographer.update({
      where: { id: photographerId },
      data: {
        totalStorageUsedBytes: {
          increment: sizeAccumulator
        }
      }
    });

    const activeSub = await this.prisma.subscription.findFirst({
      where: { photographerId, status: 'ACTIVE' },
      orderBy: { startsAt: 'desc' }
    });

    if (activeSub) {
      await this.prisma.subscription.update({
        where: { id: activeSub.id },
        data: {
          usedBytes: {
            increment: sizeAccumulator
          }
        }
      });
    }

    return { success: true, count: newPhotosData.length };
  }

  async reindexEventPhotos(photographerId: string, eventId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId }
    });
    const event = await this.prisma.event.findUnique({
      where: { id: eventId }
    });

    // 1. Fetch all photos in the event
    const photos = await this.prisma.photo.findMany({
      where: { eventId, photographerId }
    });

    // Correct eventId for any face embeddings that are out of sync
    const photoIds = photos.map(p => p.id);
    if (photoIds.length > 0) {
      await this.prisma.faceEmbedding.updateMany({
        where: {
          photoId: { in: photoIds },
          photographerId,
          eventId: { not: eventId }
        },
        data: {
          eventId: eventId,
          clusterId: null
        }
      });
    }

    const needsThumbnailItems = photos.filter(p => p.status !== 'READY' || p.thumbnailStatus !== 'READY' || !p.r2KeyThumb);

    if (needsThumbnailItems.length > 0) {
      const pendingPhotoIds = needsThumbnailItems.map(p => p.id);
      await this.prisma.photo.updateMany({
        where: { id: { in: pendingPhotoIds } },
        data: { thumbnailStatus: 'PENDING', status: 'PROCESSING' }
      });

      this.logger.log(`[Reindex] Batch dispatching ${needsThumbnailItems.length} items (photos & videos) to Modal Engine...`);
      await this.processBatchThumbnailsViaGoWorker(needsThumbnailItems.map(p => ({ id: p.id, r2KeyOriginal: p.r2KeyOriginal })))
        .catch(err => this.logger.error(`[Reindex] Batch worker error: ${err.message}`));

      // Re-trigger background video processing for any stuck videos
      for (const item of needsThumbnailItems.filter(p => p.type === 'VIDEO')) {
        this.runBackgroundVideoProcessing(photographerId, item.id, item.eventId, item.r2KeyOriginal, item.uploadBatchId)
          .catch(err => this.logger.error(`[Reindex] Video processing error for ${item.id}: ${err.message}`));
      }
    }

    return {
      success: true,
      message: needsThumbnailItems.length > 0
        ? `Triggered batch thumbnail recovery for ${needsThumbnailItems.length} items (photos & videos) via Modal Engine.`
        : `All thumbnails are already READY. No action needed.`
    };
  }



  async getEventFaces(photographerId: string, eventId: string) {
    interface RawFaceRow {
      id: string;
      photoId: string;
      faceIndex: number;
      bboxX: number;
      bboxY: number;
      bboxW: number;
      bboxH: number;
      confidence: number;
      embeddingStr: string;
      clusterId: string | null;
      r2KeyOriginal: string;
      r2KeyThumb: string | null;
      photoType: string;
      timestamp: number | null;
    }

    const faces = await this.prisma.$queryRaw<RawFaceRow[]>`
      SELECT f.id, f."photoId", f."faceIndex", f."bboxX", f."bboxY", f."bboxW", f."bboxH", f.confidence, f.embedding::text as "embeddingStr", f."clusterId", p."r2KeyOriginal", p."r2KeyThumb", p.type as "photoType", f.timestamp
      FROM face_embeddings f
      JOIN photos p ON f."photoId" = p.id
      WHERE f."eventId" = ${eventId} AND f."photographerId" = ${photographerId} AND p."isDeleted" = false
    `;

    return Promise.all(
      faces.map(async (f) => {
        const readKey = f.r2KeyThumb || f.r2KeyOriginal;
        const photoUrl = readKey ? await this.getReadUrl(readKey) : '';
        let parsedEmbedding: number[] = [];
        if (f.embeddingStr) {
          try {
            parsedEmbedding = JSON.parse(f.embeddingStr);
          } catch (err) {
            console.error('Failed to parse face embedding vector:', err);
          }
        }
        return {
          id: f.id,
          photoId: f.photoId,
          faceIndex: f.faceIndex,
          bboxX: f.bboxX,
          bboxY: f.bboxY,
          bboxW: f.bboxW,
          bboxH: f.bboxH,
          confidence: f.confidence,
          embedding: parsedEmbedding,
          clusterId: f.clusterId,
          photoUrl,
          photoType: f.photoType || 'IMAGE',
          timestamp: f.timestamp,
        };
      })
    );
  }

  async mergeClusters(photographerId: string, eventId: string, faceIds: string[]) {
    if (!faceIds || faceIds.length === 0) {
      return { success: false, message: 'No face IDs provided' };
    }

    // Find if any of these faces already have an existing clusterId
    const existingFaces = await this.prisma.faceEmbedding.findMany({
      where: {
        id: { in: faceIds },
        eventId,
        photographerId,
      },
      select: {
        clusterId: true
      }
    });

    let targetClusterId = existingFaces.find(f => f.clusterId !== null)?.clusterId;

    if (!targetClusterId) {
      // If none of them have an existing clusterId, generate a new one
      const { v4: uuidv4 } = require('uuid');
      targetClusterId = uuidv4();
    }

    // Update all selected faces to have the same targetClusterId
    await this.prisma.faceEmbedding.updateMany({
      where: {
        id: { in: faceIds },
        eventId,
        photographerId
      },
      data: {
        clusterId: targetClusterId
      }
    });

    return { success: true, clusterId: targetClusterId };
  }

  async getPublicEventBySlug(slug: string) {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      include: {
        photographer: true,
        _count: {
          select: { photos: { where: { status: 'READY' } } }
        }
      }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (event.status === 'DRAFT') {
      throw new BadRequestException('This event is currently in draft.');
    }

    const requiresPasscode = event.visibility === 'PRIVATE' || (event.passcode && event.passcode !== '');

    let hasBranding = false;
    let hasGuestUpload = false;
    let hasClientSelection = false;
    let hasAiFaceSearch = false;
    if (event.photographer) {
      const activeSub = await this.prisma.subscription.findFirst({
        where: { photographerId: event.photographer.id, status: 'ACTIVE' },
        include: { package: true },
        orderBy: { createdAt: 'desc' }
      });
      hasBranding = activeSub?.package ? activeSub.package.featureCustomBranding : false;
      hasGuestUpload = activeSub?.package ? activeSub.package.featureGuestUpload : false;
      hasClientSelection = activeSub?.package ? activeSub.package.featureClientSelection : false;
      hasAiFaceSearch = activeSub?.package ? activeSub.package.featureAiPhotoSearch : false;
    }

    return {
      id: event.id,
      title: event.title,
      slug: event.slug,
      eventType: event.eventType,
      description: event.description,
      eventDate: event.eventDate,
      location: event.location,
      allowDownload: event.allowDownload,
      allowFavorites: hasClientSelection ? event.allowFavorites : false,
      faceSearchEnabled: hasAiFaceSearch ? event.faceSearchEnabled : false,
      maxFavorites: event.maxFavorites,
      requiresPasscode,
      themeKey: event.themeKey,
      applyThemeToClientGallery: event.applyThemeToClientGallery,
      allowGuestUploads: hasGuestUpload ? event.allowGuestUploads : false,
      maxGuestUploadFiles: event.maxGuestUploadFiles || 0,
      maxGuestUploadStorage: event.maxGuestUploadStorage ? event.maxGuestUploadStorage.toString() : '0',
      photosCount: event._count.photos,
      photos: !requiresPasscode ? await this.getPublicPhotos(event.id, event.slug) : [],
      photographerBranding: event.photographer ? {
        id: event.photographer.id,
        studioLogoKey: hasBranding ? event.photographer.studioLogoKey : null,
        studioSubdomain: hasBranding ? event.photographer.studioSubdomain : null,
        primaryColor: hasBranding ? event.photographer.primaryColor : '#eab308',
        secondaryColor: hasBranding ? event.photographer.secondaryColor : '#12131a',
        instagramUrl: hasBranding ? event.photographer.instagramUrl : null,
        facebookUrl: hasBranding ? event.photographer.facebookUrl : null,
        whatsappPhone: hasBranding ? event.photographer.whatsappPhone : null,
        studioHeroBannerKey: hasBranding ? event.photographer.studioHeroBannerKey : null,
        studioFontFamily: hasBranding ? event.photographer.studioFontFamily : null,
        seoTitle: hasBranding ? event.photographer.seoTitle : null,
        seoDescription: hasBranding ? event.photographer.seoDescription : null,
        hidePoweredBy: hasBranding ? event.photographer.hidePoweredBy : false,
        customFooterText: hasBranding ? event.photographer.customFooterText : null,
        studioName: event.photographer.studioName || 'Studio'
      } : null
    };
  }

  async getPublicEventPhotos(slug: string, passcode?: string) {
    const event = await this.prisma.event.findUnique({
      where: { slug }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (event.status === 'DRAFT') {
      throw new BadRequestException('This event is currently in draft.');
    }

    const requiresPasscode = event.visibility === 'PRIVATE' || (event.passcode && event.passcode !== '');
    if (requiresPasscode) {
      if (!passcode || passcode !== event.passcode) {
        throw new UnauthorizedException('Invalid event passcode');
      }
    }

    return this.getPublicPhotos(event.id, event.slug);
  }

  private async getPublicPhotos(eventId: string, slug: string) {
    const event = await this.prisma.event.findUnique({
      where: { id: eventId },
      include: { photographer: true }
    });

    const photos = await this.prisma.photo.findMany({
      where: { eventId, status: 'READY', isDeleted: false },
      orderBy: { createdAt: 'desc' }
    });

    const isWatermarked = event && event.watermarkEnabled;

    return Promise.all(
      photos.map(async (photo) => {
        let url = '';
        let thumbUrl = '';

        const hideDirectStorageUrl = isWatermarked || (event && !event.allowDownload);

        if (hideDirectStorageUrl) {
          const apiBase = process.env.PUBLIC_API_URL || 'http://localhost:5000';
          url = `${apiBase}/api/public/events/${slug}/photos/${photo.id}/view`;
          thumbUrl = `${apiBase}/api/public/events/${slug}/photos/${photo.id}/view?thumb=true`;
        } else {
          url = await this.getReadUrl(photo.r2KeyOriginal);
          thumbUrl = photo.r2KeyThumb ? await this.getReadUrl(photo.r2KeyThumb) : url;
        }

        return {
          id: photo.id,
          filenameOriginal: photo.filenameOriginal,
          url,
          thumbUrl,
          type: photo.type || 'IMAGE',
          duration: photo.duration || 0,
        };
      })
    );
  }

  async saveClientFavorites(
    slug: string,
    clientSessionId: string,
    clientName: string,
    clientPhone: string | undefined,
    photoIds: string[]
  ) {
    const event = await this.prisma.event.findUnique({
      where: { slug }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const activeSub = await this.prisma.subscription.findFirst({
      where: { photographerId: event.photographerId, status: 'ACTIVE' },
      include: { package: true },
      orderBy: { createdAt: 'desc' }
    });
    const hasClientSelection = activeSub?.package ? activeSub.package.featureClientSelection : false;
    if (!hasClientSelection) {
      throw new BadRequestException('Client photo selection feature is disabled on this plan.');
    }

    // Delete ALL existing favorites for this entire event (Universal overwrite)
    await this.prisma.favoritePhoto.deleteMany({
      where: {
        eventId: event.id
      }
    });

    if (photoIds.length > 0) {
      // Bulk insert under a single global identifier
      const data = photoIds.map(photoId => ({
        eventId: event.id,
        photoId,
        clientSessionId: 'GLOBAL_SESSION',
        clientName: clientName || 'Event Guest',
        clientPhone: 'GLOBAL_PHONE'
      }));

      await this.prisma.favoritePhoto.createMany({
        data
      });
    }

    return { success: true, count: photoIds.length };
  }

  async getClientFavorites(slug: string, clientSessionId: string, clientPhone?: string): Promise<string[]> {
    const event = await this.prisma.event.findUnique({
      where: { slug }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const favorites = await this.prisma.favoritePhoto.findMany({
      where: { eventId: event.id },
      select: { photoId: true }
    });

    return favorites.map(f => f.photoId);
  }

  async getEventFavorites(photographerId: string, eventId: string) {
    // Verify event ownership
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, photographerId }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const favorites = await this.prisma.favoritePhoto.findMany({
      where: { eventId },
      include: {
        photo: true
      },
      orderBy: { createdAt: 'desc' }
    });

    // Group favorites by clientSessionId
    const groupsMap = new Map<string, { clientName: string; clientPhone: string; photos: any[] }>();

    for (const fav of favorites) {
      const key = fav.clientSessionId;
      if (!groupsMap.has(key)) {
        groupsMap.set(key, {
          clientName: fav.clientName || 'Anonymous Guest',
          clientPhone: fav.clientPhone || 'No Phone',
          photos: []
        });
      }

      const group = groupsMap.get(key)!;
      const url = await this.getReadUrl(fav.photo.r2KeyOriginal);
      const thumbUrl = fav.photo.r2KeyThumb
        ? await this.getReadUrl(fav.photo.r2KeyThumb)
        : url;

      group.photos.push({
        id: fav.photo.id,
        filenameOriginal: fav.photo.filenameOriginal,
        url,
        thumbUrl,
        fileSize: Number(fav.photo.fileSize)
      });
    }

    return Array.from(groupsMap.entries()).map(([clientSessionId, val]) => ({
      clientSessionId,
      ...val
    }));
  }

  async getWatermarkedImageStream(slug: string, photoId: string, isThumb: boolean) {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      include: { photographer: true }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId }
    });

    if (!photo || photo.eventId !== event.id) {
      throw new NotFoundException('Photo not found');
    }

    const readKey = isThumb ? (photo.r2KeyThumb || photo.r2KeyOriginal) : photo.r2KeyOriginal;

    const getCommand = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: readKey,
    });

    const s3Response = await this.s3Client.send(getCommand);
    if (!s3Response.Body) {
      throw new Error('S3 response body is empty');
    }

    let imageBuffer: any = Buffer.from(await s3Response.Body.transformToByteArray());

    // Check if photographer plan allows watermark feature
    let hasWatermarkFeature = false;
    if (event.photographer) {
      const activeSub = await this.prisma.subscription.findFirst({
        where: { photographerId: event.photographer.id, status: 'ACTIVE' },
        include: { package: true },
        orderBy: { createdAt: 'desc' }
      });
      hasWatermarkFeature = activeSub?.package ? activeSub.package.featureWatermark : false;
    }

    if (event.watermarkEnabled && hasWatermarkFeature) {
      try {
        imageBuffer = await this.applyWatermark(imageBuffer, event.photographer);
      } catch (err) {
        console.error('[WM] On-the-fly watermarking failed:', err);
      }
    }

    return {
      buffer: imageBuffer,
      contentType: 'image/jpeg',
      filename: photo.filenameOriginal || `photo_${photo.id}.jpg`
    };
  }

  async getWatermarkImageStreamByPhotographerId(photographerId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId }
    });

    if (!photographer || !photographer.watermarkImageKey) {
      // Fallback to default logo
      const fs = require('fs');
      const logoPath = 'c:\\app\\photo\\public\\assets\\images\\logo\\fotosetgo.png';
      if (fs.existsSync(logoPath)) {
        return {
          buffer: fs.readFileSync(logoPath),
          contentType: 'image/png'
        };
      }
      throw new NotFoundException('Watermark not found');
    }

    const getCommand = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: photographer.watermarkImageKey,
    });

    const s3Response = await this.s3Client.send(getCommand);
    if (!s3Response.Body) {
      throw new Error('S3 response body is empty');
    }

    const buffer = Buffer.from(await s3Response.Body.transformToByteArray());
    return {
      buffer,
      contentType: 'image/png'
    };
  }

  async checkSubdomainAvailability(subdomain: string, photographerId?: string) {
    const clean = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
    if (!clean) return { available: false };
    const existing = await this.prisma.photographer.findFirst({
      where: {
        studioSubdomain: clean,
        ...(photographerId ? { NOT: { id: photographerId } } : {})
      }
    });
    return { available: !existing };
  }

  async uploadBrandingLogo(userId: string, file: any) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Limit to 1 MB
    const maxSizeBytes = 1024 * 1024;
    if (file.size > maxSizeBytes) {
      throw new BadRequestException('Logo file size must be less than 1 MB');
    }

    // Key format: <photographerId>/branding/logo.png
    const key = `${photographer.id}/branding/logo.png`;

    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype || 'image/png',
    }));

    await this.prisma.photographer.update({
      where: { id: photographer.id },
      data: { studioLogoKey: key }
    });

    return { success: true, key };
  }

  async uploadBrandingBanner(userId: string, file: any) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Limit to 4 MB for banner cover images
    const maxSizeBytes = 4 * 1024 * 1024;
    if (file.size > maxSizeBytes) {
      throw new BadRequestException('Banner file size must be less than 4 MB');
    }

    const key = `${photographer.id}/branding/banner.png`;


    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype || 'image/png',
    }));

    await this.prisma.photographer.update({
      where: { id: photographer.id },
      data: { studioHeroBannerKey: key }
    });

    return { success: true, key };
  }

  async getBrandingBannerStream(photographerId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId }
    });

    if (!photographer || !photographer.studioHeroBannerKey) {
      throw new NotFoundException('Banner not found');
    }

    const getCommand = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: photographer.studioHeroBannerKey,
    });

    const s3Response = await this.s3Client.send(getCommand);
    if (!s3Response.Body) {
      throw new Error('S3 response body is empty');
    }

    const buffer = Buffer.from(await s3Response.Body.transformToByteArray());
    return {
      buffer,
      contentType: 'image/png'
    };
  }

  async updateBrandingSettings(userId: string, data: any) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    // Check if subdomain is unique
    if (data.studioSubdomain) {
      const subdomainClean = data.studioSubdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
      const existing = await this.prisma.photographer.findFirst({
        where: {
          studioSubdomain: subdomainClean,
          NOT: { id: photographer.id }
        }
      });
      if (existing) {
        throw new BadRequestException('This studio subdomain is already taken');
      }
      data.studioSubdomain = subdomainClean;
    }

    const updatedPhotographer = await this.prisma.photographer.update({
      where: { id: photographer.id },
      data: {
        studioSubdomain: data.studioSubdomain || null,
        primaryColor: data.primaryColor || null,
        secondaryColor: data.secondaryColor || null,
        instagramUrl: data.instagramUrl || null,
        facebookUrl: data.facebookUrl || null,
        whatsappPhone: data.whatsappPhone || null,
        studioFontFamily: data.studioFontFamily || null,
        seoTitle: data.seoTitle || null,
        seoDescription: data.seoDescription || null,
        hidePoweredBy: data.hidePoweredBy ?? false,
        customFooterText: data.customFooterText || null,
      }
    });

    // Automatically sync BusinessCard slug with the new studioSubdomain
    if (data.studioSubdomain) {
      this.prisma.businessCard.updateMany({
        where: { photographerId: photographer.id },
        data: { slug: data.studioSubdomain }
      }).catch(err => console.error('Failed to sync business card slug:', err));
    }

    return updatedPhotographer;
  }

  async getFreshVideoUrl(url: string | null): Promise<string | null> {
    if (!url) return null;
    try {
      const decodedUrl = decodeURIComponent(url);
      const match = decodedUrl.match(/((?:[a-f0-9-]+\/)?portfolio\/reels\/[^?#]+)/);
      if (match) {
        const key = match[1];
        const baseUrl = process.env.PUBLIC_API_URL || 'http://localhost:5000';
        return `${baseUrl}/api/public/portfolio/video/stream?key=${encodeURIComponent(key)}`;
      }
    } catch (err) {
      console.error('[StorageService] Failed to parse video url key:', url, err);
    }
    return url;
  }

  async streamPortfolioVideo(key: string, range?: string) {
    try {
      let targetKey = key;
      const legacyMatch = key.match(/^portfolio\/reels\/([a-f0-9-]+)_(\d+\.[a-z0-9]+)$/i);
      if (legacyMatch) {
        targetKey = `${legacyMatch[1]}/portfolio/reels/${legacyMatch[2]}`;
      }

      const getCommand = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: targetKey,
        Range: range,
      });

      const response = await this.s3Client.send(getCommand);
      return {
        stream: response.Body,
        contentType: response.ContentType || 'video/mp4',
        contentLength: response.ContentLength,
        contentRange: response.ContentRange,
        statusCode: range ? 206 : 200,
      };
    } catch (err) {
      console.error('[StorageService] Error streaming video from R2 for key:', key, err);
      throw new NotFoundException('Video file not found or streaming error');
    }
  }

  async getPortfolioSettings(userId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId },
      include: {
        portfolioPhotos: {
          orderBy: { sortOrder: 'asc' }
        }
      }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    const photos = await Promise.all(
      photographer.portfolioPhotos.map(async (p) => {
        const url = await this.getReadUrl(p.r2KeyOriginal);
        const thumbUrl = await this.getReadUrl(p.r2KeyThumb);
        return {
          id: p.id,
          url,
          thumbUrl,
          category: p.category,
          sortOrder: p.sortOrder
        };
      })
    );

    const aboutImageUrl = photographer.portfolioAboutImageKey
      ? await this.getReadUrl(photographer.portfolioAboutImageKey)
      : null;

    const heroImageUrl = photographer.portfolioHeroImageKey
      ? await this.getReadUrl(photographer.portfolioHeroImageKey)
      : null;

    const freshVideoUrl = await this.getFreshVideoUrl(photographer.portfolioVideoUrl);
    const freshBtsUrl = await this.getFreshVideoUrl(photographer.portfolioBtsUrl);
    const rawReels = photographer.portfolioReels ? (photographer.portfolioReels as any[]) : [];
    const freshReels = await Promise.all(rawReels.map(async (r) => {
      const freshUrl = await this.getFreshVideoUrl(r.url);
      return { ...r, url: freshUrl };
    }));

    return {
      portfolioEnabled: photographer.portfolioEnabled,
      portfolioTheme: photographer.portfolioTheme,
      portfolioHeroTitle: photographer.portfolioHeroTitle,
      portfolioHeroSubtitle: photographer.portfolioHeroSubtitle,
      portfolioAboutTitle: photographer.portfolioAboutTitle,
      portfolioAboutText: photographer.portfolioAboutText,
      portfolioAboutImageUrl: aboutImageUrl,
      portfolioHeroImageUrl: heroImageUrl,
      portfolioMapEmbed: photographer.portfolioMapEmbed,
      portfolioPackages: photographer.portfolioPackages,
      portfolioServices: photographer.portfolioServices,
      portfolioStats: photographer.portfolioStats,
      portfolioFaqs: photographer.portfolioFaqs,
      portfolioVideoUrl: freshVideoUrl,
      portfolioProcess: photographer.portfolioProcess,
      portfolioBtsUrl: freshBtsUrl,
      portfolioEquipment: photographer.portfolioEquipment,
      portfolioDestinations: photographer.portfolioDestinations,
      portfolioBookingPolicy: photographer.portfolioBookingPolicy,
      portfolioPress: photographer.portfolioPress,
      portfolioReels: freshReels,
      portfolioStyles: photographer.portfolioStyles,
      portfolioPhone: photographer.portfolioPhone,
      portfolioEmail: photographer.portfolioEmail,
      portfolioAddress: photographer.portfolioAddress,
      portfolioWhatsapp: photographer.portfolioWhatsapp,
      portfolioPhotos: photos,
      studioSubdomain: photographer.studioSubdomain,
      studioName: photographer.studioName,
      primaryColor: photographer.primaryColor,
      secondaryColor: photographer.secondaryColor,
      instagramUrl: photographer.instagramUrl,
      facebookUrl: photographer.facebookUrl,
      whatsappPhone: photographer.whatsappPhone,
      studioLogoKey: photographer.studioLogoKey,
      studioHeroBannerKey: photographer.studioHeroBannerKey,
      studioFontFamily: photographer.studioFontFamily,
      seoTitle: photographer.seoTitle,
      seoDescription: photographer.seoDescription,
      hidePoweredBy: photographer.hidePoweredBy,
      customFooterText: photographer.customFooterText
    };
  }

  async updatePortfolioSettings(userId: string, data: any) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    try {
      return await this.prisma.photographer.update({
        where: { id: photographer.id },
        data: {
          portfolioEnabled: data.portfolioEnabled ?? photographer.portfolioEnabled,
          portfolioTheme: data.portfolioTheme || photographer.portfolioTheme,
          portfolioHeroTitle: data.portfolioHeroTitle !== undefined ? data.portfolioHeroTitle : photographer.portfolioHeroTitle,
          portfolioHeroSubtitle: data.portfolioHeroSubtitle !== undefined ? data.portfolioHeroSubtitle : photographer.portfolioHeroSubtitle,
          portfolioAboutTitle: data.portfolioAboutTitle !== undefined ? data.portfolioAboutTitle : photographer.portfolioAboutTitle,
          portfolioAboutText: data.portfolioAboutText !== undefined ? data.portfolioAboutText : photographer.portfolioAboutText,
          portfolioMapEmbed: data.portfolioMapEmbed !== undefined ? data.portfolioMapEmbed : photographer.portfolioMapEmbed,
          portfolioPackages: data.portfolioPackages !== undefined ? (data.portfolioPackages as any) : (photographer.portfolioPackages as any),
          portfolioServices: data.portfolioServices !== undefined ? (data.portfolioServices as any) : (photographer.portfolioServices as any),
          portfolioStats: data.portfolioStats !== undefined ? (data.portfolioStats as any) : (photographer.portfolioStats as any),
          portfolioFaqs: data.portfolioFaqs !== undefined ? (data.portfolioFaqs as any) : (photographer.portfolioFaqs as any),
          portfolioVideoUrl: data.portfolioVideoUrl !== undefined ? data.portfolioVideoUrl : photographer.portfolioVideoUrl,
          portfolioProcess: data.portfolioProcess !== undefined ? (data.portfolioProcess as any) : (photographer.portfolioProcess as any),
          portfolioBtsUrl: data.portfolioBtsUrl !== undefined ? data.portfolioBtsUrl : photographer.portfolioBtsUrl,
          portfolioEquipment: data.portfolioEquipment !== undefined ? (data.portfolioEquipment as any) : (photographer.portfolioEquipment as any),
          portfolioDestinations: data.portfolioDestinations !== undefined ? (data.portfolioDestinations as any) : (photographer.portfolioDestinations as any),
          portfolioBookingPolicy: data.bookingPolicy !== undefined ? data.bookingPolicy : (data.portfolioBookingPolicy !== undefined ? data.portfolioBookingPolicy : photographer.portfolioBookingPolicy),
          portfolioPress: data.portfolioPress !== undefined ? (data.portfolioPress as any) : (photographer.portfolioPress as any),
          portfolioReels: data.portfolioReels !== undefined ? (data.portfolioReels as any) : (photographer.portfolioReels as any),
          portfolioStyles: data.portfolioStyles !== undefined ? (data.portfolioStyles as any) : (photographer.portfolioStyles as any),
          portfolioPhone: data.portfolioPhone !== undefined ? data.portfolioPhone : photographer.portfolioPhone,
          portfolioEmail: data.portfolioEmail !== undefined ? data.portfolioEmail : photographer.portfolioEmail,
          portfolioAddress: data.portfolioAddress !== undefined ? data.portfolioAddress : photographer.portfolioAddress,
          portfolioWhatsapp: data.portfolioWhatsapp !== undefined ? data.portfolioWhatsapp : photographer.portfolioWhatsapp,
        }
      });
    } catch (err) {
      console.error('[StorageService] updatePortfolioSettings error:', err);
      throw err;
    }
  }

  // Helper: compute portfolio-only storage used by listing all portfolio/* keys in R2
  private async getPortfolioStorageUsed(photographerId: string): Promise<bigint> {
    let totalBytes = BigInt(0);
    try {
      const prefix = `${photographerId}/portfolio/`;
      let continuationToken: string | undefined;
      do {
        const listCmd = new ListObjectsV2Command({
          Bucket: this.bucketName,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        });
        const response = await this.s3Client.send(listCmd);
        for (const obj of response.Contents || []) {
          totalBytes += BigInt(obj.Size || 0);
        }
        continuationToken = response.IsTruncated ? response.NextContinuationToken : undefined;
      } while (continuationToken);
    } catch (err) {
      console.error('[StorageService] getPortfolioStorageUsed R2 list error:', err);
    }
    return totalBytes;
  }

  async uploadPortfolioAboutImage(userId: string, file: any) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId },
      include: {
        subscriptions: {
          where: { status: 'ACTIVE' },
          orderBy: { startsAt: 'desc' },
          take: 1
        }
      }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Portfolio storage limit check
    const activeSub = photographer.subscriptions[0];
    const portfolioLimitBytes = activeSub
      ? (activeSub.limitPortfolioBytes ?? BigInt(0))
      : BigInt(0);
    if (portfolioLimitBytes > BigInt(0)) {
      const portfolioUsed = await this.getPortfolioStorageUsed(photographer.id);
      if (portfolioUsed + BigInt(file.size) > portfolioLimitBytes) {
        throw new BadRequestException(
          `Portfolio storage limit exceeded (${Math.round(Number(portfolioLimitBytes) / 1024 / 1024)} MB). Please upgrade your plan.`
        );
      }
    }

    const maxSizeBytes = 2 * 1024 * 1024; // 2MB per-file cap
    if (file.size > maxSizeBytes) {
      throw new BadRequestException('About image file size must be less than 2 MB');
    }

    const key = `${photographer.id}/portfolio/about.png`;

    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype || 'image/png',
    }));

    await this.prisma.photographer.update({
      where: { id: photographer.id },
      data: { portfolioAboutImageKey: key }
    });

    const url = await this.getReadUrl(key);
    return { success: true, url, key };
  }

  async uploadPortfolioHeroImage(userId: string, file: any) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId },
      include: {
        subscriptions: {
          where: { status: 'ACTIVE' },
          orderBy: { startsAt: 'desc' },
          take: 1
        }
      }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Portfolio storage limit check
    const activeSub = photographer.subscriptions[0];
    const portfolioLimitBytes = activeSub
      ? (activeSub.limitPortfolioBytes ?? BigInt(0))
      : BigInt(0);
    if (portfolioLimitBytes > BigInt(0)) {
      const portfolioUsed = await this.getPortfolioStorageUsed(photographer.id);
      if (portfolioUsed + BigInt(file.size) > portfolioLimitBytes) {
        throw new BadRequestException(
          `Portfolio storage limit exceeded (${Math.round(Number(portfolioLimitBytes) / 1024 / 1024)} MB). Please upgrade your plan.`
        );
      }
    }

    const maxSizeBytes = 4 * 1024 * 1024; // 4MB per-file cap for hero cover
    if (file.size > maxSizeBytes) {
      throw new BadRequestException('Hero cover file size must be less than 4 MB');
    }

    const key = `${photographer.id}/portfolio/hero.png`;

    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype || 'image/png',
    }));

    await this.prisma.photographer.update({
      where: { id: photographer.id },
      data: { portfolioHeroImageKey: key }
    });

    const url = await this.getReadUrl(key);
    return { success: true, url, key };
  }

  async uploadPortfolioReelVideo(userId: string, file: any) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId },
      include: {
        subscriptions: {
          where: { status: 'ACTIVE' },
          orderBy: { startsAt: 'desc' },
          take: 1
        }
      }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Portfolio storage limit check
    const activeSub = photographer.subscriptions[0];
    const portfolioLimitBytes = activeSub
      ? (activeSub.limitPortfolioBytes ?? BigInt(0))
      : BigInt(0);
    if (portfolioLimitBytes > BigInt(0)) {
      const portfolioUsed = await this.getPortfolioStorageUsed(photographer.id);
      if (portfolioUsed + BigInt(file.size) > portfolioLimitBytes) {
        throw new BadRequestException(
          `Portfolio storage limit exceeded (${Math.round(Number(portfolioLimitBytes) / 1024 / 1024)} MB). Please upgrade your plan.`
        );
      }
    }

    const maxSizeBytes = 500 * 1024 * 1024; // 500MB per-file cap for videos
    if (file.size > maxSizeBytes) {
      throw new BadRequestException('Video file size must be less than 500 MB');
    }

    const ext = file.originalname ? file.originalname.split('.').pop() : 'mp4';
    const timestamp = Date.now();
    const key = `${photographer.id}/portfolio/reels/${timestamp}.${ext}`;

    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype || 'video/mp4',
    }));

    const url = await this.getReadUrl(key);
    return { success: true, url, key };
  }

  async uploadPortfolioPhoto(userId: string, file: any, category?: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId },
      include: {
        subscriptions: {
          where: { status: 'ACTIVE' },
          orderBy: { startsAt: 'desc' },
          take: 1
        }
      }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Portfolio storage limit check
    const activeSub = photographer.subscriptions[0];
    const portfolioLimitBytes = activeSub
      ? (activeSub.limitPortfolioBytes ?? BigInt(0))
      : BigInt(0);
    if (portfolioLimitBytes > BigInt(0)) {
      const portfolioUsed = await this.getPortfolioStorageUsed(photographer.id);
      if (portfolioUsed + BigInt(file.size) > portfolioLimitBytes) {
        throw new BadRequestException(
          `Portfolio storage limit exceeded (${Math.round(Number(portfolioLimitBytes) / 1024 / 1024)} MB). Please upgrade your plan.`
        );
      }
    }

    const maxSizeBytes = 10 * 1024 * 1024; // 10MB per-file cap
    if (file.size > maxSizeBytes) {
      throw new BadRequestException('Showcase photo file size must be less than 10 MB');
    }

    const photoUuid = uuidv4();
    const originalKey = `${photographer.id}/portfolio/showcase/${photoUuid}_original.jpg`;
    const thumbKey = `${photographer.id}/portfolio/showcase/${photoUuid}_thumb.jpg`;


    // 1. Upload original photo
    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: originalKey,
      Body: file.buffer,
      ContentType: file.mimetype || 'image/jpeg',
    }));

    // 2. Generate fast loading preview/thumbnail (800px max width/height)
    let thumbBuffer = file.buffer;
    try {
      thumbBuffer = await sharp(file.buffer)
        .resize({ width: 800, height: 800, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
    } catch (err) {
      console.error('[StorageService] Portfolio photo thumbnail generation failed:', err);
    }

    // 3. Upload thumbnail photo
    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: thumbKey,
      Body: thumbBuffer,
      ContentType: 'image/jpeg',
    }));

    // 4. Update photographer storage consumption
    const totalAddedBytes = BigInt(file.buffer.length + thumbBuffer.length);
    await this.prisma.photographer.update({
      where: { id: photographer.id },
      data: {
        totalStorageUsedBytes: {
          increment: totalAddedBytes
        }
      }
    });

    // 5. Create PortfolioPhoto database record
    const portfolioPhoto = await this.prisma.portfolioPhoto.create({
      data: {
        photographerId: photographer.id,
        r2KeyOriginal: originalKey,
        r2KeyThumb: thumbKey,
        category: category || 'General'
      }
    });

    // 6. Recalculate storage to ensure perfect synchronization
    await this.recalculateStorage(photographer.id);

    const url = await this.getReadUrl(originalKey);
    const thumbUrl = await this.getReadUrl(thumbKey);

    return {
      success: true,
      photo: {
        id: portfolioPhoto.id,
        url,
        thumbUrl,
        sortOrder: portfolioPhoto.sortOrder
      }
    };

  }

  async deletePortfolioPhoto(userId: string, photoId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    const photo = await this.prisma.portfolioPhoto.findUnique({
      where: { id: photoId }
    });

    if (!photo || photo.photographerId !== photographer.id) {
      throw new NotFoundException('Portfolio photo not found or ownership mismatch');
    }

    // 1. Delete original from R2
    try {
      await this.s3Client.send(new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: photo.r2KeyOriginal
      }));
    } catch (err) {
      console.error('[StorageService] Failed to delete original portfolio photo from R2:', err);
    }

    // 2. Delete thumbnail from R2
    try {
      await this.s3Client.send(new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: photo.r2KeyThumb
      }));
    } catch (err) {
      console.error('[StorageService] Failed to delete thumbnail portfolio photo from R2:', err);
    }

    // 3. Delete DB record
    await this.prisma.portfolioPhoto.delete({
      where: { id: photoId }
    });

    // 4. Recalculate storage
    await this.recalculateStorage(photographer.id);

    return { success: true };
  }

  async deletePortfolioCategory(userId: string, category: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId },
      include: { portfolioPhotos: true }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    const photosToDelete = photographer.portfolioPhotos.filter(
      (p) => p.category.toLowerCase() === category.toLowerCase()
    );

    for (const photo of photosToDelete) {
      try {
        await this.s3Client.send(new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: photo.r2KeyOriginal
        }));
      } catch (err) {
        console.error('[StorageService] Failed to delete category original:', err);
      }

      try {
        await this.s3Client.send(new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: photo.r2KeyThumb
        }));
      } catch (err) {
        console.error('[StorageService] Failed to delete category thumb:', err);
      }

      await this.prisma.portfolioPhoto.delete({
        where: { id: photo.id }
      });
    }

    // Recalculate storage after all photos in the category are deleted
    await this.recalculateStorage(photographer.id);


    return { success: true, count: photosToDelete.length };
  }

  async clearPortfolioData(userId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId },
      include: { portfolioPhotos: true }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    // 1. Delete all Showcase Photos from R2 and DB
    for (const photo of photographer.portfolioPhotos) {
      try {
        await this.s3Client.send(new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: photo.r2KeyOriginal
        }));
      } catch (err) {
        console.error('[StorageService] Clear: Failed to delete R2 photo original:', err);
      }
      try {
        await this.s3Client.send(new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: photo.r2KeyThumb
        }));
      } catch (err) {
        console.error('[StorageService] Clear: Failed to delete R2 photo thumb:', err);
      }
      await this.prisma.portfolioPhoto.delete({ where: { id: photo.id } });
    }

    // 2. Delete Hero / About Image from R2 if custom keys exist
    const deleteIfKeyExists = async (key: string | null) => {
      if (!key) return;
      try {
        await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: key }));
      } catch { }
    };

    await deleteIfKeyExists(photographer.portfolioAboutImageKey);
    await deleteIfKeyExists(photographer.portfolioHeroImageKey);

    // Also delete any direct video keys
    if (photographer.portfolioVideoUrl) {
      await deleteIfKeyExists(photographer.portfolioVideoUrl);
    }
    if (photographer.portfolioBtsUrl) {
      await deleteIfKeyExists(photographer.portfolioBtsUrl);
    }

    // Clean reels keys
    if (photographer.portfolioReels && Array.isArray(photographer.portfolioReels)) {
      for (const r of photographer.portfolioReels as any[]) {
        if (r && r.r2Key) {
          await deleteIfKeyExists(r.r2Key);
        }
      }
    }


    // 3. Reset photographer settings fields
    await this.prisma.photographer.update({
      where: { id: photographer.id },
      data: {
        portfolioAboutImageKey: null,
        portfolioHeroImageKey: null,
        portfolioVideoUrl: null,
        portfolioBtsUrl: null,
        portfolioReels: []
      }
    });

    // Recalculate storage
    await this.recalculateStorage(photographer.id);

    return { success: true };
  }



  async getPublicPortfolioBySubdomain(subdomain: string) {
    const cleanSubdomain = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const photographer = await this.prisma.photographer.findUnique({
      where: { studioSubdomain: cleanSubdomain },
      include: {
        portfolioPhotos: {
          orderBy: { sortOrder: 'asc' }
        }
      }
    });

    if (!photographer || !photographer.portfolioEnabled) {
      return null;
    }

    const photos = await Promise.all(
      photographer.portfolioPhotos.map(async (p) => {
        const url = await this.getReadUrl(p.r2KeyOriginal);
        const thumbUrl = await this.getReadUrl(p.r2KeyThumb);
        return {
          id: p.id,
          url,
          thumbUrl,
          category: p.category,
          sortOrder: p.sortOrder
        };
      })
    );

    const aboutImageUrl = photographer.portfolioAboutImageKey
      ? await this.getReadUrl(photographer.portfolioAboutImageKey)
      : null;

    const heroImageUrl = photographer.portfolioHeroImageKey
      ? await this.getReadUrl(photographer.portfolioHeroImageKey)
      : null;

    const freshVideoUrl = await this.getFreshVideoUrl(photographer.portfolioVideoUrl);
    const freshBtsUrl = await this.getFreshVideoUrl(photographer.portfolioBtsUrl);
    const rawReels = photographer.portfolioReels ? (photographer.portfolioReels as any[]) : [];
    const freshReels = await Promise.all(rawReels.map(async (r) => {
      const freshUrl = await this.getFreshVideoUrl(r.url);
      return { ...r, url: freshUrl };
    }));

    return {
      portfolioEnabled: photographer.portfolioEnabled,
      portfolioTheme: photographer.portfolioTheme,
      portfolioHeroTitle: photographer.portfolioHeroTitle,
      portfolioHeroSubtitle: photographer.portfolioHeroSubtitle,
      portfolioAboutTitle: photographer.portfolioAboutTitle,
      portfolioAboutText: photographer.portfolioAboutText,
      portfolioAboutImageUrl: aboutImageUrl,
      portfolioHeroImageUrl: heroImageUrl,
      portfolioMapEmbed: photographer.portfolioMapEmbed,
      portfolioPackages: photographer.portfolioPackages,
      portfolioServices: photographer.portfolioServices,
      portfolioTestimonials: photographer.portfolioTestimonials,
      portfolioStats: photographer.portfolioStats,
      portfolioFaqs: photographer.portfolioFaqs,
      portfolioVideoUrl: freshVideoUrl,
      portfolioProcess: photographer.portfolioProcess,
      portfolioBtsUrl: freshBtsUrl,
      portfolioEquipment: photographer.portfolioEquipment,
      portfolioDestinations: photographer.portfolioDestinations,
      portfolioBookingPolicy: photographer.portfolioBookingPolicy,
      portfolioPress: photographer.portfolioPress,
      portfolioReels: freshReels,
      portfolioStyles: photographer.portfolioStyles,
      portfolioPhone: photographer.portfolioPhone,
      portfolioEmail: photographer.portfolioEmail,
      portfolioAddress: photographer.portfolioAddress,
      portfolioWhatsapp: photographer.portfolioWhatsapp,
      portfolioPhotos: photos,
      studioName: photographer.studioName,
      primaryColor: photographer.primaryColor,
      secondaryColor: photographer.secondaryColor,
      instagramUrl: photographer.instagramUrl,
      facebookUrl: photographer.facebookUrl,
      whatsappPhone: photographer.whatsappPhone,
      studioLogoKey: photographer.studioLogoKey,
      studioHeroBannerKey: photographer.studioHeroBannerKey,
      studioFontFamily: photographer.studioFontFamily,
      seoTitle: photographer.seoTitle,
      seoDescription: photographer.seoDescription,
      hidePoweredBy: photographer.hidePoweredBy,
      customFooterText: photographer.customFooterText,
      photographerId: photographer.id
    };
  }

  async createPortfolioInquiry(subdomain: string, data: {
    clientName: string;
    clientEmail: string;
    clientPhone: string;
    eventDate?: string;
    message: string;
  }) {
    const cleanSubdomain = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const photographer = await this.prisma.photographer.findUnique({
      where: { studioSubdomain: cleanSubdomain }
    });

    if (!photographer) {
      throw new NotFoundException('Studio portfolio not found');
    }

    return this.prisma.portfolioInquiry.create({
      data: {
        photographerId: photographer.id,
        clientName: data.clientName,
        clientEmail: data.clientEmail,
        clientPhone: data.clientPhone,
        eventDate: data.eventDate || '',
        message: data.message
      }
    });
  }

  async getPortfolioInquiries(userId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    return this.prisma.portfolioInquiry.findMany({
      where: { photographerId: photographer.id },
      orderBy: { createdAt: 'desc' }
    });
  }

  async deletePortfolioInquiry(userId: string, inquiryId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    const inquiry = await this.prisma.portfolioInquiry.findUnique({
      where: { id: inquiryId }
    });

    if (!inquiry || inquiry.photographerId !== photographer.id) {
      throw new NotFoundException('Inquiry not found or ownership mismatch');
    }

    await this.prisma.portfolioInquiry.delete({
      where: { id: inquiryId }
    });

    return { success: true };
  }

  async getActivePortfolioThemes() {
    return this.prisma.portfolioTheme.findMany({
      where: { isActive: true },
      orderBy: { sortOrder: 'asc' }
    });
  }

  async getAllPortfolioThemes() {
    return this.prisma.portfolioTheme.findMany({
      orderBy: { sortOrder: 'asc' }
    });
  }

  async togglePortfolioThemeStatus(id: string, isActive: boolean) {
    const theme = await this.prisma.portfolioTheme.findUnique({
      where: { id }
    });

    if (!theme) {
      throw new NotFoundException('Portfolio theme not found');
    }

    return this.prisma.portfolioTheme.update({
      where: { id },
      data: { isActive }
    });
  }




  async getBrandingLogoStream(photographerId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId }
    });

    if (!photographer || !photographer.studioLogoKey) {
      // Fallback to default logo
      const fs = require('fs');
      const logoPath = 'c:\\app\\photo\\public\\assets\\images\\logo\\fotosetgo.png';
      if (fs.existsSync(logoPath)) {
        return {
          buffer: fs.readFileSync(logoPath),
          contentType: 'image/png'
        };
      }
      throw new NotFoundException('Logo not found');
    }

    const getCommand = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: photographer.studioLogoKey,
    });

    const s3Response = await this.s3Client.send(getCommand);
    if (!s3Response.Body) {
      throw new Error('S3 response body is empty');
    }

    const buffer = Buffer.from(await s3Response.Body.transformToByteArray());
    return {
      buffer,
      contentType: 'image/png'
    };
  }

  async updateWatermarkSettings(userId: string, data: any) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    return this.prisma.photographer.update({
      where: { id: photographer.id },
      data: {
        watermarkType: data.watermarkType,
        watermarkText: data.watermarkText || null,
        watermarkPosition: data.watermarkPosition || 'CENTER',
        watermarkOpacity: data.watermarkOpacity ? Number(data.watermarkOpacity) : 50,
        watermarkSize: data.watermarkSize || 'MEDIUM'
      }
    });
  }

  async uploadWatermarkImage(userId: string, file: any) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    if (!file) {
      throw new BadRequestException('No file provided');
    }

    // Limit to 500 KB
    const maxSizeBytes = 500 * 1024;
    if (file.size > maxSizeBytes) {
      throw new BadRequestException('Watermark file size must be less than 500 KB');
    }

    // Key format: <photographerId>/branding/watermark.png
    const key = `${photographer.id}/branding/watermark.png`;


    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      Body: file.buffer,
      ContentType: file.mimetype || 'image/png',
    }));

    // Update database
    await this.prisma.photographer.update({
      where: { id: photographer.id },
      data: {
        watermarkImageKey: key,
        watermarkType: 'IMAGE' // auto switch to image watermark type on upload
      }
    });

    return { success: true, key };
  }

  private async applyWatermark(imageBuffer: Buffer, photographer: any): Promise<Buffer> {
    let hasCustomBranding = false;
    if (photographer) {
      const activeSub = await this.prisma.subscription.findFirst({
        where: { photographerId: photographer.id, status: 'ACTIVE' },
        include: { package: true },
        orderBy: { createdAt: 'desc' }
      });
      hasCustomBranding = activeSub?.package ? activeSub.package.featureCustomBranding : false;
    }

    const watermarkType = hasCustomBranding ? (photographer ? photographer.watermarkType : 'NONE') : 'IMAGE';
    const sizeSetting = hasCustomBranding ? (photographer ? photographer.watermarkSize : 'MEDIUM') : 'LARGE';
    const position = hasCustomBranding ? (photographer ? photographer.watermarkPosition : 'CENTER') : 'CENTER';
    const opacity = hasCustomBranding ? (photographer ? photographer.watermarkOpacity : 50) : 50;

    console.log('[WM] applyWatermark called:', { watermarkType, sizeSetting, position, opacity, hasImageKey: !!photographer?.watermarkImageKey, hasCustomBranding });

    if (watermarkType === 'NONE' || !watermarkType) {
      console.log('[WM] watermarkType is NONE, returning original');
      return imageBuffer;
    }

    let sizePercent = 0.30;
    if (sizeSetting === 'SMALL') sizePercent = 0.12;
    if (sizeSetting === 'LARGE') sizePercent = 0.45;

    const metadata = await sharp(imageBuffer).metadata();
    const imgWidth = metadata.width || 1200;
    const imgHeight = metadata.height || 800;

    // Helper: clamp composites so they never go outside image bounds
    const clampLeft = (l: number, ww: number) => Math.max(0, Math.min(imgWidth - ww - 1, l));
    const clampTop = (t: number, wh: number) => Math.max(0, Math.min(imgHeight - wh - 1, t));

    // Compute left/top from gravity for CENTER and BOTTOM_RIGHT
    const placeWatermark = (ww: number, wh: number): { left: number; top: number } => {
      if (position === 'BOTTOM_RIGHT') {
        return {
          left: clampLeft(imgWidth - ww - Math.round(imgWidth * 0.03), ww),
          top: clampTop(imgHeight - wh - Math.round(imgHeight * 0.03), wh),
        };
      }
      // CENTER default
      return {
        left: clampLeft(Math.round((imgWidth - ww) / 2), ww),
        top: clampTop(Math.round((imgHeight - wh) / 2), wh),
      };
    };

    if (watermarkType === 'TEXT') {
      const text = photographer.watermarkText || 'PhotosetGo';
      const tileReducer = position === 'TILE' ? 0.5 : 1.0;
      const fontSize = Math.max(16, Math.round(imgWidth * sizePercent * 0.15 * tileReducer));
      const svgPad = Math.round(fontSize * 0.5);
      const svgWidth = Math.round(text.length * fontSize * 0.62) + svgPad * 2;
      const svgHeight = Math.round(fontSize * 1.8);
      const textOpacity = opacity / 100;

      const makeSvg = (w: number, h: number) => Buffer.from(`
        <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
          <style>
            .t { fill: rgba(255,255,255,${textOpacity}); font-size: ${fontSize}px; font-family: Arial,sans-serif; font-weight: bold; letter-spacing: 1px; }
            .s { fill: rgba(0,0,0,${textOpacity * 0.4}); font-size: ${fontSize}px; font-family: Arial,sans-serif; font-weight: bold; letter-spacing: 1px; }
          </style>
          <text x="${w / 2 + 1}" y="${h * 0.72}" text-anchor="middle" class="s">${text}</text>
          <text x="${w / 2}" y="${h * 0.70}" text-anchor="middle" class="t">${text}</text>
        </svg>
      `);

      const svgBuf = makeSvg(svgWidth, svgHeight);
      let composites: any[] = [];

      if (position === 'TILE') {
        const cols = 3, rows = 3;
        for (let r = 0; r < rows; r++) {
          for (let c = 0; c < cols; c++) {
            composites.push({
              input: svgBuf,
              left: clampLeft(Math.round((imgWidth / cols) * (c + 0.5) - svgWidth / 2), svgWidth),
              top: clampTop(Math.round((imgHeight / rows) * (r + 0.5) - svgHeight / 2), svgHeight),
            });
          }
        }
      } else {
        const pos = placeWatermark(svgWidth, svgHeight);
        composites.push({ input: svgBuf, ...pos });
      }

      return sharp(imageBuffer)
        .composite(composites)
        .extract({ left: 0, top: 0, width: imgWidth, height: imgHeight })
        .toBuffer();
    }

    if (watermarkType === 'IMAGE') {
      try {
        let watermarkRaw: Buffer | null = null;

        if (photographer.watermarkImageKey && hasCustomBranding) {
          const getCommand = new GetObjectCommand({
            Bucket: this.bucketName,
            Key: photographer.watermarkImageKey,
          });
          const s3Response = await this.s3Client.send(getCommand);
          if (s3Response.Body) {
            watermarkRaw = Buffer.from(await s3Response.Body.transformToByteArray());
          }
        } else {
          const fs = require('fs');
          const logoPath = 'c:\\app\\photo\\public\\assets\\images\\logo\\fotosetgo.png';
          if (fs.existsSync(logoPath)) {
            watermarkRaw = fs.readFileSync(logoPath);
          }
        }

        if (!watermarkRaw) return imageBuffer;

        const tileReducer = position === 'TILE' ? 0.35 : 1.0;
        const wWidth = Math.max(30, Math.round(imgWidth * sizePercent * tileReducer));
        const alphaFraction = Math.min(1, Math.max(0, opacity / 100));

        // Resize first
        const resizedPipeline = sharp(watermarkRaw)
          .resize({ width: wWidth, fit: 'inside' })
          .ensureAlpha();

        const resizedBuf = await resizedPipeline.toBuffer();
        const resizedMeta = await sharp(resizedBuf).metadata();
        const rW = resizedMeta.width || wWidth;
        const rH = resizedMeta.height || Math.round(wWidth * 0.4);

        // Get raw pixel data and manually scale alpha channel
        const { data, info } = await sharp(resizedBuf)
          .raw()
          .toBuffer({ resolveWithObject: true });

        const pixelData = new Uint8Array(data.buffer);
        for (let i = 3; i < pixelData.length; i += 4) {
          pixelData[i] = Math.round(pixelData[i] * alphaFraction);
        }

        const resized = await sharp(Buffer.from(pixelData.buffer), {
          raw: { width: rW, height: rH, channels: 4 }
        }).png().toBuffer();

        const wMeta = await sharp(resized).metadata();
        const wW = wMeta.width || wWidth;
        const wH = wMeta.height || Math.round(wWidth * 0.4);

        let composites: any[] = [];

        if (position === 'TILE') {
          const cols = 3, rows = 3;
          for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
              composites.push({
                input: resized,
                left: clampLeft(Math.round((imgWidth / cols) * (c + 0.5) - wW / 2), wW),
                top: clampTop(Math.round((imgHeight / rows) * (r + 0.5) - wH / 2), wH),
              });
            }
          }
        } else {
          const pos = placeWatermark(wW, wH);
          composites.push({ input: resized, ...pos });
        }

        return sharp(imageBuffer)
          .composite(composites)
          .extract({ left: 0, top: 0, width: imgWidth, height: imgHeight })
          .toBuffer();
      } catch (err) {
        console.error('[StorageService] Image watermark error:', err);
      }
    }

    return imageBuffer;
  }

  // ─── Portfolio Reviews ─────────────────────────────────────────────────────

  async createPortfolioReview(subdomain: string, data: {
    clientName: string;
    clientRole?: string;
    rating: number;
    comment: string;
  }) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { studioSubdomain: subdomain }
    });
    if (!photographer) throw new NotFoundException('Portfolio not found');
    if (data.rating < 1 || data.rating > 5) throw new Error('Rating must be between 1 and 5');

    return this.prisma.portfolioReview.create({
      data: {
        photographerId: photographer.id,
        clientName: data.clientName,
        clientRole: data.clientRole,
        rating: data.rating,
        comment: data.comment,
        isApproved: false,
      }
    });
  }

  async getPortfolioReviews(userId: string) {
    const photographer = await this.prisma.photographer.findUnique({ where: { userId } });
    if (!photographer) throw new NotFoundException('Photographer not found');
    return this.prisma.portfolioReview.findMany({
      where: { photographerId: photographer.id },
      orderBy: { createdAt: 'desc' }
    });
  }

  async approvePortfolioReview(userId: string, reviewId: string, approve: boolean) {
    const photographer = await this.prisma.photographer.findUnique({ where: { userId } });
    if (!photographer) throw new NotFoundException('Photographer not found');
    const review = await this.prisma.portfolioReview.findUnique({ where: { id: reviewId } });
    if (!review || review.photographerId !== photographer.id) {
      throw new NotFoundException('Review not found or ownership mismatch');
    }
    return this.prisma.portfolioReview.update({
      where: { id: reviewId },
      data: { isApproved: approve }
    });
  }

  async deletePortfolioReview(userId: string, reviewId: string) {
    const photographer = await this.prisma.photographer.findUnique({ where: { userId } });
    if (!photographer) throw new NotFoundException('Photographer not found');
    const review = await this.prisma.portfolioReview.findUnique({ where: { id: reviewId } });
    if (!review || review.photographerId !== photographer.id) {
      throw new NotFoundException('Review not found or ownership mismatch');
    }
    await this.prisma.portfolioReview.delete({ where: { id: reviewId } });
    return { success: true };
  }

  async getPublicApprovedReviews(subdomain: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { studioSubdomain: subdomain }
    });
    if (!photographer) throw new NotFoundException('Portfolio not found');
    return this.prisma.portfolioReview.findMany({
      where: { photographerId: photographer.id, isApproved: true },
      orderBy: { createdAt: 'desc' },
      select: { id: true, clientName: true, clientRole: true, rating: true, comment: true, createdAt: true }
    });
  }

  // Auto-backup a single photo to Google Drive after it becomes READY
  private async triggerAutoBackupIfEnabled(photographerId: string, photoId: string): Promise<void> {
    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
      select: { autoBackupToDrive: true, googleDriveConnected: true, googleDriveAccessToken: true },
    });

    if (!photographer?.autoBackupToDrive || !photographer?.googleDriveConnected || !photographer?.googleDriveAccessToken) {
      return; // Auto backup not enabled or Drive not connected
    }

    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      include: { event: { select: { title: true } } },
    });

    if (!photo || photo.backedUpToDrive) return; // Already backed up or not found

    const { hasSpace } = await this.googleDriveService.checkDriveHasSpace(photographerId);
    if (!hasSpace) {
      console.warn(`[AutoBackup] Drive full for photographer ${photographerId}. Disabling auto backup.`);
      await this.prisma.photographer.update({
        where: { id: photographerId },
        data: { autoBackupToDrive: false, driveBackupFullNotified: true },
      });
      return;
    }

    const eventName = photo.event?.title || 'Uncategorized';
    const driveFileId = await this.googleDriveService.backupSinglePhoto(
      photographerId,
      photo,
      eventName,
      this.s3Client,
      this.bucketName,
    );

    if (driveFileId) {
      await this.prisma.photo.update({
        where: { id: photoId },
        data: { backedUpToDrive: true, driveFileId },
      });
      console.log(`[AutoBackup] ✅ Photo ${photo.filenameOriginal} backed up to Drive.`);
    }
  }

  async uploadGuestPhotoDirect(slug: string, file: any) {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      include: {
        photographer: {
          include: {
            subscriptions: {
              where: { status: 'ACTIVE' },
              orderBy: { startsAt: 'desc' },
              take: 1
            }
          }
        }
      }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (!event.allowGuestUploads) {
      throw new BadRequestException('Guest uploads are not enabled for this event');
    }

    // 1. Verify Photographer level storage limit
    const photographer = event.photographer;
    const activeSubscription = photographer.subscriptions[0];
    const limitBytes = activeSubscription?.limitEventsBytes ?? activeSubscription?.limitBytes ?? BigInt(5000 * 1024 * 1024);
    const totalStorageUsedBytes = photographer.totalStorageUsedBytes || BigInt(0);

    if (totalStorageUsedBytes + BigInt(file.size) > limitBytes) {
      throw new BadRequestException('Photographer storage space is full. Cannot accept uploads.');
    }

    // 2. Verify Event Guest Upload Limits
    const guestPhotosStats = await this.prisma.photo.aggregate({
      where: { eventId: event.id, isGuestUpload: true },
      _count: { id: true },
      _sum: { fileSize: true }
    });

    const currentGuestCount = guestPhotosStats._count.id || 0;
    const currentGuestSize = guestPhotosStats._sum.fileSize ? BigInt(guestPhotosStats._sum.fileSize.toString()) : BigInt(0);

    if (currentGuestCount >= event.maxGuestUploadFiles) {
      throw new BadRequestException(`Guest upload file limit reached (${event.maxGuestUploadFiles} files max).`);
    }

    if (currentGuestSize + BigInt(file.size) > event.maxGuestUploadStorage) {
      const maxMB = Math.round(Number(event.maxGuestUploadStorage) / 1024 / 1024);
      throw new BadRequestException(`Guest upload storage size limit reached (${maxMB} MB max).`);
    }

    const isVideo = file.mimetype.startsWith('video/') || file.originalname.match(/\.(mp4|mkv|mov|webm)$/i);
    const fileUuid = uuidv4();
    const cleanFilename = file.originalname.replace(/[^a-zA-Z0-9.-]/g, '_');

    // Set R2 Path
    const objectKey = isVideo
      ? `${photographer.id}/events/${event.id}/videos/${fileUuid}_${cleanFilename}`
      : `${photographer.id}/events/${event.id}/photos/${fileUuid}_${cleanFilename}`;

    // Upload directly to Cloudflare R2 from server side
    await this.s3Client.send(new PutObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      Body: file.buffer,
      ContentType: file.mimetype
    }));

    // Create Photo entry in DB
    const photo = await this.prisma.photo.create({
      data: {
        eventId: event.id,
        photographerId: photographer.id,
        filenameOriginal: file.originalname,
        filenameStored: `${fileUuid}_${cleanFilename}`,
        r2KeyOriginal: objectKey,
        mimeType: file.mimetype,
        fileSize: BigInt(file.size),
        status: 'PENDING_APPROVAL',
        type: isVideo ? 'VIDEO' : 'IMAGE',
        isGuestUpload: true
      },
    });

    // Update photographer storage usage allocation
    await this.prisma.photographer.update({
      where: { id: photographer.id },
      data: {
        totalStorageUsedBytes: {
          increment: BigInt(file.size)
        }
      }
    });

    if (activeSubscription) {
      await this.prisma.subscription.update({
        where: { id: activeSubscription.id },
        data: {
          usedBytes: {
            increment: BigInt(file.size)
          }
        }
      });
    }

    return photo;
  }

  async completeThumbnailWebhook(data: { photoId: string; thumbKey: string; previewKey?: string; secretKey: string }) {
    // Validate secret key to match environmental setup
    const secret = process.env.WORKER_SECRET_KEY || 'default-worker-secret-key-123';
    if (data.secretKey !== secret) {
      throw new Error('Unauthorized webhook signature mismatch');
    }

    const photo = await this.prisma.photo.findUnique({
      where: { id: data.photoId },
      include: { event: true }
    });

    if (!photo) {
      throw new Error('Photo not found');
    }

    // Update photo with thumbnail keys + set thumbnailStatus to READY
    await this.prisma.photo.update({
      where: { id: data.photoId },
      data: {
        r2KeyThumb: data.thumbKey,
        r2KeyPreview: data.previewKey || null,
        thumbnailStatus: 'READY'
      }
    });

    // If face scanning is enabled, trigger background batch face indexing
    if (photo.event.faceScanningEnabled) {
      this.triggerFaceScanForEvent(
        photo.photographerId,
        photo.eventId
      ).catch(err => {
        console.error('[Webhook] Background Face Indexing trigger failed:', err);
      });
    } else {
      // Mark overall photo status as READY if AI is disabled
      await this.prisma.photo.update({
        where: { id: data.photoId },
        data: {
          status: 'READY'
        }
      });

      // Update upload batch progress status
      if (photo.uploadBatchId) {
        await this.updateBatchProgress(photo.uploadBatchId, true);
      }
    }

    return { success: true };
  }

  async triggerCloudflareWorker(photoId: string, r2KeyOriginal: string): Promise<void> {
    const modalUrl = (process.env.FACE_ENGINE_URL || 'https://sahilshah778800--face-engine-fastapi-app.modal.run') + '/generate-thumbnail';
    let selectedUrl = process.env.USE_MODAL_THUMBNAILS !== 'false' ? modalUrl : (process.env.THUMBNAIL_WORKER_URL || modalUrl);

    if (!selectedUrl.endsWith('/generate-thumbnail') && !selectedUrl.endsWith('/generate-batch-thumbnails')) {
      selectedUrl = `${selectedUrl.replace(/\/$/, '')}/generate-thumbnail`;
    }

    this.logger.log(`[Worker Trigger] Dispatching item ${photoId} to Modal Thumbnail Engine: ${selectedUrl}`);

    try {
      const res = await fetch(selectedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          objectKey: r2KeyOriginal,
          photoId: photoId
        })
      });

      this.logger.log(`[Worker Trigger] Response status from ${selectedUrl} for photo ${photoId}: ${res.status}`);
      if (res.ok) {
        const data: any = await res.json();
        const result = data?.results?.[0];
        if (result && result.success && result.thumbKey) {
          this.logger.log(`[Worker Trigger] Updating DB thumbnailStatus to READY for photo: ${photoId}`);
          await this.completeThumbnailWebhook({
            photoId: photoId,
            thumbKey: result.thumbKey,
            secretKey: process.env.WORKER_SECRET_KEY || 'default-worker-secret-key-123'
          }).catch(err => this.logger.error(`[Worker Trigger] Local DB update error for ${photoId}: ${err.message}`));
        } else {
          this.logger.error(`[Worker Trigger] Worker returned error for ${photoId}: ${result?.error}`);
        }
      }
    } catch (err: any) {
      this.logger.error(`[Worker Trigger] Failed for photo ${photoId} via ${selectedUrl}: ${err.message}`);
    }
  }

  async processBatchThumbnailsViaGoWorker(photos: { id: string; r2KeyOriginal: string }[]): Promise<void> {
    if (!photos || photos.length === 0) return;

    const modalUrl = (process.env.FACE_ENGINE_URL || 'https://sahilshah778800--face-engine-fastapi-app.modal.run') + '/generate-thumbnail';
    let selectedUrl = process.env.USE_MODAL_THUMBNAILS !== 'false' ? modalUrl : (process.env.THUMBNAIL_WORKER_URL || modalUrl);

    if (!selectedUrl.endsWith('/generate-thumbnail') && !selectedUrl.endsWith('/generate-batch-thumbnails')) {
      selectedUrl = `${selectedUrl.replace(/\/$/, '')}/generate-thumbnail`;
    }

    const chunkSize = 20;
    for (let i = 0; i < photos.length; i += chunkSize) {
      const chunk = photos.slice(i, i + chunkSize);
      const payload = {
        items: chunk.map(p => ({ photoId: p.id, objectKey: p.r2KeyOriginal }))
      };

      try {
        const res = await fetch(selectedUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });

        if (res.ok) {
          const data: any = await res.json();
          if (data && data.results) {
            const readyItems = data.results.filter((r: any) => r.success);
            for (const item of readyItems) {
              await this.prisma.photo.update({
                where: { id: item.photoId },
                data: {
                  r2KeyThumb: item.thumbKey,
                  r2KeyPreview: item.thumbKey,
                  thumbnailStatus: 'READY'
                }
              }).catch(() => { });
            }
          }
        }
      } catch (err) {
        this.logger.error(`[GoWorkerBatch] Error processing batch via ${selectedUrl}: ${err.message}`);
      }
    }
  }

  // AI Face Toggle ON hone par ya Thumbnail complete hone par Batch Scan chalata hai (with Auto-Recheck loop)
  async triggerFaceScanForEvent(photographerId: string, eventId: string): Promise<void> {
    // Duplicate overlapping scan loops se bachane ke liye Lock check karo
    if (this.activeEventScans.has(eventId)) {
      this.logger.log(`[BatchFaceScan] Event ${eventId} scan loop is already running. New ready items will be auto-picked up.`);
      return;
    }

    this.activeEventScans.add(eventId);

    try {
      while (true) {
        // Check if there are active uploads in progress for this event
        const activeUploadingCount = await this.prisma.photo.count({
          where: { eventId, status: 'UPLOADING' }
        });

        // Fetch ready thumbnails that haven't been face scanned yet (batch of up to 150 photos)
        const pendingItems = await this.prisma.photo.findMany({
          where: {
            eventId,
            photographerId,
            faceScanStatus: { notIn: ['PROCESSING'] },
            OR: [
              { thumbnailStatus: 'READY' },
              { r2KeyThumb: { not: null } }
            ],
            embeddings: { none: {} }
          },
          take: 150
        });

        if (pendingItems.length === 0) {
          this.logger.log(`[BatchFaceScan] All ready items for event ${eventId} are scanned. Loop finished.`);
          break;
        }

        // Rule: If uploading is currently active and we have less than 150 ready items, defer scanning until 150 accumulate or uploading finishes
        if (activeUploadingCount > 0 && pendingItems.length < 150) {
          this.logger.log(`[BatchFaceScan] Uploading in progress (${activeUploadingCount} uploading). Waiting for 150 items or upload finish. Current ready: ${pendingItems.length}`);
          break;
        }

        this.logger.log(`[BatchFaceScan] Found ${pendingItems.length} items to batch scan for event ${eventId}`);

        const photos = pendingItems.filter(p => p.type === 'IMAGE');
        const videos = pendingItems.filter(p => p.type === 'VIDEO');

        // Mark items as PROCESSING
        const itemIds = pendingItems.map(p => p.id);
        await this.prisma.photo.updateMany({
          where: { id: { in: itemIds } },
          data: { faceScanStatus: 'PROCESSING' }
        });

        // 1. Process Batch of Photos in 1 SINGLE HTTP Request to Modal GPU (/faces/index-batch-photos)
        if (photos.length > 0) {
          try {
            const faceEngineUrl = process.env.FACE_ENGINE_URL || 'http://127.0.0.1:8000';
            const photoBatchPayload: { photoId: string; imageUrl: string }[] = [];

            for (const photo of photos) {
              const readKey = photo.r2KeyOriginal;
              const signedUrl = await this.getReadUrl(readKey);
              if (signedUrl) {
                photoBatchPayload.push({ photoId: photo.id, imageUrl: signedUrl });
              }
            }

            if (photoBatchPayload.length > 0) {
              const response = await fetch(`${faceEngineUrl}/faces/index-batch-photos`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-api-key': process.env.MODAL_API_KEY || 'default-secret-key-123'
                },
                body: JSON.stringify({ items: photoBatchPayload })
              });

              if (response.ok) {
                const batchResult = await response.json();
                const results = batchResult.results || [];

                for (const res of results) {
                  const photoId = res.photoId;
                  const faces = res.faces || [];
                  const hasFaces = faces.length > 0;
                  const faceCount = faces.length;

                  if (hasFaces) {
                    const faceData = faces.map((f: any) => ({
                      photoId,
                      eventId,
                      photographerId,
                      faceIndex: f.faceIndex,
                      bboxX: f.bbox.x,
                      bboxY: f.bbox.y,
                      bboxW: f.bbox.w,
                      bboxH: f.bbox.h,
                      confidence: f.confidence,
                      embedding: f.embedding,
                    }));

                    const values = faceData.map((f: any) => {
                      const vectorStr = `[${f.embedding.join(',')}]`;
                      return `('${uuidv4()}', '${f.photoId}', '${f.eventId}', '${f.photographerId}', ${f.faceIndex}, ${f.bboxX}, ${f.bboxY}, ${f.bboxW}, ${f.bboxH}, ${f.confidence}, '${vectorStr}'::vector, NULL)`;
                    }).join(',');

                    await this.prisma.$executeRawUnsafe(`
                      INSERT INTO face_embeddings ("id", "photoId", "eventId", "photographerId", "faceIndex", "bboxX", "bboxY", "bboxW", "bboxH", "confidence", "embedding", "clusterId")
                      VALUES ${values}
                    `);
                  }

                  await this.prisma.photo.update({
                    where: { id: photoId },
                    data: {
                      status: 'READY',
                      faceScanStatus: 'READY',
                      hasFaces,
                      faceCount
                    }
                  });

                  const p = photos.find(item => item.id === photoId);
                  if (p && p.uploadBatchId) {
                    await this.updateBatchProgress(p.uploadBatchId, true);
                  }
                }
              }
            }
          } catch (batchErr) {
            this.logger.error(`[BatchFaceScan] Photo batch scanning failed for event ${eventId}:`, batchErr);
            const photoIds = photos.map(p => p.id);
            await this.prisma.photo.updateMany({
              where: { id: { in: photoIds } },
              data: { faceScanStatus: 'PENDING' }
            });
          }
        }

        // 2. Process Videos
        for (const video of videos) {
          await this.runBackgroundVideoProcessing(
            photographerId,
            video.id,
            eventId,
            video.r2KeyOriginal,
            video.uploadBatchId
          ).catch(err => {
            this.logger.error(`[BatchFaceScan] Video scan failed for ${video.id}:`, err);
          });
        }

        // Re-check sleep pause (300ms) before checking if new ready thumbnails appeared in the meantime
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    } finally {
      this.activeEventScans.delete(eventId);
    }
  }
}

