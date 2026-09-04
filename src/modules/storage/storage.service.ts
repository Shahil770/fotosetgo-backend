import { Injectable, NotFoundException, OnModuleInit, BadRequestException, UnauthorizedException, ForbiddenException, HttpException, HttpStatus, Logger, Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { Prisma } from '@prisma/client';
import { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, PutBucketCorsCommand, DeleteObjectCommand, DeleteObjectsCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { v4 as uuidv4 } from 'uuid';
import { GoogleDriveService } from './google-drive.service';
import * as fs from 'fs';
import * as path from 'path';

import { NodeHttpHandler } from '@smithy/node-http-handler';
import * as http from 'http';
import * as https from 'https';

@Injectable()
export class StorageService implements OnModuleInit {
  private readonly logger = new Logger(StorageService.name);
  private s3Client: S3Client;
  private bucketName: string;
  private readonly urlCache = new Map<string, { url: string; expiresAt: number }>();
  private readonly activeEventScans = new Set<string>();
  private readonly activeVideoProcessings = new Set<string>();
  private workerDispatchCounter = 0;

  constructor(
    private prisma: PrismaService,
    private googleDriveService: GoogleDriveService,
    @Inject('REDIS_CLIENT') private redis: any,
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
      requestChecksumCalculation: 'WHEN_REQUIRED' as any,
      responseChecksumValidation: 'WHEN_REQUIRED' as any,
      requestHandler: new NodeHttpHandler({
        httpAgent,
        httpsAgent,
        connectionTimeout: 15000,
        socketTimeout: 45000,
      }),
    });

    this.startUploadCompletionProcessor();
    this.startDatabaseSyncProcessor();
  }

  private async scanKeys(pattern: string): Promise<string[]> {
    let cursor = '0';
    const keys: string[] = [];
    try {
      do {
        const [nextCursor, matchedKeys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (matchedKeys && matchedKeys.length > 0) {
          keys.push(...matchedKeys);
        }
      } while (cursor !== '0');
    } catch (err: any) {
      this.logger.error(`[scanKeys] Redis SCAN error for pattern ${pattern}: ${err.message}`);
    }
    return keys;
  }

  private startUploadCompletionProcessor() {
    setInterval(async () => {
      try {
        // High-throughput pipelined pop: pop up to 100 items every 500ms (Throughput: 200 photos/sec = 12,000 photos/min)
        const pipeline = this.redis.pipeline();
        for (let i = 0; i < 100; i++) {
          pipeline.rpop('queue:upload-completions');
        }
        const results = await pipeline.exec();
        if (!results || results.length === 0) return;

        const completions = results
          .map(([err, item]) => (!err && item ? (item as string) : null))
          .filter(Boolean) as string[];

        if (completions.length === 0) return;

        await Promise.allSettled(
          completions.map(async (itemStr) => {
            try {
              const { photographerId, photoId, isGuest, thumbSizeBytes, previewSizeBytes, duration } = JSON.parse(itemStr);
              await this.processQueuedUploadCompletion(photographerId, photoId, !!isGuest, thumbSizeBytes, previewSizeBytes, duration);
            } catch (e: any) {
              this.logger.error(`[UploadQueueProcessor] Failed to process queued item: ${itemStr}, error: ${e.message}`);
            }
          })
        );
      } catch (err: any) {
        this.logger.error('[UploadQueueProcessor] Error in loop:', err.message);
      }
    }, 500);
  }

  async invalidateEventCache(eventId: string) {
    try {
      const event = await this.prisma.event.findUnique({
        where: { id: eventId },
        select: { slug: true, photographerId: true }
      });
      if (event) {
        const keys = [
          `cache:events:list:${event.photographerId}`,
          `cache:event:detail:${eventId}`,
          'cache:public:events:list'
        ];
        if (event.slug) {
          keys.push(`cache:public:event:${event.slug}`);
          keys.push(`cache:public:event:limits:${event.slug}`);
          // Non-blocking incremental scan for passcode variants
          const matchKeys = await this.scanKeys(`cache:public:photos:${event.slug}:*`);
          if (matchKeys && matchKeys.length > 0) {
            keys.push(...matchKeys);
          }
        }
        await this.redis.del(...keys);
        this.logger.log(`[Cache Invalidation] Successfully cleared Redis caches for event slug: ${event.slug || eventId}`);
      }
    } catch (err: any) {
      this.logger.error(`[Cache Invalidation] Failed to clear Redis cache for event ${eventId}:`, err.message);
    }
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

    try {
      const fs = require('fs');
      const path = require('path');
      const defaultLogoLocalPath = path.join(process.cwd(), 'assets', 'logo', 'fotosetgo.png');
      if (fs.existsSync(defaultLogoLocalPath)) {
        const fileBuffer = fs.readFileSync(defaultLogoLocalPath);
        const putCmd = new PutObjectCommand({
          Bucket: this.bucketName,
          Key: 'assets/logo/fotosetgo.png',
          Body: fileBuffer,
          ContentType: 'image/png'
        });
        await this.s3Client.send(putCmd);
        console.log('[StorageService] Successfully uploaded default fotosetgo.png fallback logo to R2');
      }
    } catch (logoErr: any) {
      console.error('[StorageService] Failed to upload default logo fallback to R2:', logoErr.message);
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

    const cacheKey = `cache:photographer:${photographerId}:sub`;
    let photographer: any = null;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) photographer = JSON.parse(cached);
    } catch (err) {
      console.error('[StorageService] Redis get failed inside getUploadPresignedUrl:', err);
    }

    if (!photographer) {
      photographer = await this.prisma.photographer.findUnique({
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
      if (photographer) {
        try {
          await this.redis.set(cacheKey, JSON.stringify(photographer), 'EX', 300); // 5 minutes cache TTL
        } catch (err) {
          console.error('[StorageService] Redis set failed inside getUploadPresignedUrl:', err);
        }
      }
    }

    if (!photographer) {
      throw new NotFoundException('Photographer not found');
    }

    const activeSubscription = photographer.subscriptions[0];
    if (!activeSubscription) {
      throw new BadRequestException('No active subscription found. Please subscribe to a plan to start uploading.');
    }

    // Package table is the single source of truth for events limit
    const pkgMb = activeSubscription.package?.maxEventsStorageMb;
    const limitBytes = (pkgMb !== undefined && pkgMb !== null)
      ? BigInt(pkgMb) * BigInt(1024 * 1024)
      : (activeSubscription.limitEventsBytes ?? activeSubscription.limitBytes ?? BigInt(5000 * 1024 * 1024));

    // Calculate events-only used bytes including trash & in-flight uploads (exclude portfolio/branding files)
    const eventsUsedAgg = await this.prisma.photo.aggregate({
      where: { photographerId, status: { in: ['READY', 'UPLOADING'] } },
      _sum: { fileSize: true },
    });
    const eventsUsedBytes = eventsUsedAgg._sum.fileSize
      ? BigInt(eventsUsedAgg._sum.fileSize.toString())
      : BigInt(0);

    if (eventsUsedBytes + BigInt(data.fileSize) > limitBytes) {
      throw new BadRequestException('Events storage limit exceeded. Please empty your trash or upgrade your plan.');
    }

    const isVideo = data.mimeType.startsWith('video/') || data.filename.match(/\.(mp4|mkv|mov|webm)$/i);
    const fileUuid = uuidv4();
    const cleanFilename = data.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const baseName = cleanFilename.replace(/\.[^/.]+$/, '');

    // Set dynamic R2 Path under unified photographer folder
    const objectKey = isVideo
      ? `${photographerId}/events/${eventId}/videos/${fileUuid}_${cleanFilename}`
      : `${photographerId}/events/${eventId}/photos/${fileUuid}_${cleanFilename}`;

    const thumbKey = `${photographerId}/events/${eventId}/thumbs/${fileUuid}_${baseName}.jpg`;
    const previewKey = isVideo ? null : `${photographerId}/events/${eventId}/previews/${fileUuid}_${baseName}.jpg`;

    // Create a mock photo entry in database
    const photo = await this.prisma.photo.create({
      data: {
        eventId,
        photographerId,
        filenameOriginal: data.filename,
        filenameStored: `${fileUuid}_${cleanFilename}`,
        r2KeyOriginal: objectKey,
        r2KeyThumb: thumbKey,
        r2KeyPreview: previewKey,
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

    // Expires in 1 hour (3600 seconds) - zero timeout risk for heavy queues
    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: 3600,
      unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']),
    });

    let uploadUrlThumb: string | null = null;
    let uploadUrlPreview: string | null = null;

    if (thumbKey) {
      const thumbCmd = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: thumbKey,
        ContentType: 'image/jpeg',
      });
      uploadUrlThumb = await getSignedUrl(this.s3Client, thumbCmd, { expiresIn: 3600, unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']) });
    }

    if (!isVideo && previewKey) {
      const previewCmd = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: previewKey,
        ContentType: 'image/jpeg',
      });
      uploadUrlPreview = await getSignedUrl(this.s3Client, previewCmd, { expiresIn: 3600, unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']) });
    }

    return {
      photoId: photo.id,
      objectKey,
      uploadUrl,
      uploadUrlThumb,
      uploadUrlPreview,
      r2KeyThumb: thumbKey,
      r2KeyPreview: previewKey,
    };
  }

  // Batch version: generate presigned URLs for multiple files at once (1 DB round-trip for checks, then parallel URL generation)
  async getBatchUploadPresignedUrls(
    photographerId: string,
    eventId: string,
    uploadBatchId: string,
    files: { filename: string; mimeType: string; fileSize: number }[],
    totalBatchBytes?: number,
  ) {
    if (!files || files.length === 0) return { results: [] };

    // Validate event ownership once
    const event = await this.prisma.event.findFirst({ where: { id: eventId, photographerId } });
    if (!event) throw new NotFoundException('Event not found or ownership mismatch');

    // Validate subscription once
    const cacheKey = `cache:photographer:${photographerId}:sub`;
    let photographer: any = null;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) photographer = JSON.parse(cached);
    } catch (err) {
      console.error('[StorageService] Redis get failed inside getBatchUploadPresignedUrls:', err);
    }

    if (!photographer) {
      photographer = await this.prisma.photographer.findUnique({
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
      if (photographer) {
        try {
          await this.redis.set(cacheKey, JSON.stringify(photographer), 'EX', 300); // 5 minutes cache TTL
        } catch (err) {
          console.error('[StorageService] Redis set failed inside getBatchUploadPresignedUrls:', err);
        }
      }
    }

    if (!photographer) throw new NotFoundException('Photographer not found');
    const activeSubscription = photographer.subscriptions[0];
    if (!activeSubscription) throw new BadRequestException('No active subscription found.');

    const pkgMb = activeSubscription.package?.maxEventsStorageMb;
    const limitBytes = (pkgMb !== undefined && pkgMb !== null)
      ? BigInt(pkgMb) * BigInt(1024 * 1024)
      : (activeSubscription.limitEventsBytes ?? activeSubscription.limitBytes ?? BigInt(5000 * 1024 * 1024));

    const eventsUsedAgg = await this.prisma.photo.aggregate({
      where: { photographerId, status: { in: ['READY', 'UPLOADING'] } },
      _sum: { fileSize: true },
    });
    const eventsUsedBytes = eventsUsedAgg._sum.fileSize
      ? BigInt(eventsUsedAgg._sum.fileSize.toString())
      : BigInt(0);

    const incomingBatchBytes = (totalBatchBytes !== undefined && totalBatchBytes > 0)
      ? BigInt(totalBatchBytes)
      : BigInt(files.reduce((sum, f) => sum + f.fileSize, 0));

    if (eventsUsedBytes + incomingBatchBytes > limitBytes) {
      throw new BadRequestException('Events storage limit exceeded. Please empty your trash or upgrade your plan.');
    }

    const processedFiles = files.map(file => {
      const isVideo = file.mimeType.startsWith('video/') || file.filename.match(/\.(mp4|mkv|mov|webm)$/i);
      const fileUuid = uuidv4();
      const cleanFilename = file.filename.replace(/[^a-zA-Z0-9.-]/g, '_');
      const baseName = cleanFilename.replace(/\.[^/.]+$/, '');
      const objectKey = isVideo
        ? `${photographerId}/events/${eventId}/videos/${fileUuid}_${cleanFilename}`
        : `${photographerId}/events/${eventId}/photos/${fileUuid}_${cleanFilename}`;
      const thumbKey = `${photographerId}/events/${eventId}/thumbs/${fileUuid}_${baseName}.jpg`;
      const previewKey = isVideo ? null : `${photographerId}/events/${eventId}/previews/${fileUuid}_${baseName}.jpg`;

      return {
        ...file,
        isVideo,
        objectKey,
        thumbKey,
        previewKey,
        filenameStored: `${fileUuid}_${cleanFilename}`
      };
    });

    const createdPhotos = await this.prisma.photo.createManyAndReturn({
      data: processedFiles.map(f => ({
        eventId,
        photographerId,
        filenameOriginal: f.filename,
        filenameStored: f.filenameStored,
        r2KeyOriginal: f.objectKey,
        r2KeyThumb: f.thumbKey,
        r2KeyPreview: f.previewKey,
        mimeType: f.mimeType,
        fileSize: BigInt(f.fileSize),
        status: 'UPLOADING',
        type: f.isVideo ? 'VIDEO' : 'IMAGE',
        uploadBatchId,
      }))
    });

    const results = await Promise.all(createdPhotos.map(async (photo, index) => {
      const command = new PutObjectCommand({ Bucket: this.bucketName, Key: photo.r2KeyOriginal!, ContentType: photo.mimeType! });
      const uploadUrl = await getSignedUrl(this.s3Client, command, {
        expiresIn: 3600,
        unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']),
      });

      let uploadUrlThumb: string | null = null;
      let uploadUrlPreview: string | null = null;

      if (photo.r2KeyThumb) {
        const thumbCmd = new PutObjectCommand({ Bucket: this.bucketName, Key: photo.r2KeyThumb, ContentType: 'image/jpeg' });
        uploadUrlThumb = await getSignedUrl(this.s3Client, thumbCmd, { expiresIn: 3600, unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']) });
      }

      if (photo.type === 'IMAGE' && photo.r2KeyPreview) {
        const previewCmd = new PutObjectCommand({ Bucket: this.bucketName, Key: photo.r2KeyPreview, ContentType: 'image/jpeg' });
        uploadUrlPreview = await getSignedUrl(this.s3Client, previewCmd, { expiresIn: 3600, unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']) });
      }

      return {
        photoId: photo.id,
        objectKey: photo.r2KeyOriginal!,
        uploadUrl,
        uploadUrlThumb,
        uploadUrlPreview,
        r2KeyThumb: photo.r2KeyThumb,
        r2KeyPreview: photo.r2KeyPreview,
        filename: photo.filenameOriginal!
      };
    }));

    return { results };
  }

  // Batch completeUpload: Push to Redis queue to process asynchronously and prevent DB choke
  async completeBatchUpload(
    photographerId: string,
    itemsOrIds: (string | { photoId: string; thumbSizeBytes?: number; previewSizeBytes?: number; duration?: number })[]
  ) {
    if (!itemsOrIds || itemsOrIds.length === 0) return { completed: 0 };

    try {
      const pipeline = this.redis.pipeline();
      for (const item of itemsOrIds) {
        const payload = typeof item === 'string'
          ? { photographerId, photoId: item }
          : { photographerId, photoId: item.photoId, thumbSizeBytes: item.thumbSizeBytes, previewSizeBytes: item.previewSizeBytes, duration: item.duration };
        pipeline.lpush('queue:upload-completions', JSON.stringify(payload));
      }
      await pipeline.exec();
    } catch (err: any) {
      this.logger.error('[completeBatchUpload] Failed to push to Redis queue:', err.message);
      // Fallback: run synchronously if Redis is down
      for (const item of itemsOrIds) {
        const photoId = typeof item === 'string' ? item : item.photoId;
        const thumbSize = typeof item === 'string' ? undefined : item.thumbSizeBytes;
        const previewSize = typeof item === 'string' ? undefined : item.previewSizeBytes;
        const duration = typeof item === 'string' ? undefined : item.duration;
        this.completeUpload(photographerId, photoId, thumbSize, previewSize, duration).catch(() => { });
      }
    }

    return { completed: itemsOrIds.length, queued: true };
  }

  async completeGuestUpload(photoId: string, thumbSizeBytes?: number, previewSizeBytes?: number, duration?: number) {
    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      include: { event: true }
    });

    if (!photo) {
      throw new NotFoundException('Photo not found');
    }

    if (photo.event?.slug) {
      try {
        await this.redis.del(`cache:public:event:limits:${photo.event.slug}`);
      } catch { }
    }

    // Queue completion to Redis so concurrent guest uploads do not block DB pool with synchronous updates
    try {
      await this.redis.lpush(
        'queue:upload-completions',
        JSON.stringify({ photographerId: photo.photographerId, photoId, isGuest: true, thumbSizeBytes, previewSizeBytes, duration })
      );
    } catch (redisErr: any) {
      this.logger.error(`[completeGuestUpload] Redis queue push failed, processing synchronously: ${redisErr.message}`);
      await this.processQueuedUploadCompletion(photo.photographerId, photoId, true, thumbSizeBytes, previewSizeBytes, duration);
    }

    return { success: true, photoId, status: 'QUEUED' };
  }

  async getEventPendingPhotos(photographerId: string, eventId: string) {
    return this.prisma.photo.findMany({
      where: { eventId, photographerId, status: 'PENDING_APPROVAL' },
      orderBy: { createdAt: 'desc' }
    });
  }

  async approveGuestPhoto(photographerId: string, photoId: string) {
    const photo = await this.prisma.photo.findFirst({
      where: { id: photoId, photographerId, status: 'PENDING_APPROVAL' },
      include: { event: true }
    });

    if (!photo) {
      throw new NotFoundException('Pending guest photo not found');
    }

    const hasThumbnail = !!photo.r2KeyThumb;

    let updatedPhoto;
    if (hasThumbnail) {
      updatedPhoto = await this.prisma.photo.update({
        where: { id: photoId },
        data: {
          status: 'READY',
          thumbnailStatus: 'READY',
          faceScanStatus: 'PENDING'
        }
      });

      if (photo.type === 'VIDEO') {
        if (photo.event.videoScanningEnabled) {
          this.runBackgroundVideoProcessing(photographerId, photoId, photo.eventId, photo.r2KeyOriginal, photo.uploadBatchId).catch(err => {
            console.error('[StorageService] Video face scan trigger failed on approve:', err);
          });
        }
      } else if (photo.event.faceScanningEnabled) {
        this.triggerFaceScanForEvent(photographerId, photo.eventId).catch(err => {
          console.error('[StorageService] Face scan trigger failed on approve:', err);
        });
      }

      await this.invalidateEventCache(photo.eventId);
    } else {
      updatedPhoto = await this.prisma.photo.update({
        where: { id: photoId },
        data: { status: 'PROCESSING', thumbnailStatus: 'PENDING' }
      });

      if (photo.type === 'VIDEO') {
        this.runBackgroundVideoProcessing(photographerId, photoId, photo.eventId, photo.r2KeyOriginal, photo.uploadBatchId).catch(err => {
          console.error('[StorageService] Background video processing failed:', err);
        });
      } else {
        await this.triggerCloudflareWorker(photoId, photo.r2KeyOriginal).catch(err => {
          this.logger.error(`[approveGuestPhoto] Worker trigger error for ${photoId}: ${err.message}`);
        });
      }
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

    const thumbSize = photo.thumbSizeBytes || BigInt(0);
    const previewSize = photo.previewSizeBytes || BigInt(0);
    const originalSize = photo.fileSize || BigInt(0);
    const totalBytes = originalSize + thumbSize + previewSize;

    // 1. Revert photographer storage usage footprint (Original + Thumb + Preview)
    await this.prisma.photographer.update({
      where: { id: photographerId },
      data: {
        totalStorageUsedBytes: {
          decrement: totalBytes
        }
      }
    }).catch(() => { });

    const activeSub = await this.prisma.subscription.findFirst({
      where: { photographerId, status: 'ACTIVE' },
      orderBy: { startsAt: 'desc' }
    });

    if (activeSub) {
      await this.prisma.subscription.update({
        where: { id: activeSub.id },
        data: {
          usedBytes: {
            decrement: totalBytes
          }
        }
      }).catch(() => { });

      await this.redis.hincrby("agg:subscription:storage", activeSub.id, (-totalBytes).toString()).catch(() => { });
    }

    await this.redis.hincrby("agg:photographer:storage", photographerId, (-totalBytes).toString()).catch(() => { });

    // 2. Collect all R2 keys (Original, Thumb, Preview) to delete from R2 bucket
    const keysToDelete: string[] = [];
    if (photo.r2KeyOriginal) keysToDelete.push(photo.r2KeyOriginal);
    if (photo.r2KeyThumb) keysToDelete.push(photo.r2KeyThumb);
    if (photo.r2KeyPreview) keysToDelete.push(photo.r2KeyPreview);

    // Fallback computed preview/thumb keys if they were created by worker
    if (photo.r2KeyOriginal) {
      const computedThumb = photo.r2KeyOriginal.replace('/photos/', '/thumbs/').replace('/videos/', '/thumbs/').replace(/\.[^/.]+$/, '.jpg');
      const computedPreview = photo.r2KeyOriginal.replace('/photos/', '/previews/').replace('/videos/', '/previews/').replace(/\.[^/.]+$/, '.jpg');
      if (!keysToDelete.includes(computedThumb)) keysToDelete.push(computedThumb);
      if (!keysToDelete.includes(computedPreview)) keysToDelete.push(computedPreview);
    }

    // 3. Delete photo record from DB immediately so UI responds in milliseconds
    await this.prisma.photo.delete({ where: { id: photoId } }).catch(async (err: any) => {
      this.logger.warn(`[rejectGuestPhoto] Delete failed, trying update: ${err.message}`);
      await this.prisma.photo.update({
        where: { id: photoId },
        data: { isDeleted: true }
      }).catch(() => { });
    });

    // 4. Delete R2 objects in background without blocking response
    if (keysToDelete.length > 0) {
      this.s3Client.send(new DeleteObjectsCommand({
        Bucket: this.bucketName,
        Delete: {
          Objects: keysToDelete.map(k => ({ Key: k })),
          Quiet: true,
        }
      })).catch((err: any) => {
        this.logger.error(`[rejectGuestPhoto] Background R2 DeleteObjects error: ${err.message}`);
      });
    }

    await this.recalculateStorage(photographerId).catch(() => { });
    await this.invalidateStorageBreakdownCache(photographerId).catch(() => { });
    await this.invalidateEventPhotosCache(photographerId, photo.eventId).catch(() => { });
    await this.invalidateEventCache(photo.eventId).catch(() => { });

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
              take: 1,
              include: { package: true }
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
    if (!photographer) {
      throw new BadRequestException('Event photographer not found');
    }
    const activeSubscription = photographer.subscriptions[0];
    const pkgMb = activeSubscription?.package?.maxEventsStorageMb;
    const limitBytes = (pkgMb !== undefined && pkgMb !== null)
      ? BigInt(pkgMb) * BigInt(1024 * 1024)
      : (activeSubscription?.limitEventsBytes ?? activeSubscription?.limitBytes ?? BigInt(5000 * 1024 * 1024));

    const eventsUsedAgg = await this.prisma.photo.aggregate({
      where: { photographerId: photographer.id, status: { in: ['READY', 'UPLOADING', 'PENDING_APPROVAL'] } },
      _sum: { fileSize: true },
    });
    const eventsUsedBytes = eventsUsedAgg._sum.fileSize
      ? BigInt(eventsUsedAgg._sum.fileSize.toString())
      : BigInt(0);

    if (eventsUsedBytes + BigInt(data.fileSize) > limitBytes) {
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
    const baseName = cleanFilename.replace(/\.[^/.]+$/, '');

    // Set R2 Path
    const objectKey = isVideo
      ? `${photographer.id}/events/${event.id}/videos/${fileUuid}_${cleanFilename}`
      : `${photographer.id}/events/${event.id}/photos/${fileUuid}_${cleanFilename}`;

    const thumbKey = `${photographer.id}/events/${event.id}/thumbs/${fileUuid}_${baseName}.jpg`;
    const previewKey = isVideo ? null : `${photographer.id}/events/${event.id}/previews/${fileUuid}_${baseName}.jpg`;

    // Create Photo entry with PENDING_APPROVAL status
    const photo = await this.prisma.photo.create({
      data: {
        eventId: event.id,
        photographerId: photographer.id,
        filenameOriginal: data.filename,
        filenameStored: `${fileUuid}_${cleanFilename}`,
        r2KeyOriginal: objectKey,
        r2KeyThumb: thumbKey,
        r2KeyPreview: previewKey,
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

    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: 3600,
      unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']),
    });

    let uploadUrlThumb: string | null = null;
    let uploadUrlPreview: string | null = null;

    if (thumbKey) {
      const thumbCmd = new PutObjectCommand({ Bucket: this.bucketName, Key: thumbKey, ContentType: 'image/jpeg' });
      uploadUrlThumb = await getSignedUrl(this.s3Client, thumbCmd, { expiresIn: 3600, unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']) });
    }

    if (!isVideo && previewKey) {
      const previewCmd = new PutObjectCommand({ Bucket: this.bucketName, Key: previewKey, ContentType: 'image/jpeg' });
      uploadUrlPreview = await getSignedUrl(this.s3Client, previewCmd, { expiresIn: 3600, unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']) });
    }

    return {
      photoId: photo.id,
      uploadUrl,
      uploadUrlThumb,
      uploadUrlPreview,
      r2KeyThumb: thumbKey,
      r2KeyPreview: previewKey,
    };
  }

  async completeUpload(photographerId: string, photoId: string, thumbSizeBytes?: number, previewSizeBytes?: number, duration?: number) {
    this.logger.log(`[completeUpload] Queueing browser upload complete signal for photoId: ${photoId}`);
    try {
      await this.redis.lpush('queue:upload-completions', JSON.stringify({ photographerId, photoId, thumbSizeBytes, previewSizeBytes, duration }));
    } catch (err: any) {
      this.logger.error('[completeUpload] Redis queue push failed, processing synchronously:', err.message);
      // Fallback
      return this.processQueuedUploadCompletion(photographerId, photoId, false, thumbSizeBytes, previewSizeBytes, duration);
    }
    return { success: true, queued: true };
  }

  private async processQueuedUploadCompletion(
    photographerId: string,
    photoId: string,
    isGuest: boolean = false,
    thumbSizeBytes?: number,
    previewSizeBytes?: number,
    duration?: number
  ) {
    this.logger.log(`[processQueuedUploadCompletion] Processing completion database updates for photoId: ${photoId} (isGuest: ${isGuest})`);
    const photo = await this.prisma.photo.findFirst({
      where: { id: photoId, photographerId },
    });

    if (!photo) {
      this.logger.error(`[processQueuedUploadCompletion] Photo ${photoId} not found in DB`);
      return;
    }

    const thumbSizeBigInt = thumbSizeBytes ? BigInt(thumbSizeBytes) : (photo.thumbSizeBytes || BigInt(0));
    const previewSizeBigInt = previewSizeBytes ? BigInt(previewSizeBytes) : (photo.previewSizeBytes || BigInt(0));
    const totalFileBytes = photo.fileSize + thumbSizeBigInt + previewSizeBigInt;

    let redisSyncSuccess = false;
    try {
      // 1. Try to increment photographer storage in Redis
      await this.redis.hincrby("agg:photographer:storage", photographerId, totalFileBytes.toString());

      // 2. Try to increment subscription usage in Redis
      const activeSub = await this.prisma.subscription.findFirst({
        where: { photographerId, status: 'ACTIVE' },
        orderBy: { startsAt: 'desc' }
      });

      if (activeSub) {
        await this.redis.hincrby("agg:subscription:storage", activeSub.id, totalFileBytes.toString());
      }

      // 3. Try to increment batch uploaded counter in Redis
      if (photo.uploadBatchId) {
        await this.redis.hincrby("agg:uploadBatch:uploaded", photo.uploadBatchId, "1");
      }

      redisSyncSuccess = true;
    } catch (redisErr: any) {
      this.logger.error(`[processQueuedUploadCompletion] Redis counter increment failed, falling back to direct SQL updates: ${redisErr.message}`);
    }

    if (!redisSyncSuccess) {
      // Fallback: If Redis is down, update database directly (synchronously)
      await this.prisma.photographer.update({
        where: { id: photographerId },
        data: {
          totalStorageUsedBytes: {
            increment: totalFileBytes
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
              increment: totalFileBytes
            }
          }
        });
      }

      if (photo.uploadBatchId) {
        await this.prisma.uploadBatch.update({
          where: { id: photo.uploadBatchId },
          data: {
            uploadedFiles: { increment: 1 }
          }
        }).catch(err => console.error('[StorageService] Direct fallback update batch upload counter failed:', err));
      }
    }

    const isClientThumbReady = !!photo.r2KeyThumb;

    const updatedPhoto = await this.prisma.photo.update({
      where: { id: photoId },
      data: {
        status: isGuest ? 'PENDING_APPROVAL' : (isClientThumbReady ? 'READY' : 'PROCESSING'),
        thumbnailStatus: isClientThumbReady ? 'READY' : 'PENDING',
        thumbSizeBytes: thumbSizeBigInt > BigInt(0) ? thumbSizeBigInt : undefined,
        previewSizeBytes: previewSizeBigInt > BigInt(0) ? previewSizeBigInt : undefined,
        duration: duration && duration > 0 ? duration : (photo.duration || undefined),
      }
    });

    // Invalidate cached event queries so visitors, clients, and dashboard see updates instantly
    await this.invalidateEventCache(photo.eventId);

    // Fire-and-forget:
    if (photo.type === 'VIDEO') {
      this.runBackgroundVideoProcessing(photographerId, photoId, photo.eventId, photo.r2KeyOriginal, photo.uploadBatchId).catch(err => {
        console.error('[StorageService] Background video processing failed:', err);
      });
    } else if (!isClientThumbReady) {
      // FTP / Camera Beam upload where thumb was not uploaded client-side
      this.triggerCloudflareWorker(photoId, photo.r2KeyOriginal).catch(err => {
        this.logger.error(`[processQueuedUploadCompletion] Thumbnail engine trigger error for ${photoId}: ${err.message}`);
      });
    } else {
      // Client-side thumbnail already ready!
      // If AI Face Scanning is active on event, trigger face recognition directly!
      if (!isGuest) {
        this.prisma.event.findUnique({ where: { id: photo.eventId } }).then(event => {
          if (event && event.faceScanningEnabled) {
            this.triggerFaceScanForEvent(photographerId, photo.eventId).catch(err => {
              console.error('[StorageService] Background face scan trigger failed:', err);
            });
          }
        }).catch(() => { });
      }
    }

    if (!isGuest) {
      if (photo.type === 'VIDEO') {
        this.prisma.event.findUnique({ where: { id: photo.eventId } }).then(event => {
          if (event && event.videoScanningEnabled) {
            this.triggerFaceScanForEvent(photographerId, photo.eventId).catch(err => {
              console.error('[StorageService] Video face scan loop trigger failed:', err);
            });
          }
        }).catch(() => { });
      }

      this.syncToGoogleDriveInBackground(photographerId, photo).catch(err => {
        console.error('[StorageService] Background Google Drive sync trigger failed:', err);
      });
    }

    await this.invalidateStorageBreakdownCache(photographerId);

    return updatedPhoto;
  }

  private startDatabaseSyncProcessor() {
    this.logger.log('[StorageService] Starting background database metrics sync processor (every 10 seconds)');
    // Run every 10 seconds to sync aggregated Redis counters to PostgreSQL
    setInterval(async () => {
      try {
        await this.syncAggregatedPhotographerStorage();
        await this.syncAggregatedSubscriptionStorage();
        await this.syncAggregatedUploadBatches();
      } catch (err) {
        this.logger.error(`[DatabaseSyncProcessor] Error in loop: ${err.message}`);
      }
    }, 10000);
  }

  private async syncAggregatedPhotographerStorage() {
    const key = 'agg:photographer:storage';
    const tempKey = `${key}:processing:${uuidv4()}`;

    try {
      const exists = await this.redis.exists(key);
      if (!exists || exists === 0) return;
      await this.redis.rename(key, tempKey);
    } catch (renameErr) {
      return;
    }

    try {
      const data = await this.redis.hgetall(tempKey);
      if (!data || Object.keys(data).length === 0) return;

      const photographerIds = Object.keys(data);
      this.logger.log(`[DatabaseSyncProcessor] Syncing storage totals to PG database for ${photographerIds.length} photographers`);

      await Promise.all(
        photographerIds.map(async (photographerId) => {
          const incrementBytes = BigInt(data[photographerId]);
          if (incrementBytes <= BigInt(0)) return;

          try {
            await this.prisma.photographer.update({
              where: { id: photographerId },
              data: {
                totalStorageUsedBytes: {
                  increment: incrementBytes
                }
              }
            });
          } catch (dbErr) {
            this.logger.error(`[DatabaseSyncProcessor] Failed to update photographer storage ${photographerId} in DB: ${dbErr.message}`);
            // Restore only the failed photographer's bytes count back to Redis
            await this.redis.hincrby(key, photographerId, data[photographerId]).catch(restoreErr =>
              this.logger.error(`[DatabaseSyncProcessor] Failed to restore photographer storage ${photographerId} back to Redis: ${restoreErr.message}`)
            );
          }
        })
      );
    } catch (err) {
      this.logger.error(`[DatabaseSyncProcessor] Photographer storage sync batch process failed: ${err.message}`);
    } finally {
      await this.redis.del(tempKey).catch(() => { });
    }
  }

  private async syncAggregatedSubscriptionStorage() {
    const key = 'agg:subscription:storage';
    const tempKey = `${key}:processing:${uuidv4()}`;

    try {
      const exists = await this.redis.exists(key);
      if (!exists || exists === 0) return;
      await this.redis.rename(key, tempKey);
    } catch (renameErr) {
      return;
    }

    try {
      const data = await this.redis.hgetall(tempKey);
      if (!data || Object.keys(data).length === 0) return;

      const subIds = Object.keys(data);
      this.logger.log(`[DatabaseSyncProcessor] Syncing storage usedBytes to PG database for ${subIds.length} subscriptions`);

      await Promise.all(
        subIds.map(async (subId) => {
          const incrementBytes = BigInt(data[subId]);
          if (incrementBytes <= BigInt(0)) return;

          try {
            await this.prisma.subscription.update({
              where: { id: subId },
              data: {
                usedBytes: {
                  increment: incrementBytes
                }
              }
            });
          } catch (dbErr) {
            this.logger.error(`[DatabaseSyncProcessor] Failed to update subscription ${subId} in DB: ${dbErr.message}`);
            await this.redis.hincrby(key, subId, data[subId]).catch(restoreErr =>
              this.logger.error(`[DatabaseSyncProcessor] Failed to restore subscription ${subId} back to Redis: ${restoreErr.message}`)
            );
          }
        })
      );
    } catch (err) {
      this.logger.error(`[DatabaseSyncProcessor] Subscription storage sync batch process failed: ${err.message}`);
    } finally {
      await this.redis.del(tempKey).catch(() => { });
    }
  }

  private async syncAggregatedUploadBatches() {
    const key = 'agg:uploadBatch:uploaded';
    const tempKey = `${key}:processing:${uuidv4()}`;

    try {
      const exists = await this.redis.exists(key);
      if (!exists || exists === 0) return;
      await this.redis.rename(key, tempKey);
    } catch (renameErr) {
      return;
    }

    try {
      const data = await this.redis.hgetall(tempKey);
      if (!data || Object.keys(data).length === 0) return;

      const batchIds = Object.keys(data);
      this.logger.log(`[DatabaseSyncProcessor] Syncing uploaded files count to PG database for ${batchIds.length} upload batches`);

      await Promise.all(
        batchIds.map(async (batchId) => {
          const incrementCount = Number(data[batchId]);
          if (incrementCount <= 0) return;

          try {
            await this.prisma.uploadBatch.update({
              where: { id: batchId },
              data: {
                uploadedFiles: {
                  increment: incrementCount
                }
              }
            });
          } catch (dbErr: any) {
            this.logger.error(`[DatabaseSyncProcessor] Failed to update upload batch ${batchId} in DB: ${dbErr.message}`);
            if (!dbErr.message?.includes('No record was found') && !dbErr.message?.includes('Record to update not found')) {
              await this.redis.hincrby(key, batchId, data[batchId]).catch(restoreErr =>
                this.logger.error(`[DatabaseSyncProcessor] Failed to restore upload batch ${batchId} back to Redis: ${restoreErr.message}`)
              );
            }
          }
        })
      );
    } catch (err) {
      this.logger.error(`[DatabaseSyncProcessor] UploadBatch count sync batch process failed: ${err.message}`);
    } finally {
      await this.redis.del(tempKey).catch(() => { });
    }
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

  async cancelBatchUpload(photographerId: string, uploadBatchId: string) {
    if (!uploadBatchId) return { cancelled: false };

    // Atomically remove all photos in this batch that never completed upload
    const deleteResult = await this.prisma.photo.deleteMany({
      where: {
        uploadBatchId,
        photographerId,
        status: 'UPLOADING',
      },
    });

    await this.prisma.uploadBatch.update({
      where: { id: uploadBatchId },
      data: { status: 'CANCELLED' },
    }).catch(() => { });

    // Invalidate storage cache so quota is freed immediately
    try {
      await this.redis.del(`cache:photographer:${photographerId}:storage-breakdown`);
    } catch (e) { }

    this.logger.log(`[cancelBatchUpload] Purged ${deleteResult.count} orphaned UPLOADING photos for batch ${uploadBatchId}`);
    return { cancelled: true, purgedCount: deleteResult.count };
  }

  async checkObjectExistsInR2(r2Key: string): Promise<{ exists: boolean; size?: number }> {
    try {
      const cmd = new HeadObjectCommand({
        Bucket: this.bucketName,
        Key: r2Key,
      });
      const res = await this.s3Client.send(cmd);
      return { exists: true, size: res.ContentLength || 0 };
    } catch (err: any) {
      if (err.name === 'NotFound' || err.$metadata?.httpStatusCode === 404) {
        return { exists: false };
      }
      this.logger.warn(`[checkObjectExistsInR2] HeadObject check for ${r2Key} returned: ${err.message}`);
      return { exists: false };
    }
  }

  async deleteOrphanPhotoRecord(photoId: string, r2KeyOriginal?: string): Promise<void> {
    if (r2KeyOriginal) {
      try {
        const deleteCmd = new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: r2KeyOriginal,
        });
        await this.s3Client.send(deleteCmd);
      } catch (r2Err: any) {
        // Ignore not found errors on deletion
      }
    }
    await this.prisma.photo.delete({
      where: { id: photoId }
    }).catch(() => { });
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
      // Use $executeRaw for atomic increment — avoids fetching full batch row (reduces network transfer)
      if (isSuccess) {
        await this.prisma.$executeRaw`UPDATE "upload_batches" SET "processedFiles" = "processedFiles" + 1 WHERE id = ${uploadBatchId}`;
      } else {
        await this.prisma.$executeRaw`UPDATE "upload_batches" SET "failedFiles" = "failedFiles" + 1 WHERE id = ${uploadBatchId}`;
      }
      // Check completion with lightweight count query
      const batch = await this.prisma.uploadBatch.findUnique({
        where: { id: uploadBatchId },
        select: { processedFiles: true, failedFiles: true, totalFiles: true }
      });
      if (batch && batch.processedFiles + batch.failedFiles >= batch.totalFiles) {
        await this.prisma.uploadBatch.update({
          where: { id: uploadBatchId },
          data: { status: 'COMPLETED' }
        });
      }
    } catch (err) {
      console.error('[StorageService] Failed to update batch progress:', err);
    }
  }

  async runBackgroundVideoProcessing(
    photographerId: string,
    photoId: string,
    eventId: string,
    r2KeyOriginal: string,
    uploadBatchId?: string | null
  ) {
    if (this.activeVideoProcessings.has(photoId)) {
      this.logger.log(`[VideoProcessing] Background video processing is already running for video ${photoId}. Skipping.`);
      return;
    }
    this.activeVideoProcessings.add(photoId);

    // Check if video photo has been trashed/deleted in the meantime
    const currentVideo = await this.prisma.photo.findUnique({
      where: { id: photoId }
    });
    if (!currentVideo || currentVideo.isDeleted) {
      console.log(`[StorageService] Video ${photoId} is deleted/trashed. Skipping video processing.`);
      await this.updateBatchProgress(uploadBatchId, true);
      return;
    }

    let duration = currentVideo.duration || 0;
    // Fallback computed thumb key (used if Modal doesn't return actual key)
    const computedThumbKey = r2KeyOriginal.includes('/videos/')
      ? r2KeyOriginal.replace('/videos/', '/thumbs/').replace(/\.[^/.]+$/, '.jpg')
      : r2KeyOriginal.replace('/photos/', '/thumbs/').replace(/\.[^/.]+$/, '.jpg');

    // This will be set to actual key returned by Modal CPU thumbnail engine
    let actualThumbKey: string | null = null;

    try {
      // 1. Get Signed URL for R2 video
      const getCmd = new GetObjectCommand({ Bucket: this.bucketName, Key: r2KeyOriginal });
      const videoSignedUrl = await getSignedUrl(this.s3Client, getCmd, { expiresIn: 3600 });

      // 2. Check if client-side actually generated and uploaded a valid thumbnail
      const hasValidClientThumb = currentVideo.thumbSizeBytes && Number(currentVideo.thumbSizeBytes) > 0;
      if (hasValidClientThumb && currentVideo.r2KeyThumb) {
        actualThumbKey = currentVideo.r2KeyThumb;
        this.logger.log(`[VideoProcessing] Using verified client thumb for video ${photoId}: ${actualThumbKey}`);
      }

      let videoThumbSize = 0;
      if (!actualThumbKey) {
        try {
          const thumbnailEngineUrl = process.env.THUMBNAIL_ENGINE_URL || 'https://sahilshah778800--thumbnail-engine-fastapi-app.modal.run';
          const thumbRes = await fetch(`${thumbnailEngineUrl}/generate-thumbnail`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: [{ photoId, objectKey: r2KeyOriginal }] }),
            signal: AbortSignal.timeout(30000)
          });
          if (thumbRes.ok) {
            const thumbData: any = await thumbRes.json();
            const thumbResult = (thumbData?.results || []).find((r: any) => r.photoId === photoId && r.success);
            if (thumbResult?.thumbKey) {
              actualThumbKey = thumbResult.thumbKey;
              videoThumbSize = thumbResult.thumbSize || 0;
              this.logger.log(`[VideoProcessing] Got actual thumbKey from Modal for video ${photoId}: ${actualThumbKey} (size: ${videoThumbSize} bytes)`);
            }
            if (thumbResult?.duration && thumbResult.duration > 0 && duration === 0) {
              duration = Math.round(thumbResult.duration);
              this.logger.log(`[VideoProcessing] Extracted duration via Modal cloud for video ${photoId}: ${duration} seconds`);
            }
          }
        } catch (thumbErr: any) {
          this.logger.error(`[VideoProcessing] CPU thumbnail engine failed for video ${photoId}: ${thumbErr.message}`);
        }
      }

      const finalThumbKey = actualThumbKey || computedThumbKey;

      // 3. Video Face Scanning (Check Global & Event Toggles)
      const photographer = await this.prisma.photographer.findUnique({
        where: { id: photographerId },
      });
      const event = await this.prisma.event.findUnique({
        where: { id: eventId },
      });

      // Update DB with thumbnail first so preview is immediately ready
      const isPendingApproval = currentVideo.status === 'PENDING_APPROVAL';
      await this.prisma.photo.update({
        where: { id: photoId },
        data: {
          status: isPendingApproval ? 'PENDING_APPROVAL' : 'READY',
          thumbnailStatus: 'READY',
          r2KeyThumb: finalThumbKey,
          thumbSizeBytes: BigInt(videoThumbSize || 0),
          thumbnailUrl: `https://pub-d4d6b7ea94e00e300402.r2.dev/${finalThumbKey}`,
          duration: duration > 0 ? duration : undefined,
        },
      });

      if (videoThumbSize > 0) {
        await this.redis.hincrby("agg:photographer:storage", photographerId, videoThumbSize.toString()).catch(() => { });
      }

      await this.invalidateStorageBreakdownCache(photographerId);

      // Estimate cost BEFORE calling Modal using duration probed on cloud
      const estimatedMinutes = Math.ceil(duration / 60) || 1;
      const estimatedCost = estimatedMinutes * 50; // 50 paise per minute
      const currentBalance = photographer?.creditBalance || 0;
      const canAffordScan = currentBalance >= estimatedCost;

      if (!isPendingApproval && photographer?.videoFaceScanningEnabled && event?.videoScanningEnabled) {
        if (!canAffordScan) {
          // NOT enough credits for estimated duration — skip Modal call entirely to prevent free compute
          this.logger.warn(`[VideoProcessing] Photographer ${photographerId} has insufficient credits (${currentBalance} paise) for estimated video cost (${estimatedCost} paise, ~${estimatedMinutes} min). Skipping Modal call entirely.`);
          await this.prisma.photo.update({
            where: { id: photoId },
            data: { faceScanStatus: 'SKIPPED' }
          });
        } else {
          const faceEngineUrl = process.env.FACE_ENGINE_URL || 'https://sahilshah778800--face-engine-fastapi-app.modal.run';
          const backendAppUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_API_URL || 'https://api.fotosetgo.com';
          const webhookUrl = `${backendAppUrl}/api/public/webhook/video-face-complete`;
          const secretKey = process.env.WORKER_SECRET_KEY || '';

          try {
            // Call Modal GPU Video Indexing Endpoint (/faces/index-video) with Webhook URL
            const response = await fetch(`${faceEngineUrl}/faces/index-video`, {
              method: 'POST',
              headers: {
                'Content-Type': 'application/json',
                'x-api-key': process.env.MODAL_API_KEY || ''
              },
              body: JSON.stringify({
                videoUrl: videoSignedUrl,
                photoId,
                eventId,
                photographerId,
                webhookUrl,
                secretKey
              }),
              signal: AbortSignal.timeout(60000)
            });

            if (response.ok) {
              const result = await response.json();
              if (result && result.faces) {
                await this.completeVideoFaceWebhook({
                  photoId,
                  duration: result.duration || duration,
                  faces: result.faces,
                  secretKey
                });
              } else if (result && result.status === 'QUEUED') {
                this.logger.log(`[VideoProcessing] Video ${photoId} dispatched to Modal background worker. Result will arrive via Webhook.`);
              }
            }
          } catch (videoScanErr: any) {
            this.logger.error(`[StorageService] Modal video face scan dispatch for video ${photoId}: ${videoScanErr.message}`);
          }
        }
      }

      await this.invalidateEventCache(eventId);

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
    } finally {
      this.activeVideoProcessings.delete(photoId);
    }
  }

  async processIngestedPhoto(photographerId: string, photoId: string, eventId: string, r2KeyOriginal: string) {
    try {
      const thumbnailEngineUrl = process.env.THUMBNAIL_ENGINE_URL || 'https://sahilshah778800--thumbnail-engine-fastapi-app.modal.run';
      const thumbRes = await fetch(`${thumbnailEngineUrl}/generate-thumbnail`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ items: [{ photoId, objectKey: r2KeyOriginal }] }),
        signal: AbortSignal.timeout(30000)
      });

      if (thumbRes.ok) {
        const thumbData: any = await thumbRes.json();
        const res = (thumbData?.results || []).find((r: any) => r.photoId === photoId && r.success);
        if (res && res.thumbKey) {
          const thumbSizeBytes = BigInt(res.thumbSize || 0);
          const previewSizeBytes = BigInt(res.previewSize || 0);
          const extraBytes = thumbSizeBytes + previewSizeBytes;

          await this.prisma.photo.update({
            where: { id: photoId },
            data: {
              r2KeyThumb: res.thumbKey,
              r2KeyPreview: res.previewKey || null,
              thumbSizeBytes,
              previewSizeBytes,
              thumbnailStatus: 'READY',
              status: 'READY'
            }
          });

          // Add generated derivatives size to storage
          if (extraBytes > BigInt(0)) {
            await this.redis.hincrby("agg:photographer:storage", photographerId, extraBytes.toString()).catch(() => { });
          }
          await this.invalidateStorageBreakdownCache(photographerId);
          await this.invalidateEventPhotosCache(photographerId, eventId);

          // Check if event face scanning is enabled, trigger indexing
          const event = await this.prisma.event.findUnique({
            where: { id: eventId },
            select: { faceScanningEnabled: true }
          });
          if (event?.faceScanningEnabled) {
            this.triggerFaceScanForEvent(photographerId, eventId).catch(err => {
              this.logger.error(`[ProcessIngestedPhoto] Face scan trigger failed for event ${eventId}:`, err);
            });
          }
          this.logger.log(`[ProcessIngestedPhoto] Photo ${photoId} thumbnail & preview generated successfully! (Thumb: ${res.thumbSize}B, Preview: ${res.previewSize}B)`);
        }
      }
    } catch (err: any) {
      this.logger.error(`[ProcessIngestedPhoto] Failed to generate thumbnail/preview for photo ${photoId}: ${err.message}`);
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

      // If thumbnail is missing from photo record, dispatch to Modal CPU Thumbnail Engine asynchronously
      if (!thumbKey) {
        this.triggerCloudflareWorker(photoId, r2KeyOriginal).catch(err =>
          this.logger.error(`[FaceIndexing] Modal thumbnail engine trigger error for photo ${photoId}: ${err.message}`)
        );
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

      // Use Preview URL (JPEG) if present for 100% reliable format compatibility and fast loading, fallback to Original
      const scanKey = currentPhoto.r2KeyPreview || r2KeyOriginal;
      const origCommand = new GetObjectCommand({ Bucket: this.bucketName, Key: scanKey });
      const faceIndexUrl = await getSignedUrl(this.s3Client, origCommand, { expiresIn: 600 });

      // Call FastAPI Face Engine with Webhook callback support
      const faceEngineUrl = process.env.FACE_ENGINE_URL || 'https://sahilshah778800--face-engine-fastapi-app.modal.run';
      const backendAppUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_API_URL || 'https://api.fotosetgo.com';
      const webhookUrl = `${backendAppUrl}/api/public/webhook/photo-face-complete`;
      const secretKey = process.env.WORKER_SECRET_KEY || '';

      const response = await fetch(`${faceEngineUrl}/faces/index-photo`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.MODAL_API_KEY || ''
        },
        body: JSON.stringify({
          photoId,
          eventId,
          photographerId,
          imageUrl: faceIndexUrl,
          webhookUrl,
          secretKey
        }),
        signal: AbortSignal.timeout(40000)
      });

      if (response.ok) {
        const result = await response.json();
        if (result && result.faces) {
          await this.completePhotoFaceWebhook({
            eventId,
            photographerId,
            photoId,
            faces: result.faces,
            secretKey
          });
        } else if (result && result.status === 'QUEUED') {
          this.logger.log(`[PhotoFaceIndexing] Photo ${photoId} queued in Modal worker. Result will arrive via Webhook.`);
        }
      } else {
        const errText = await response.text();
        this.logger.error(`FastAPI returned non-200 status for photo ${photoId}: ${response.status} - ${errText}`);
        await this.prisma.photo.update({
          where: { id: photoId },
          data: {
            status: 'READY',
            faceScanStatus: 'SKIPPED',
            r2KeyThumb: thumbKey,
          }
        });
      }

      // Auto-backup to Google Drive if enabled (non-blocking)
      this.triggerAutoBackupIfEnabled(photographerId, photoId).catch(err =>
        console.error('[AutoBackup] Photo trigger failed:', err)
      );

      await this.updateBatchProgress(uploadBatchId, true);
    } catch (err: any) {
      this.logger.error(`[StorageService] FastAPI background face recognition error for ${photoId}: ${err.message}`);
      await this.prisma.photo.update({
        where: { id: photoId },
        data: {
          status: 'READY',
          faceScanStatus: 'SKIPPED',
          r2KeyThumb: thumbKey,
        }
      }).catch(e => console.error('Failed to update status:', e));

      await this.updateBatchProgress(uploadBatchId, false);
    } finally {
      // Previews are no longer created, so no deletion is necessary
    }
  }

  async getReadUrl(key: string): Promise<string> {
    const now = Date.now();
    const cached = this.urlCache.get(key);
    if (cached && cached.expiresAt > now + 300000) { // 5 minutes buffer
      // Refresh recency for LRU ordering
      this.urlCache.delete(key);
      this.urlCache.set(key, cached);
      return cached.url;
    }

    // True Bounded LRU Cache: strictly cap memory at 5,000 entries by evicting least recently used items
    while (this.urlCache.size >= 5000) {
      const oldestKey = this.urlCache.keys().next().value;
      if (oldestKey) {
        this.urlCache.delete(oldestKey);
      } else {
        break;
      }
    }

    const getCommand = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
    });
    const url = await getSignedUrl(this.s3Client, getCommand, { expiresIn: 3600 }); // 1 hour expiration
    this.urlCache.set(key, { url, expiresAt: now + 3600000 });
    return url;
  }

  async getDownloadUrl(key: string, filename?: string): Promise<string> {
    const safeFilename = (filename || 'photo.jpg').replace(/["\r\n]/g, '_');
    const getCommand = new GetObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${safeFilename}"`,
    });
    return await getSignedUrl(this.s3Client, getCommand, { expiresIn: 3600 }); // 1 hour direct signed download link
  }

  async getSelfieUploadUrl(filename: string, mimeType: string) {
    const fileUuid = uuidv4();
    const cleanFilename = filename.replace(/[^a-zA-Z0-9.-]/g, '_');
    const objectKey = `temp-selfies/${fileUuid}_${cleanFilename}`;

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: objectKey,
      ContentType: mimeType,
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, { expiresIn: 300 });

    return {
      objectKey,
      uploadUrl,
    };
  }

  private async extractEmbeddingFromUrl(r2Key: string): Promise<number[] | null> {
    const faceEngineUrl = process.env.FACE_ENGINE_URL || 'https://sahilshah778800--face-engine-fastapi-app.modal.run';

    // 1. Generate a temporary presigned GET URL for the R2 key (valid for 5 mins)
    let imageUrl = '';
    try {
      const getCommand = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: r2Key,
      });
      imageUrl = await getSignedUrl(this.s3Client, getCommand, { expiresIn: 300 });
    } catch (s3Err: any) {
      this.logger.error(`Failed to generate presigned GET URL for face search: ${s3Err.message}`);
      return null;
    }

    // 2. Call Modal API
    try {
      const response = await fetch(`${faceEngineUrl.replace(/\/$/, '')}/faces/extract-url`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.MODAL_API_KEY || ''
        },
        body: JSON.stringify({ imageUrl }),
        signal: AbortSignal.timeout(40000)
      });

      if (!response.ok) {
        const errBody = await response.text();
        this.logger.error(`[StorageService] FastAPI extract-url failed: status=${response.status}, body=${errBody}`);
        return null;
      }

      const result = await response.json();

      // 3. Delete the temp selfie from R2 bucket in the background
      this.s3Client.send(new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: r2Key,
      })).catch((delErr) => {
        this.logger.error(`Failed to delete temp selfie ${r2Key} from R2: ${delErr.message}`);
      });

      if (result.faceCount > 0 && result.embedding) {
        return result.embedding;
      }
      return null;
    } catch (err: any) {
      this.logger.error('[StorageService] FastAPI background face extraction from URL failed:', err.message);
      // Clean up the file anyway
      this.s3Client.send(new DeleteObjectCommand({
        Bucket: this.bucketName,
        Key: r2Key,
      })).catch(() => { });
      return null;
    }
  }

  async searchFace(photographerId: string, r2Key: string, eventId?: string) {
    if (!r2Key) return [];

    const queryEmbedding = await this.extractEmbeddingFromUrl(r2Key);
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
    const cacheKey = 'cache:public:events:list';
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err: any) {
      this.logger.error(`[Public Events Cache] Redis read failed:`, err.message);
    }

    const events = await this.prisma.event.findMany({
      where: { visibility: 'PUBLIC', status: 'PUBLISHED' },
      select: {
        id: true,
        title: true,
        slug: true,
        eventDate: true,
        location: true,
      },
    });

    try {
      await this.redis.set(cacheKey, JSON.stringify(events), 'EX', 300);
    } catch (err: any) {
      this.logger.error(`[Public Events Cache] Redis write failed:`, err.message);
    }

    return events;
  }

  async checkFaceSearchRateLimit(ip: string): Promise<void> {
    const key = `ratelimit:face-search:${ip}`;
    try {
      const attempts = await this.redis.incr(key);
      if (attempts === 1) {
        await this.redis.expire(key, 60); // 1 minute sliding window
      }
      if (attempts > 10) {
        throw new HttpException(
          'Too many face search requests from this IP. Please wait 1 minute before searching again.',
          HttpStatus.TOO_MANY_REQUESTS
        );
      }
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      // Fail-open if Redis encounters unexpected error
    }
  }

  async searchFacePublic(r2Key: string, eventId?: string, passcode?: string, clientIp?: string) {
    if (!r2Key) return [];

    // Enforce 10 searches/min rate limit per client IP to protect Modal GPU costs
    if (clientIp) {
      await this.checkFaceSearchRateLimit(clientIp);
    }

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

    const queryEmbedding = await this.extractEmbeddingFromUrl(r2Key);
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
      select: {
        id: true,
        eventId: true,
        filenameOriginal: true,
        r2KeyOriginal: true,
        r2KeyThumb: true,
        r2KeyPreview: true,
        fileSize: true,
        hasFaces: true,
        type: true,
        duration: true,
        event: {
          select: {
            id: true,
            slug: true,
            allowDownload: true,
            watermarkEnabled: true,
          }
        }
      },
    });

    return Promise.all(
      matchedPhotos.map(async (photo) => {
        const event = photo.event;
        const isWatermarked = event?.watermarkEnabled;

        let url = '';
        let thumbUrl = '';

        const hideDirectStorageUrl = isWatermarked || (event && !event.allowDownload);

        if (hideDirectStorageUrl) {
          const apiBase = process.env.PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_URL || 'https://api.fotosetgo.com';
          url = `${apiBase}/api/public/events/${event.slug}/photos/${photo.id}/view`;
          thumbUrl = `${apiBase}/api/public/events/${event.slug}/photos/${photo.id}/view?thumb=true`;
        } else {
          if (photo.type === 'VIDEO') {
            url = await this.getReadUrl(photo.r2KeyOriginal);
          } else {
            const fullKey = photo.r2KeyPreview || photo.r2KeyThumb || photo.r2KeyOriginal;
            url = await this.getReadUrl(fullKey);
          }
          thumbUrl = photo.r2KeyThumb ? await this.getReadUrl(photo.r2KeyThumb) : url;
        }

        return {
          id: photo.id,
          filenameOriginal: photo.filenameOriginal,
          url,
          thumbUrl,
          tags: photo.hasFaces ? ['face'] : ['general'],
          allowDownload: event ? event.allowDownload : true,
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

        // 3. Delete generated HD preview from R2 if it exists
        const previewKey = photo.r2KeyPreview || (photo.r2KeyOriginal ? photo.r2KeyOriginal.replace('/photos/', '/previews/').replace('/Photos/', '/previews/') : null);
        if (previewKey) {
          await this.s3Client.send(new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: previewKey
          })).catch(() => { });
        }
        await this.s3Client.send(new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: `${photographerId}/events/${photo.eventId}/previews/${photoId}.jpg`
        })).catch(() => { });
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
    await this.invalidateEventPhotosCache(photographerId, photo.eventId);

    return deleteResult;
  }


  async getGuestUploadLimitsStatus(slug: string) {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      include: {
        photographer: {
          include: {
            subscriptions: {
              where: { status: 'ACTIVE' },
              orderBy: { startsAt: 'desc' },
              take: 1,
              include: { package: true }
            }
          }
        }
      }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const photographer = event.photographer;
    const activeSub = photographer?.subscriptions?.[0];
    const pkgMb = activeSub?.package?.maxEventsStorageMb;
    const limitBytes = (pkgMb !== undefined && pkgMb !== null)
      ? BigInt(pkgMb) * BigInt(1024 * 1024)
      : (activeSub?.limitEventsBytes ?? activeSub?.limitBytes ?? BigInt(5000 * 1024 * 1024));

    const eventsUsedAgg = await this.prisma.photo.aggregate({
      where: { photographerId: photographer.id, status: { in: ['READY', 'UPLOADING', 'PENDING_APPROVAL'] }, isDeleted: false },
      _sum: { fileSize: true },
    });
    const eventsUsedBytes = eventsUsedAgg._sum.fileSize
      ? BigInt(eventsUsedAgg._sum.fileSize.toString())
      : BigInt(0);

    const remainingPhotographerBytes = limitBytes > eventsUsedBytes ? limitBytes - eventsUsedBytes : BigInt(0);

    const guestPhotosStats = await this.prisma.photo.aggregate({
      where: { eventId: event.id, isGuestUpload: true, isDeleted: false },
      _count: { id: true },
      _sum: { fileSize: true }
    });

    const maxFiles = event.maxGuestUploadFiles || 0;
    const eventGuestMaxStorage = event.maxGuestUploadStorage || BigInt(0);
    const effectiveMaxStorage = eventGuestMaxStorage < remainingPhotographerBytes ? eventGuestMaxStorage : remainingPhotographerBytes;

    return {
      allowGuestUploads: event.allowGuestUploads,
      maxGuestUploadFiles: maxFiles,
      maxGuestUploadStorage: effectiveMaxStorage.toString(),
      remainingPhotographerBytes: remainingPhotographerBytes.toString(),
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

    // 2.5 Portfolio Reels
    const portfolioReels = await this.prisma.portfolioReel.findMany({
      where: { photographerId },
      select: { r2Key: true, r2KeyThumb: true }
    });
    portfolioReels.forEach(r => {
      if (r.r2Key) {
        dbKeysSet.add(r.r2Key);
        const basename = r.r2Key.split('/').pop();
        if (basename) dbKeysSet.add(basename);
      }
      if (r.r2KeyThumb) {
        dbKeysSet.add(r.r2KeyThumb);
        const basename = r.r2KeyThumb.split('/').pop();
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
      addKey(photographer.portfolioAboutImageKey, 'portfolio');
      addKey(photographer.portfolioVideoUrl, 'portfolio');
      addKey(photographer.portfolioBtsUrl, 'portfolio');

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

    const cacheKey = `cache:photographer:${photographerId}:storage-breakdown`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err: any) {
      this.logger.error(`[StorageBreakdown Cache] Redis read failed: ${err.message}`);
    }

    // Instant PostgreSQL aggregation queries (1000x faster than live R2 network scanning)
    const [livePhotosSum, trashSum] = await Promise.all([
      this.prisma.photo.aggregate({
        where: { photographerId, isDeleted: false },
        _sum: { fileSize: true, thumbSizeBytes: true, previewSizeBytes: true },
      }),
      this.prisma.photo.aggregate({
        where: { photographerId, isDeleted: true },
        _sum: { fileSize: true, thumbSizeBytes: true, previewSizeBytes: true },
      }),
    ]);

    const liveEventsBytes =
      BigInt(livePhotosSum._sum.fileSize ? livePhotosSum._sum.fileSize.toString() : '0') +
      BigInt(livePhotosSum._sum.thumbSizeBytes ? livePhotosSum._sum.thumbSizeBytes.toString() : '0') +
      BigInt(livePhotosSum._sum.previewSizeBytes ? livePhotosSum._sum.previewSizeBytes.toString() : '0');

    const trashBytes =
      BigInt(trashSum._sum.fileSize ? trashSum._sum.fileSize.toString() : '0') +
      BigInt(trashSum._sum.thumbSizeBytes ? trashSum._sum.thumbSizeBytes.toString() : '0') +
      BigInt(trashSum._sum.previewSizeBytes ? trashSum._sum.previewSizeBytes.toString() : '0');

    const portfolioUsed = await this.getPortfolioStorageUsed(photographerId);
    const portfolioBytes = BigInt(portfolioUsed || 0);

    let brandingBytes = BigInt(0);
    if (photographer.studioLogoKey) brandingBytes += BigInt(200 * 1024);
    if (photographer.watermarkImageKey) brandingBytes += BigInt(200 * 1024);

    const totalBytes = liveEventsBytes + trashBytes + portfolioBytes + brandingBytes;

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

    const result = {
      eventsBytes: Number(liveEventsBytes),
      portfolioBytes: Number(portfolioBytes),
      brandingBytes: Number(brandingBytes),
      trashBytes: Number(trashBytes),
      wasteBytes: 0,
      wastePhotosSize: 0,
      wasteVideosSize: 0,
      wastePhotosCount: 0,
      wasteVideosCount: 0,
      totalBytes: Number(totalBytes),
      limitEventsBytes,
      limitPortfolioBytes,
      maxEventsStorageMb,
      maxPortfolioStorageMb,
      featurePortfolioWebsite,
      featureCustomBranding,
      isPortfolioEnabled,
    };

    try {
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 1800); // 30 mins TTL
    } catch (err: any) {
      this.logger.error(`[StorageBreakdown Cache] Redis write failed: ${err.message}`);
    }

    return result;
  }


  async invalidateStorageBreakdownCache(photographerId: string) {
    try {
      await this.redis.del(`cache:photographer:${photographerId}:storage-breakdown`);
      this.logger.log(`[StorageBreakdown Cache] Cleared storage breakdown cache for photographer: ${photographerId}`);
    } catch (err: any) {
      this.logger.error(`[StorageBreakdown Cache] Invalidation failed: ${err.message}`);
    }
  }

  async invalidateEventPhotosCache(photographerId: string, eventIds: string | string[]) {
    try {
      const idList = (Array.isArray(eventIds) ? eventIds : [eventIds]).filter(Boolean);
      const keys = [`cache:events:list:${photographerId}`];
      for (const eid of idList) {
        keys.push(`cache:event:detail:${eid}`);
      }
      await this.redis.del(...keys);
      this.logger.log(`[Cache Invalidate] Cleared event photo caches for event(s): ${idList.join(', ')}`);
    } catch (err: any) {
      this.logger.error(`[Cache Invalidate] Failed: ${err.message}`);
    }
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

    await this.invalidateStorageBreakdownCache(photographerId);
    await this.invalidateEventPhotosCache(photographerId, photo.eventId);

    return { success: true, message: 'Item moved to trash' };
  }

  // Soft delete multiple photos or videos (Batch Move to Trash)
  async batchSoftDeletePhotos(photographerId: string, photoIds: string[]) {
    const photos = await this.prisma.photo.findMany({
      where: { id: { in: photoIds }, photographerId },
      select: { eventId: true }
    });
    const eventIds = Array.from(new Set(photos.map(p => p.eventId)));

    await this.prisma.photo.updateMany({
      where: { id: { in: photoIds }, photographerId },
      data: { isDeleted: true, deletedAt: new Date() },
    });

    await this.invalidateStorageBreakdownCache(photographerId);
    await this.invalidateEventPhotosCache(photographerId, eventIds);

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

    await this.invalidateStorageBreakdownCache(photographerId);
    await this.invalidateEventPhotosCache(photographerId, [photo.eventId, finalEventId]);

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
    await this.invalidateStorageBreakdownCache(photographerId);
    const breakdown = await this.getStorageBreakdown(photographerId);
    const actualBytes = BigInt(breakdown.eventsBytes + breakdown.trashBytes + breakdown.portfolioBytes + breakdown.brandingBytes);

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

    // Collect candidate R2 keys for deletion
    const candidateOriginalKeys = new Set<string>();
    const candidateThumbKeys = new Set<string>();
    const candidatePreviewKeys = new Set<string>();

    for (const photo of photos) {
      if (photo.r2KeyOriginal) candidateOriginalKeys.add(photo.r2KeyOriginal);
      if (photo.r2KeyThumb) candidateThumbKeys.add(photo.r2KeyThumb);
      if (photo.r2KeyPreview) candidatePreviewKeys.add(photo.r2KeyPreview);
    }

    // Find all other photo records in the DB that are NOT being deleted
    // to check if any of these candidate keys are still referenced in another event
    const remainingPhotos = await this.prisma.photo.findMany({
      where: {
        id: { notIn: photoIds },
        OR: [
          { r2KeyOriginal: { in: Array.from(candidateOriginalKeys) } },
          { r2KeyThumb: { in: Array.from(candidateThumbKeys) } },
          { r2KeyPreview: { in: Array.from(candidatePreviewKeys) } }
        ]
      },
      select: { r2KeyOriginal: true, r2KeyThumb: true, r2KeyPreview: true }
    });

    const activeReferencedKeys = new Set<string>();
    for (const rp of remainingPhotos) {
      if (rp.r2KeyOriginal) activeReferencedKeys.add(rp.r2KeyOriginal);
      if (rp.r2KeyThumb) activeReferencedKeys.add(rp.r2KeyThumb);
      if (rp.r2KeyPreview) activeReferencedKeys.add(rp.r2KeyPreview);
    }

    // Only delete physical files from R2 if no other photo record references them!
    const keysToDelete: string[] = [];
    for (const photo of photos) {
      if (photo.r2KeyOriginal && !activeReferencedKeys.has(photo.r2KeyOriginal)) {
        keysToDelete.push(photo.r2KeyOriginal);
        keysToDelete.push(photo.r2KeyOriginal.replace('/photos/', '/previews/').replace('/Photos/', '/previews/'));
      }
      if (photo.r2KeyThumb && !activeReferencedKeys.has(photo.r2KeyThumb)) {
        keysToDelete.push(photo.r2KeyThumb);
      }
      if (photo.r2KeyPreview && !activeReferencedKeys.has(photo.r2KeyPreview)) {
        keysToDelete.push(photo.r2KeyPreview);
      }
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

    await this.invalidateStorageBreakdownCache(photographerId);
    const eventIds = Array.from(new Set(photos.map(p => p.eventId)));
    await this.invalidateEventPhotosCache(photographerId, eventIds);

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

    await this.invalidateStorageBreakdownCache(photographerId);
    const restoreEventIds = Array.from(new Set(photos.map(p => p.eventId)));
    if (targetEventId) restoreEventIds.push(targetEventId);
    await this.invalidateEventPhotosCache(photographerId, restoreEventIds);

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

    await this.invalidateStorageBreakdownCache(photographerId);

    return { clearedCount: deletedCount };
  }


  async batchMove(photographerId: string, photoIds: string[], targetEventId: string) {

    const event = await this.prisma.event.findFirst({
      where: { id: targetEventId, photographerId }
    });
    if (!event) {
      throw new NotFoundException('Target event not found');
    }

    const photos = await this.prisma.photo.findMany({
      where: { id: { in: photoIds }, photographerId },
      select: { eventId: true }
    });
    const sourceEventIds = Array.from(new Set(photos.map(p => p.eventId)));

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

    await this.invalidateStorageBreakdownCache(photographerId);
    await this.invalidateEventCache(targetEventId);
    for (const srcId of sourceEventIds) {
      await this.invalidateEventCache(srcId);
    }
    await this.invalidateEventPhotosCache(photographerId, [targetEventId, ...sourceEventIds]);

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

    if (photosToCopy.length === 0) {
      return { success: true, count: 0 };
    }

    const newPhotosData: any[] = [];
    const photoIdMap = new Map<string, string>(); // oldPhotoId -> newPhotoId
    let sizeAccumulator = BigInt(0);

    for (const p of photosToCopy) {
      const newPhotoId = uuidv4();
      photoIdMap.set(p.id, newPhotoId);

      const thumbSize = p.thumbSizeBytes || BigInt(0);
      const previewSize = p.previewSizeBytes || BigInt(0);
      const originalSize = p.fileSize || BigInt(0);

      newPhotosData.push({
        id: newPhotoId,
        eventId: targetEventId,
        photographerId,
        filenameOriginal: p.filenameOriginal,
        filenameStored: p.filenameStored,
        r2KeyOriginal: p.r2KeyOriginal,
        r2KeyPreview: p.r2KeyPreview,
        r2KeyThumb: p.r2KeyThumb,
        mimeType: p.mimeType,
        fileSize: originalSize,
        thumbSizeBytes: thumbSize,
        previewSizeBytes: previewSize,
        status: p.status,
        thumbnailStatus: p.thumbnailStatus || 'READY',
        faceScanStatus: p.faceScanStatus || 'READY',
        type: p.type || 'IMAGE',
        duration: p.duration || 0,
        hasFaces: p.hasFaces,
        faceCount: p.faceCount
      });

      // Total storage for this photo = Original + Thumb + Preview
      sizeAccumulator += (originalSize + thumbSize + previewSize);
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

    // Duplicate Face Embeddings for all newly copied photos so AI Face Search works immediately
    try {
      interface RawCopiedEmbedding {
        photoId: string;
        faceIndex: number;
        bboxX: number;
        bboxY: number;
        bboxW: number;
        bboxH: number;
        confidence: number;
        embeddingStr: string;
        timestamp: number | null;
      }
      const oldPhotoIds = photosToCopy.map(p => p.id);
      const oldEmbeddings = await this.prisma.$queryRaw<RawCopiedEmbedding[]>`
        SELECT "photoId", "faceIndex", "bboxX", "bboxY", "bboxW", "bboxH", "confidence", "embedding"::text as "embeddingStr", "timestamp"
        FROM face_embeddings
        WHERE "photoId" IN (${Prisma.join(oldPhotoIds)})
      `.catch(() => [] as RawCopiedEmbedding[]);

      if (oldEmbeddings && oldEmbeddings.length > 0) {
        const values = oldEmbeddings
          .filter((e: RawCopiedEmbedding) => photoIdMap.has(e.photoId))
          .map(e => {
            const newPhotoId = photoIdMap.get(e.photoId)!;
            const newId = uuidv4();
            const tsVal = e.timestamp !== null && e.timestamp !== undefined ? e.timestamp : 0;
            return `('${newId}', '${newPhotoId}', '${targetEventId}', '${photographerId}', ${e.faceIndex}, ${e.bboxX}, ${e.bboxY}, ${e.bboxW}, ${e.bboxH}, ${e.confidence}, '${e.embeddingStr}'::vector, NULL, ${tsVal})`;
          })
          .join(',');

        if (values.length > 0) {
          await this.prisma.$executeRawUnsafe(`
            INSERT INTO face_embeddings ("id", "photoId", "eventId", "photographerId", "faceIndex", "bboxX", "bboxY", "bboxW", "bboxH", "confidence", "embedding", "clusterId", "timestamp")
            VALUES ${values}
          `);
        }
      }
    } catch (embErr: any) {
      this.logger.error(`[batchCopy] Failed to duplicate face embeddings for copied photos: ${embErr.message}`);
    }

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

    // Invalidate Storage Breakdown Cache so real-time storage updates instantly!
    await this.invalidateStorageBreakdownCache(photographerId);
    await this.invalidateEventCache(targetEventId);
    await this.invalidateEventPhotosCache(photographerId, targetEventId);

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
    const cacheKey = `cache:public:event:${slug}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      console.error('[StorageService] Redis get failed inside getPublicEventBySlug:', err);
    }

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
    let hasWatermark = false;
    let hasBulkDownload = false;
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
      hasWatermark = activeSub?.package ? activeSub.package.featureWatermark : false;
      hasBulkDownload = activeSub?.package ? activeSub.package.featureBulkDownload : false;
    }

    const watermarkEnabled = hasWatermark ? event.watermarkEnabled : false;

    const result = {
      id: event.id,
      title: event.title,
      slug: event.slug,
      eventDate: event.eventDate,
      location: event.location,
      allowDownload: event.allowDownload,
      allowBulkDownload: hasBulkDownload,
      allowFavorites: hasClientSelection ? Boolean(event.allowFavorites) : false,
      faceSearchEnabled: hasAiFaceSearch ? Boolean(event.faceSearchEnabled) : false,
      watermarkEnabled,
      maxFavorites: event.maxFavorites,
      requiresPasscode,
      themeKey: event.themeKey,
      applyThemeToClientGallery: event.applyThemeToClientGallery,
      allowGuestUploads: hasGuestUpload ? Boolean(event.allowGuestUploads) : false,
      maxGuestUploadFiles: event.maxGuestUploadFiles || 0,
      maxGuestUploadStorage: event.maxGuestUploadStorage ? event.maxGuestUploadStorage.toString() : '0',
      photosCount: event._count.photos,
      photos: !requiresPasscode ? await this.getPublicPhotos(event.id, event.slug) : [],
      photographerBranding: event.photographer ? {
        id: event.photographer.id,
        studioLogoKey: hasBranding ? event.photographer.studioLogoKey : null,
        studioSubdomain: hasBranding ? event.photographer.studioSubdomain : null,
        instagramUrl: hasBranding ? event.photographer.instagramUrl : null,
        facebookUrl: hasBranding ? event.photographer.facebookUrl : null,
        whatsappPhone: hasBranding ? event.photographer.whatsappPhone : null,
        seoTitle: hasBranding ? event.photographer.seoTitle : null,
        seoDescription: hasBranding ? event.photographer.seoDescription : null,
        hidePoweredBy: hasBranding ? event.photographer.hidePoweredBy : false,
        customFooterText: hasBranding ? event.photographer.customFooterText : null,
        studioName: event.photographer.studioName || 'Studio',
        watermarkType: watermarkEnabled ? event.photographer.watermarkType : 'NONE',
        watermarkText: watermarkEnabled ? event.photographer.watermarkText : 'PhotosetGo',
        watermarkPosition: watermarkEnabled ? event.photographer.watermarkPosition : 'CENTER',
        watermarkOpacity: watermarkEnabled ? event.photographer.watermarkOpacity : 50,
        watermarkSize: watermarkEnabled ? event.photographer.watermarkSize : 'MEDIUM',
        watermarkImageUrl: (watermarkEnabled && event.photographer.watermarkImageKey)
          ? await this.getReadUrl(event.photographer.watermarkImageKey)
          : null,
      } : null
    };

    try {
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 600); // 10 minutes cache TTL
    } catch (err) {
      console.error('[StorageService] Redis set failed inside getPublicEventBySlug:', err);
    }

    return result;
  }

  async getPublicEventPhotos(slug: string, passcode?: string, limit?: number, cursor?: string, clientIp?: string) {
    const ip = clientIp || '127.0.0.1';
    const lockKey = `lock:passcode:${slug}:${ip}`;
    const failKey = `fail:passcode:${slug}:${ip}`;

    // 1. Check if IP is currently locked out from this event due to brute-force attempts
    try {
      const isLocked = await this.redis.get(lockKey);
      if (isLocked) {
        const ttl = await this.redis.ttl(lockKey);
        const mins = Math.max(1, Math.ceil((ttl > 0 ? ttl : 300) / 60));
        throw new ForbiddenException(`Too many failed attempts. Access is locked. Please try again after ${mins} minute${mins === 1 ? '' : 's'}.`);
      }
    } catch (err: any) {
      if (err instanceof ForbiddenException) throw err;
    }

    const cacheKey = `cache:public:photos:${slug}:${passcode || 'none'}:${limit || 'all'}:${cursor || 'start'}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      console.error('[StorageService] Redis get failed inside getPublicEventPhotos:', err);
    }

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
        // Increment failed attempts counter in Redis with 5-min sliding expiration
        try {
          const fails = await this.redis.incr(failKey);
          if (fails === 1) {
            await this.redis.expire(failKey, 300); // 5 minutes window
          }
          const remaining = Math.max(0, 5 - fails);
          if (fails >= 5) {
            await this.redis.set(lockKey, '1', 'EX', 300); // Lockout IP for 5 minutes
            throw new ForbiddenException('Too many incorrect passcode attempts. Your access has been locked for 5 minutes. Please try again later.');
          }
          throw new UnauthorizedException(`Invalid passcode. ${remaining} attempt${remaining === 1 ? '' : 's'} remaining.`);
        } catch (err: any) {
          if (err instanceof ForbiddenException || err instanceof UnauthorizedException) throw err;
        }
        throw new UnauthorizedException('Invalid event passcode');
      } else {
        // Correct passcode supplied: clear any failed counter
        this.redis.del(failKey).catch(() => { });
      }
    }

    const results = await this.getPublicPhotos(event.id, event.slug, limit, cursor, event);

    try {
      await this.redis.set(cacheKey, JSON.stringify(results), 'EX', 600); // 10 minutes cache TTL
    } catch (err) {
      console.error('[StorageService] Redis set failed inside getPublicEventPhotos:', err);
    }

    return results;
  }

  async getPublicPhotos(eventId: string, slug: string, limit?: number, cursor?: string, existingEvent?: any) {
    const event = existingEvent || await this.prisma.event.findUnique({
      where: { id: eventId },
      select: {
        id: true,
        slug: true,
        allowDownload: true,
        watermarkEnabled: true,
      }
    });

    const queryArgs: any = {
      where: { eventId, status: 'READY', isDeleted: false },
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' }
      ],
      select: {
        id: true,
        filenameOriginal: true,
        r2KeyOriginal: true,
        r2KeyPreview: true,
        r2KeyThumb: true,
        type: true,
        duration: true,
      }
    };

    if (limit && limit > 0) {
      queryArgs.take = Number(limit);
    }
    if (cursor) {
      queryArgs.cursor = { id: cursor };
      queryArgs.skip = 1;
    }

    const photos = await this.prisma.photo.findMany(queryArgs);

    return Promise.all(
      photos.map(async (photo) => {
        let url = '';
        let thumbUrl = '';

        const hideDirectStorageUrl = event && !event.allowDownload;

        if (hideDirectStorageUrl) {
          const apiBase = process.env.PUBLIC_API_URL || process.env.NEXT_PUBLIC_API_URL || 'https://api.fotosetgo.com';
          url = `${apiBase}/api/public/events/${slug}/photos/${photo.id}/view`;
        } else {
          // Videos must always serve original file; images serve 800px preview or thumb
          if (photo.type === 'VIDEO') {
            url = await this.getReadUrl(photo.r2KeyOriginal);
          } else {
            const fullKey = photo.r2KeyPreview || photo.r2KeyThumb || photo.r2KeyOriginal;
            url = await this.getReadUrl(fullKey);
          }
        }
        // Always serve low-res thumbnails directly from CDN for instant loading speed
        thumbUrl = photo.r2KeyThumb ? await this.getReadUrl(photo.r2KeyThumb) : url;

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

  private favoritesSyncTimers = new Map<string, NodeJS.Timeout>();

  scheduleFavoritesDbSync(eventId: string) {
    if (this.favoritesSyncTimers.has(eventId)) {
      clearTimeout(this.favoritesSyncTimers.get(eventId)!);
    }

    const timer = setTimeout(async () => {
      this.favoritesSyncTimers.delete(eventId);
      await this.flushFavoritesToDb(eventId);
    }, 3000); // 3-second debounce batch flush

    this.favoritesSyncTimers.set(eventId, timer);
  }

  async flushFavoritesToDb(eventId: string) {
    try {
      const setKey = `event:favorites:${eventId}`;
      const members = await this.redis.smembers(setKey);
      const photoIds = members.filter(id => id && id !== '__INIT__');

      if (photoIds.length > 0) {
        const data = photoIds.map(photoId => ({
          eventId,
          photoId,
          clientSessionId: 'SHARED_SELECTION'
        }));

        await this.prisma.$transaction([
          this.prisma.favoritePhoto.deleteMany({ where: { eventId } }),
          this.prisma.favoritePhoto.createMany({ data })
        ]);
      } else {
        await this.prisma.favoritePhoto.deleteMany({ where: { eventId } });
      }

      await this.redis.srem('event:favorites:dirty_events', eventId);
    } catch (err: any) {
      this.logger.error(`[FavoritesSync] Error persisting favorites for event ${eventId}: ${err.message}`);
    }
  }

  async toggleClientFavorite(
    slug: string,
    photoId: string,
    action?: 'ADD' | 'REMOVE' | 'TOGGLE'
  ): Promise<{ selected: boolean; count: number; selectedIds: string[]; maxFavorites?: number }> {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      select: { id: true, photographerId: true, allowFavorites: true, maxFavorites: true }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (!event.allowFavorites) {
      throw new BadRequestException('Favorites selection is not enabled for this event.');
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

    const setKey = `event:favorites:${event.id}`;

    // Ensure Redis set is populated from DB on first access
    const exists = await this.redis.exists(setKey);
    if (!exists) {
      const dbFavs = await this.prisma.favoritePhoto.findMany({
        where: { eventId: event.id },
        select: { photoId: true }
      });
      if (dbFavs.length > 0) {
        const ids = dbFavs.map(f => f.photoId);
        await this.redis.sadd(setKey, ...ids);
      } else {
        await this.redis.sadd(setKey, '__INIT__');
      }
      await this.redis.expire(setKey, 86400 * 7);
    }

    const isMember = await this.redis.sismember(setKey, photoId);
    let isSelected: boolean;

    if (action === 'ADD' || (action !== 'REMOVE' && !isMember)) {
      // Check maximum limit if photographer set one
      if (event.maxFavorites && event.maxFavorites > 0) {
        let currentCount = await this.redis.scard(setKey);
        const hasMarker = await this.redis.sismember(setKey, '__INIT__');
        if (hasMarker) currentCount -= 1;

        if (currentCount >= event.maxFavorites) {
          throw new BadRequestException(`Selection limit reached. Maximum ${event.maxFavorites} photos allowed.`);
        }
      }

      await this.redis.sadd(setKey, photoId);
      isSelected = true;
    } else {
      await this.redis.srem(setKey, photoId);
      isSelected = false;
    }

    await this.redis.sadd('event:favorites:dirty_events', event.id);
    this.scheduleFavoritesDbSync(event.id);

    const allMembers = await this.redis.smembers(setKey);
    const selectedIds = allMembers.filter(id => id && id !== '__INIT__');

    return {
      selected: isSelected,
      count: selectedIds.length,
      selectedIds,
      maxFavorites: event.maxFavorites
    };
  }

  async saveClientFavorites(
    slug: string,
    photoIds: string[]
  ) {
    const event = await this.prisma.event.findUnique({
      where: { slug }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const setKey = `event:favorites:${event.id}`;
    await this.redis.del(setKey);
    if (photoIds.length > 0) {
      await this.redis.sadd(setKey, ...photoIds);
    } else {
      await this.redis.sadd(setKey, '__INIT__');
    }
    await this.redis.expire(setKey, 86400 * 7);

    this.scheduleFavoritesDbSync(event.id);
    return { success: true, count: photoIds.length };
  }

  async getClientFavorites(slug: string): Promise<string[]> {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      select: { id: true }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const setKey = `event:favorites:${event.id}`;
    const exists = await this.redis.exists(setKey);
    if (exists) {
      const members = await this.redis.smembers(setKey);
      return members.filter(id => id && id !== '__INIT__');
    }

    const favorites = await this.prisma.favoritePhoto.findMany({
      where: { eventId: event.id },
      select: { photoId: true }
    });

    const results = Array.from(new Set(favorites.map(f => f.photoId)));
    if (results.length > 0) {
      await this.redis.sadd(setKey, ...results);
    } else {
      await this.redis.sadd(setKey, '__INIT__');
    }
    await this.redis.expire(setKey, 86400 * 7);
    return results;
  }

  async getPublicEventInit(slug: string, passcode?: string, clientIp?: string) {
    const event = await this.getPublicEventBySlug(slug);
    if (!event) throw new NotFoundException('Event not found');

    const photos = await this.getPublicEventPhotos(slug, passcode, 60, undefined, clientIp);
    const favorites = await this.getClientFavorites(slug).catch(() => []);

    return {
      event,
      photos,
      favorites
    };
  }

  async getEventFavorites(photographerId: string, eventId: string) {
    // Verify event ownership
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, photographerId }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    // Flush any pending sync so DB has latest
    if (this.favoritesSyncTimers.has(eventId)) {
      clearTimeout(this.favoritesSyncTimers.get(eventId)!);
      this.favoritesSyncTimers.delete(eventId);
      await this.flushFavoritesToDb(eventId);
    }

    const favorites = await this.prisma.favoritePhoto.findMany({
      where: { eventId },
      include: {
        photo: true
      },
      orderBy: { createdAt: 'desc' }
    });

    if (favorites.length === 0) return [];

    const photosList: any[] = [];
    for (const fav of favorites) {
      if (!fav.photo) continue;
      const previewKey = fav.photo.type === 'VIDEO'
        ? fav.photo.r2KeyOriginal
        : (fav.photo.r2KeyPreview || fav.photo.r2KeyThumb || fav.photo.r2KeyOriginal);
      const url = await this.getReadUrl(fav.photo.r2KeyOriginal);
      const previewUrl = previewKey ? await this.getReadUrl(previewKey) : url;
      const thumbUrl = fav.photo.r2KeyThumb
        ? await this.getReadUrl(fav.photo.r2KeyThumb)
        : (previewUrl || url);

      photosList.push({
        id: fav.photo.id,
        filenameOriginal: fav.photo.filenameOriginal,
        name: fav.photo.filenameOriginal,
        url,
        previewUrl,
        thumbUrl,
        type: fav.photo.type || 'IMAGE',
        duration: fav.photo.duration || 0,
        fileSize: Number(fav.photo.fileSize)
      });
    }

    return [{
      clientSessionId: 'SHARED_SELECTION',
      photos: photosList
    }];
  }

  async getWatermarkedImageStream(slug: string, photoId: string, isThumb: boolean, isDownload: boolean = false) {
    const cacheKey = `cache:public:view:${photoId}:${isThumb ? '1' : '0'}:${isDownload ? '1' : '0'}`;
    try {
      const cachedUrl = await this.redis.get(cacheKey);
      if (cachedUrl) {
        return { redirectUrl: cachedUrl };
      }
    } catch (err: any) {
      this.logger.error(`[getWatermarkedImageStream] Redis get error: ${err.message}`);
    }

    const event = await this.prisma.event.findUnique({
      where: { slug },
      select: { id: true, allowDownload: true }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      select: { eventId: true, type: true, filenameOriginal: true, r2KeyPreview: true, r2KeyThumb: true, r2KeyOriginal: true }
    });

    if (!photo || photo.eventId !== event.id) {
      throw new NotFoundException('Photo not found');
    }

    let directUrl: string;
    if (isDownload) {
      if (!event.allowDownload) {
        throw new ForbiddenException('Download is not enabled for this gallery');
      }
      directUrl = await this.getDownloadUrl(photo.r2KeyOriginal, photo.filenameOriginal);
    } else {
      // If thumb is requested (for video or image), always serve the .jpg thumbnail!
      // If full preview is requested: videos serve original video file, images serve 1920px preview or original
      const readKey = isThumb
        ? (photo.r2KeyThumb || photo.r2KeyOriginal)
        : (photo.type === 'VIDEO' ? photo.r2KeyOriginal : (photo.r2KeyPreview || photo.r2KeyThumb || photo.r2KeyOriginal));
      directUrl = await this.getReadUrl(readKey);
    }

    try {
      await this.redis.setex(cacheKey, 300, directUrl); // Cache for 5 minutes
    } catch (err: any) {
      this.logger.error(`[getWatermarkedImageStream] Redis set error: ${err.message}`);
    }

    return { redirectUrl: directUrl };
  }

  async streamPhotoToResponse(slug: string, photoId: string, isThumb: boolean, isDownload: boolean, res: any) {
    const event = await this.prisma.event.findUnique({
      where: { slug },
      select: { id: true, allowDownload: true }
    });
    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const photo = await this.prisma.photo.findUnique({
      where: { id: photoId },
      select: { eventId: true, type: true, filenameOriginal: true, r2KeyPreview: true, r2KeyThumb: true, r2KeyOriginal: true }
    });
    if (!photo || photo.eventId !== event.id) {
      throw new NotFoundException('Photo not found');
    }

    if (isDownload && !event.allowDownload) {
      throw new ForbiddenException('Download is not enabled for this gallery');
    }

    const readKey = isDownload
      ? photo.r2KeyOriginal
      : (isThumb ? (photo.r2KeyThumb || photo.r2KeyOriginal) : (photo.type === 'VIDEO' ? photo.r2KeyOriginal : (photo.r2KeyPreview || photo.r2KeyThumb || photo.r2KeyOriginal)));

    try {
      const getCmd = new GetObjectCommand({
        Bucket: this.bucketName,
        Key: readKey
      });
      const s3Res = await this.s3Client.send(getCmd);
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', '*');
      res.setHeader('Content-Type', s3Res.ContentType || 'image/jpeg');
      if (s3Res.ContentLength) {
        res.setHeader('Content-Length', s3Res.ContentLength);
      }
      if (isDownload) {
        res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(photo.filenameOriginal || 'photo.jpg')}"`);
      }
      return (s3Res.Body as any).pipe(res);
    } catch (err: any) {
      this.logger.error(`[streamPhotoToResponse] S3 pipe error for ${readKey}: ${err.message}`);
      throw new NotFoundException('Failed to stream photo');
    }
  }

  async getBulkDownloadUrls(slug: string, photoIds?: string[], passcode?: string, clientIp?: string) {
    const ip = clientIp || '127.0.0.1';
    const lockKey = `lock:passcode:${slug}:${ip}`;
    const failKey = `fail:passcode:${slug}:${ip}`;

    try {
      const isLocked = await this.redis.get(lockKey);
      if (isLocked) {
        const ttl = await this.redis.ttl(lockKey);
        const mins = Math.max(1, Math.ceil((ttl > 0 ? ttl : 300) / 60));
        throw new ForbiddenException(`Too many failed attempts. Access is locked. Please try again after ${mins} minute${mins === 1 ? '' : 's'}.`);
      }
    } catch (err: any) {
      if (err instanceof ForbiddenException) throw err;
    }

    const event = await this.prisma.event.findUnique({
      where: { slug },
      select: { id: true, title: true, status: true, visibility: true, passcode: true, allowDownload: true }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    if (event.status === 'DRAFT') {
      throw new BadRequestException('This event is currently in draft.');
    }

    if (!event.allowDownload) {
      throw new ForbiddenException('Download is not enabled for this event gallery.');
    }

    const requiresPasscode = event.visibility === 'PRIVATE' || (event.passcode && event.passcode !== '');
    if (requiresPasscode) {
      if (!passcode || passcode !== event.passcode) {
        try {
          const fails = await this.redis.incr(failKey);
          if (fails === 1) await this.redis.expire(failKey, 300);
          if (fails >= 5) {
            await this.redis.set(lockKey, '1', 'EX', 300);
            throw new ForbiddenException('Too many incorrect passcode attempts. Your access has been locked for 5 minutes.');
          }
        } catch (err: any) {
          if (err instanceof ForbiddenException) throw err;
        }
        throw new UnauthorizedException('Invalid event passcode');
      } else {
        this.redis.del(failKey).catch(() => {});
      }
    }

    const where: any = { eventId: event.id, status: 'READY', isDeleted: false };
    if (photoIds && photoIds.length > 0) {
      where.id = { in: photoIds };
    }

    const photos = await this.prisma.photo.findMany({
      where,
      select: {
        id: true,
        filenameOriginal: true,
        r2KeyOriginal: true,
        type: true,
        duration: true,
        fileSize: true,
      },
      orderBy: [
        { createdAt: 'desc' },
        { id: 'desc' }
      ]
    });

    const downloadList = await Promise.all(
      photos.map(async (photo) => {
        const downloadUrl = await this.getDownloadUrl(photo.r2KeyOriginal, photo.filenameOriginal);
        return {
          id: photo.id,
          filenameOriginal: photo.filenameOriginal,
          downloadUrl,
          type: photo.type || 'IMAGE',
          duration: photo.duration || 0,
          fileSize: Number(photo.fileSize || 0)
        };
      })
    );

    return {
      eventSlug: slug,
      eventTitle: event.title,
      totalCount: downloadList.length,
      photos: downloadList
    };
  }

  async getWatermarkImageStreamByPhotographerId(photographerId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId }
    });

    if (!photographer || !photographer.watermarkImageKey) {
      // Fallback to default logo
      const fs = require('fs');
      const path = require('path');
      const logoPath = path.join(process.cwd(), 'assets', 'logo', 'fotosetgo.png');
      if (fs.existsSync(logoPath)) {
        return {
          buffer: fs.readFileSync(logoPath),
          contentType: 'image/png'
        };
      }
      throw new NotFoundException('Watermark not found');
    }

    const directUrl = await this.getReadUrl(photographer.watermarkImageKey);
    return { redirectUrl: directUrl };
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

    const isPng = file.mimetype === 'image/png' || file.originalname?.toLowerCase().endsWith('.png');
    if (!isPng) {
      throw new BadRequestException('Only PNG images (.png) are allowed for Studio Logo');
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
        instagramUrl: data.instagramUrl || null,
        facebookUrl: data.facebookUrl || null,
        whatsappPhone: data.whatsappPhone || null,
        seoTitle: data.seoTitle || null,
        seoDescription: data.seoDescription || null,
        hidePoweredBy: data.hidePoweredBy ?? false,
        customFooterText: data.customFooterText || null,
      }
    });

    // Invalidate caches for all events belonging to this photographer to sync branding updates immediately
    try {
      const events = await this.prisma.event.findMany({
        where: { photographerId: photographer.id },
        select: { id: true, slug: true }
      });

      const keysToInvalidate: string[] = [
        `user:jwt:${userId}`,
        `cache:events:list:${photographer.id}`,
        `cache:portfolio:public:${photographer.slug}`
      ];

      if (photographer.studioSubdomain) {
        keysToInvalidate.push(`cache:portfolio:public:${photographer.studioSubdomain}`);
      }
      if (data.studioSubdomain) {
        keysToInvalidate.push(`cache:portfolio:public:${data.studioSubdomain}`);
      }

      for (const ev of events) {
        keysToInvalidate.push(
          `cache:event:detail:${ev.id}`,
          `cache:public:event:${ev.slug}`,
          `cache:public:event:limits:${ev.slug}`
        );
        const matchKeys = await this.scanKeys(`cache:public:photos:${ev.slug}:*`);
        if (matchKeys && matchKeys.length > 0) {
          keysToInvalidate.push(...matchKeys);
        }
      }

      if (keysToInvalidate.length > 0) {
        await this.redis.del(...keysToInvalidate);
        this.logger.log(`[Cache Invalidation] Cleared ${keysToInvalidate.length} cache keys due to branding settings update.`);
      }
    } catch (cacheErr: any) {
      this.logger.error(`[Cache Invalidation] Failed to clear caches on branding update: ${cacheErr.message}`);
    }

    // Automatically sync BusinessCard slug with the new studioSubdomain
    if (data.studioSubdomain) {
      this.prisma.businessCard.updateMany({
        where: { photographerId: photographer.id },
        data: { slug: data.studioSubdomain }
      }).catch(err => console.error('Failed to sync business card slug:', err));
    }

    return updatedPhotographer;
  }

  async getFreshVideoUrl(urlOrKey: string | null): Promise<string | null> {
    if (!urlOrKey) return null;
    try {
      // 1. If it's already a raw R2 key (e.g. "uuid/portfolio/hero-video/...")
      if (!urlOrKey.startsWith('http://') && !urlOrKey.startsWith('https://') && urlOrKey.includes('/portfolio/')) {
        return await this.getReadUrl(urlOrKey);
      }
      // 2. If it's a full URL containing a portfolio key
      const decodedUrl = decodeURIComponent(urlOrKey);
      const match = decodedUrl.match(/((?:[a-f0-9-]+\/)?portfolio\/(?:hero-video|bts|reels|photos|about)[^?#]+)/i)
        || decodedUrl.match(/((?:[a-f0-9-]+\/)?portfolio\/[^?#]+)/i);
      if (match) {
        const key = match[1];
        return await this.getReadUrl(key);
      }
    } catch (err) {
      console.error('[StorageService] Failed to parse video url key:', urlOrKey, err);
    }
    return urlOrKey;
  }


  async getPortfolioSettings(userId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId },
      include: {
        portfolioPhotos: {
          orderBy: { sortOrder: 'asc' }
        },
        portfolioReels: {
          orderBy: { createdAt: 'desc' }
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

    const reels = await Promise.all(
      (photographer.portfolioReels || []).map(async (r) => {
        const url = await this.getReadUrl(r.r2Key);
        const thumbUrl = r.r2KeyThumb ? await this.getReadUrl(r.r2KeyThumb) : null;
        return {
          id: r.id,
          title: r.title,
          category: r.category || 'Highlights',
          r2Key: r.r2Key,
          r2KeyThumb: r.r2KeyThumb,
          url,
          thumbUrl,
          viewsCount: r.viewsCount,
          createdAt: r.createdAt
        };
      })
    );

    const aboutImageUrl = photographer.portfolioAboutImageKey
      ? await this.getReadUrl(photographer.portfolioAboutImageKey)
      : null;

    const freshVideoUrl = await this.getFreshVideoUrl(photographer.portfolioVideoUrl);
    const freshThumbUrl = await this.getFreshVideoUrl(photographer.portfolioVideoThumbUrl);
    const freshBtsUrl = await this.getFreshVideoUrl(photographer.portfolioBtsUrl);
    const freshBtsThumbUrl = await this.getFreshVideoUrl(photographer.portfolioBtsThumbUrl);

    return {
      portfolioEnabled: photographer.portfolioEnabled,
      portfolioTheme: photographer.portfolioTheme,
      portfolioHeroTitle: photographer.portfolioHeroTitle,
      portfolioHeroSubtitle: photographer.portfolioHeroSubtitle,
      portfolioAboutTitle: photographer.portfolioAboutTitle,
      portfolioAboutText: photographer.portfolioAboutText,
      portfolioAboutImageUrl: aboutImageUrl,
      portfolioMapEmbed: photographer.portfolioMapEmbed,
      portfolioPackages: photographer.portfolioPackages,
      portfolioServices: photographer.portfolioServices,
      portfolioStats: photographer.portfolioStats,
      portfolioFaqs: photographer.portfolioFaqs,
      portfolioVideoUrl: freshVideoUrl,
      portfolioVideoThumbUrl: freshThumbUrl,
      portfolioProcess: photographer.portfolioProcess,
      portfolioBtsUrl: freshBtsUrl,
      portfolioBtsThumbUrl: freshBtsThumbUrl,
      portfolioEquipment: photographer.portfolioEquipment,
      portfolioDestinations: photographer.portfolioDestinations,
      portfolioBookingPolicy: photographer.portfolioBookingPolicy,
      portfolioPress: photographer.portfolioPress,
      portfolioReels: reels,
      portfolioStyles: photographer.portfolioStyles,
      portfolioPhone: photographer.portfolioPhone,
      portfolioEmail: photographer.portfolioEmail,
      portfolioAddress: photographer.portfolioAddress,
      portfolioWhatsapp: photographer.portfolioWhatsapp,
      portfolioPhotos: photos,
      studioSubdomain: photographer.studioSubdomain,
      studioName: photographer.studioName,
      instagramUrl: photographer.instagramUrl,
      facebookUrl: photographer.facebookUrl,
      whatsappPhone: photographer.whatsappPhone,
      studioLogoKey: photographer.studioLogoKey,
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
      // 1. Delete replaced old Teaser Video & Thumbnail from R2 if new video is uploaded
      if (data.portfolioVideoUrl !== undefined && photographer.portfolioVideoUrl && photographer.portfolioVideoUrl !== data.portfolioVideoUrl) {
        const oldKey = this.extractR2KeyFromUrlOrKey(photographer.portfolioVideoUrl, photographer.id);
        if (oldKey) {
          try {
            await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: oldKey }));
            this.urlCache.delete(oldKey);
            this.logger.log(`[StorageService] Deleted replaced old Teaser Video from R2: ${oldKey}`);
          } catch (err: any) {
            this.logger.error(`[StorageService] Failed to delete replaced Teaser Video: ${err.message}`);
          }
        }
      }

      if (data.portfolioVideoThumbUrl !== undefined && photographer.portfolioVideoThumbUrl && photographer.portfolioVideoThumbUrl !== data.portfolioVideoThumbUrl) {
        const oldThumbKey = this.extractR2KeyFromUrlOrKey(photographer.portfolioVideoThumbUrl, photographer.id);
        if (oldThumbKey) {
          try {
            await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: oldThumbKey }));
            this.urlCache.delete(oldThumbKey);
            this.logger.log(`[StorageService] Deleted replaced old Teaser Video Thumbnail from R2: ${oldThumbKey}`);
          } catch (err: any) {
            this.logger.error(`[StorageService] Failed to delete replaced Teaser Video Thumbnail: ${err.message}`);
          }
        }
      }

      // 2. Delete replaced old BTS Video from R2 if new BTS video is uploaded
      if (data.portfolioBtsUrl !== undefined && photographer.portfolioBtsUrl && photographer.portfolioBtsUrl !== data.portfolioBtsUrl) {
        const oldKey = this.extractR2KeyFromUrlOrKey(photographer.portfolioBtsUrl, photographer.id);
        if (oldKey) {
          try {
            await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: oldKey }));
            this.urlCache.delete(oldKey);
            this.logger.log(`[StorageService] Deleted replaced old BTS Video from R2: ${oldKey}`);
          } catch (err: any) {
            this.logger.error(`[StorageService] Failed to delete replaced BTS Video: ${err.message}`);
          }
        }
      }

      // 3. Delete replaced old BTS Thumbnail from R2 if new BTS thumbnail is uploaded
      if (data.portfolioBtsThumbUrl !== undefined && photographer.portfolioBtsThumbUrl && photographer.portfolioBtsThumbUrl !== data.portfolioBtsThumbUrl) {
        const oldThumbKey = this.extractR2KeyFromUrlOrKey(photographer.portfolioBtsThumbUrl, photographer.id);
        if (oldThumbKey) {
          try {
            await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: oldThumbKey }));
            this.urlCache.delete(oldThumbKey);
            this.logger.log(`[StorageService] Deleted replaced old BTS Thumbnail from R2: ${oldThumbKey}`);
          } catch (err: any) {
            this.logger.error(`[StorageService] Failed to delete replaced BTS Thumbnail: ${err.message}`);
          }
        }
      }

      const updated = await this.prisma.photographer.update({
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
          portfolioVideoThumbUrl: data.portfolioVideoThumbUrl !== undefined ? data.portfolioVideoThumbUrl : photographer.portfolioVideoThumbUrl,
          portfolioVideoSizeBytes: data.portfolioVideoSizeBytes !== undefined ? BigInt(data.portfolioVideoSizeBytes) : (data.portfolioVideoUrl === '' ? BigInt(0) : photographer.portfolioVideoSizeBytes),
          portfolioVideoThumbSizeBytes: data.portfolioVideoThumbSizeBytes !== undefined ? BigInt(data.portfolioVideoThumbSizeBytes) : (data.portfolioVideoThumbUrl === '' ? BigInt(0) : photographer.portfolioVideoThumbSizeBytes),
          portfolioProcess: data.portfolioProcess !== undefined ? (data.portfolioProcess as any) : (photographer.portfolioProcess as any),
          portfolioBtsUrl: data.portfolioBtsUrl !== undefined ? data.portfolioBtsUrl : photographer.portfolioBtsUrl,
          portfolioBtsThumbUrl: data.portfolioBtsThumbUrl !== undefined ? data.portfolioBtsThumbUrl : photographer.portfolioBtsThumbUrl,
          portfolioBtsSizeBytes: data.portfolioBtsSizeBytes !== undefined ? BigInt(data.portfolioBtsSizeBytes) : (data.portfolioBtsUrl === '' ? BigInt(0) : photographer.portfolioBtsSizeBytes),
          portfolioBtsThumbSizeBytes: data.portfolioBtsThumbSizeBytes !== undefined ? BigInt(data.portfolioBtsThumbSizeBytes) : (data.portfolioBtsThumbUrl === '' ? BigInt(0) : photographer.portfolioBtsThumbSizeBytes),
          portfolioEquipment: data.portfolioEquipment !== undefined ? (data.portfolioEquipment as any) : (photographer.portfolioEquipment as any),
          portfolioDestinations: data.portfolioDestinations !== undefined ? (data.portfolioDestinations as any) : (photographer.portfolioDestinations as any),
          portfolioBookingPolicy: data.bookingPolicy !== undefined ? data.bookingPolicy : (data.portfolioBookingPolicy !== undefined ? data.portfolioBookingPolicy : photographer.portfolioBookingPolicy),
          portfolioPress: data.portfolioPress !== undefined ? (data.portfolioPress as any) : (photographer.portfolioPress as any),
          portfolioStyles: data.portfolioStyles !== undefined ? (data.portfolioStyles as any) : (photographer.portfolioStyles as any),
          portfolioPhone: data.portfolioPhone !== undefined ? data.portfolioPhone : photographer.portfolioPhone,
          portfolioEmail: data.portfolioEmail !== undefined ? data.portfolioEmail : photographer.portfolioEmail,
          portfolioAddress: data.portfolioAddress !== undefined ? data.portfolioAddress : photographer.portfolioAddress,
          portfolioWhatsapp: data.portfolioWhatsapp !== undefined ? data.portfolioWhatsapp : photographer.portfolioWhatsapp,
        }
      });
      if (data.portfolioVideoSizeBytes !== undefined || data.portfolioVideoThumbSizeBytes !== undefined || data.portfolioBtsSizeBytes !== undefined || data.portfolioBtsThumbSizeBytes !== undefined) {
        await this.recalculateStorage(photographer.id);
      }
      await this.invalidatePortfolioCache(photographer.id);
      return updated;
    } catch (err) {
      console.error('[StorageService] updatePortfolioSettings error:', err);
      throw err;
    }
  }

  private extractR2KeyFromUrlOrKey(urlOrKey: string | null | undefined, photographerId: string): string | null {
    if (!urlOrKey) return null;
    if (urlOrKey.startsWith(`${photographerId}/`)) {
      return urlOrKey;
    }
    try {
      const urlObj = new URL(urlOrKey);
      let path = decodeURIComponent(urlObj.pathname);
      if (path.startsWith('/')) path = path.slice(1);
      const photogIdx = path.indexOf(photographerId);
      if (photogIdx !== -1) {
        return path.slice(photogIdx);
      }
    } catch {
      const photogIdx = urlOrKey.indexOf(photographerId);
      if (photogIdx !== -1) {
        return urlOrKey.slice(photogIdx).split('?')[0];
      }
    }
    return null;
  }

  async deletePortfolioHeroVideo(userId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId }
    });
    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    const videoUrlOrKey = photographer.portfolioVideoUrl;
    if (videoUrlOrKey) {
      const r2Key = this.extractR2KeyFromUrlOrKey(videoUrlOrKey, photographer.id);
      if (r2Key) {
        try {
          await this.s3Client.send(new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: r2Key,
          }));
          this.urlCache.delete(r2Key);
          this.logger.log(`[StorageService] Deleted Teaser Video from R2: ${r2Key}`);
        } catch (err: any) {
          this.logger.error(`[StorageService] Failed to delete Teaser Video from R2: ${err.message}`);
        }
      }
    }

    const thumbUrlOrKey = photographer.portfolioVideoThumbUrl;
    if (thumbUrlOrKey) {
      const r2ThumbKey = this.extractR2KeyFromUrlOrKey(thumbUrlOrKey, photographer.id);
      if (r2ThumbKey) {
        try {
          await this.s3Client.send(new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: r2ThumbKey,
          }));
          this.urlCache.delete(r2ThumbKey);
          this.logger.log(`[StorageService] Deleted Teaser Video Thumbnail from R2: ${r2ThumbKey}`);
        } catch (err: any) {
          this.logger.error(`[StorageService] Failed to delete Teaser Video Thumbnail from R2: ${err.message}`);
        }
      }
    }

    await this.prisma.photographer.update({
      where: { id: photographer.id },
      data: {
        portfolioVideoUrl: null,
        portfolioVideoThumbUrl: null,
        portfolioVideoSizeBytes: BigInt(0),
        portfolioVideoThumbSizeBytes: BigInt(0),
      }
    });

    await this.recalculateStorage(photographer.id);
    await this.invalidatePortfolioCache(photographer.id);
    return { success: true };
  }

  // BTS Video: dedicated upload URL — R2 path: {photographerId}/portfolio/bts/video/ & /thumb/
  async getPortfolioBtsVideoUploadUrl(userId: string, data: { filename: string; mimeType: string; fileSize: number; thumbMimeType?: string; thumbFileSize?: number }) {
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

    const totalSize = BigInt(data.fileSize || 0) + BigInt(data.thumbFileSize || 0);
    const activeSub = photographer.subscriptions[0];
    const portfolioLimitBytes = activeSub
      ? (activeSub.limitPortfolioBytes ?? BigInt(0))
      : BigInt(0);
    if (portfolioLimitBytes > BigInt(0)) {
      const portfolioUsed = await this.getPortfolioStorageUsed(photographer.id);
      if (portfolioUsed + totalSize > portfolioLimitBytes) {
        throw new BadRequestException(
          `Portfolio storage limit exceeded (${Math.round(Number(portfolioLimitBytes) / 1024 / 1024)} MB). Please upgrade your plan.`
        );
      }
    }

    const ext = data.filename ? data.filename.split('.').pop() : 'mp4';
    const timestamp = Date.now();

    // Video inside: {photographer.id}/portfolio/bts/video/{timestamp}.mp4
    const key = `${photographer.id}/portfolio/bts/video/${timestamp}.${ext}`;
    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: data.mimeType || 'video/mp4',
    });
    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: 3600,
      unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']),
    });
    const url = await this.getReadUrl(key);

    // Thumb inside: {photographer.id}/portfolio/bts/thumb/{timestamp}_thumb.jpg
    const thumbKey = `${photographer.id}/portfolio/bts/thumb/${timestamp}_thumb.jpg`;
    const thumbCommand = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: thumbKey,
      ContentType: data.thumbMimeType || 'image/jpeg',
    });
    const thumbUploadUrl = await getSignedUrl(this.s3Client, thumbCommand, {
      expiresIn: 3600,
      unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']),
    });
    const thumbUrl = await this.getReadUrl(thumbKey);

    return { uploadUrl, key, url, thumbUploadUrl, thumbKey, thumbUrl };
  }

  async deletePortfolioBtsVideo(userId: string) {

    const photographer = await this.prisma.photographer.findUnique({
      where: { userId }
    });
    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    const btsUrlOrKey = photographer.portfolioBtsUrl;
    if (btsUrlOrKey) {
      const r2Key = this.extractR2KeyFromUrlOrKey(btsUrlOrKey, photographer.id);
      if (r2Key) {
        try {
          await this.s3Client.send(new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: r2Key,
          }));
          this.urlCache.delete(r2Key);
          this.logger.log(`[StorageService] Deleted BTS Video from R2: ${r2Key}`);
        } catch (err: any) {
          this.logger.error(`[StorageService] Failed to delete BTS Video from R2: ${err.message}`);
        }
      }
    }

    // Also delete thumb from R2 if exists
    const btsThumbUrlOrKey = (photographer as any).portfolioBtsThumbUrl;
    if (btsThumbUrlOrKey) {
      const thumbR2Key = this.extractR2KeyFromUrlOrKey(btsThumbUrlOrKey, photographer.id);
      if (thumbR2Key) {
        try {
          await this.s3Client.send(new DeleteObjectCommand({
            Bucket: this.bucketName,
            Key: thumbR2Key,
          }));
          this.urlCache.delete(thumbR2Key);
          this.logger.log(`[StorageService] Deleted BTS Thumb from R2: ${thumbR2Key}`);
        } catch (err: any) {
          this.logger.error(`[StorageService] Failed to delete BTS Thumb from R2: ${err.message}`);
        }
      }
    }

    await this.prisma.photographer.update({
      where: { id: photographer.id },
      data: {
        portfolioBtsUrl: null,
        portfolioBtsThumbUrl: null,
        portfolioBtsSizeBytes: BigInt(0),
        portfolioBtsThumbSizeBytes: BigInt(0),
      }
    });

    await this.recalculateStorage(photographer.id);
    await this.invalidatePortfolioCache(photographer.id);
    return { success: true };
  }


  // Helper: compute portfolio-only storage directly from PostgreSQL DB (Instant <1ms query)
  private async getPortfolioStorageUsed(photographerId: string): Promise<bigint> {
    try {
      const [photosSum, reelsSum, photographer] = await Promise.all([
        this.prisma.portfolioPhoto.aggregate({
          where: { photographerId },
          _sum: { fileSize: true, thumbSizeBytes: true },
        }),
        this.prisma.portfolioReel.aggregate({
          where: { photographerId },
          _sum: { fileSize: true, thumbSizeBytes: true },
        }),
        this.prisma.photographer.findUnique({
          where: { id: photographerId },
          select: {
            portfolioAboutImageSizeBytes: true,
            portfolioVideoSizeBytes: true,
            portfolioBtsSizeBytes: true,
          },
        }),
      ]);

      const totalBytes =
        BigInt(photosSum._sum.fileSize ? photosSum._sum.fileSize.toString() : '0') +
        BigInt(photosSum._sum.thumbSizeBytes ? photosSum._sum.thumbSizeBytes.toString() : '0') +
        BigInt(reelsSum._sum.fileSize ? reelsSum._sum.fileSize.toString() : '0') +
        BigInt(reelsSum._sum.thumbSizeBytes ? reelsSum._sum.thumbSizeBytes.toString() : '0') +
        BigInt(photographer?.portfolioAboutImageSizeBytes ? photographer.portfolioAboutImageSizeBytes.toString() : '0') +
        BigInt(photographer?.portfolioVideoSizeBytes ? photographer.portfolioVideoSizeBytes.toString() : '0') +
        BigInt(photographer?.portfolioBtsSizeBytes ? photographer.portfolioBtsSizeBytes.toString() : '0');

      return totalBytes;
    } catch (err: any) {
      this.logger.error(`[StorageService] getPortfolioStorageUsed DB aggregate error: ${err.message}`);
      return BigInt(0);
    }
  }

  async deletePortfolioReelItem(userId: string, reelId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId }
    });
    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    const reel = await this.prisma.portfolioReel.findFirst({
      where: { id: reelId, photographerId: photographer.id }
    });

    if (!reel) {
      throw new NotFoundException('Reel not found or does not belong to photographer');
    }

    // Delete from R2 cloud storage
    try {
      if (reel.r2Key) {
        await this.s3Client.send(new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: reel.r2Key,
        }));
        this.urlCache.delete(reel.r2Key);
      }
      if (reel.r2KeyThumb) {
        await this.s3Client.send(new DeleteObjectCommand({
          Bucket: this.bucketName,
          Key: reel.r2KeyThumb,
        }));
        this.urlCache.delete(reel.r2KeyThumb);
      }
    } catch (err) {
      console.error('[StorageService] Delete reel R2 file error:', err);
    }

    // Delete from database
    await this.prisma.portfolioReel.delete({
      where: { id: reelId }
    });

    await this.recalculateStorage(photographer.id);
    await this.invalidatePortfolioCache(photographer.id);
    return { success: true };
  }

  async getPortfolioAboutImageUploadUrl(userId: string, data: { mimeType: string; fileSize: number }) {
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

    const activeSub = photographer.subscriptions[0];
    const portfolioLimitBytes = activeSub
      ? (activeSub.limitPortfolioBytes ?? BigInt(0))
      : BigInt(0);
    if (portfolioLimitBytes > BigInt(0)) {
      const portfolioUsed = await this.getPortfolioStorageUsed(photographer.id);
      if (portfolioUsed + BigInt(data.fileSize) > portfolioLimitBytes) {
        throw new BadRequestException(
          `Portfolio storage limit exceeded (${Math.round(Number(portfolioLimitBytes) / 1024 / 1024)} MB). Please upgrade your plan.`
        );
      }
    }

    const ext = data.mimeType?.includes('webp') ? 'webp' : 'jpg';
    const key = `${photographer.id}/portfolio/about.${ext}`;

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: data.mimeType,
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: 3600,
      unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']),
    });
    return { uploadUrl, key };
  }

  async completePortfolioAboutImageUpload(userId: string, key: string, fileSize?: number) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    const oldKey = photographer.portfolioAboutImageKey;

    if (oldKey && oldKey !== key) {
      try {
        await this.s3Client.send(new DeleteObjectCommand({ Bucket: this.bucketName, Key: oldKey }));
        this.urlCache.delete(oldKey);
      } catch { }
    }

    await this.prisma.photographer.update({
      where: { id: photographer.id },
      data: {
        portfolioAboutImageKey: key,
        portfolioAboutImageSizeBytes: fileSize ? BigInt(fileSize) : BigInt(0),
      }
    });

    await this.recalculateStorage(photographer.id);
    await this.invalidatePortfolioCache(photographer.id);

    this.urlCache.delete(key);
    const url = await this.getReadUrl(key);
    return { success: true, url, key };
  }

  async getPortfolioReelVideoUploadUrl(userId: string, data: { filename: string; mimeType: string; fileSize: number; thumbMimeType?: string; thumbFileSize?: number }) {
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

    const totalSize = BigInt(data.fileSize || 0) + BigInt(data.thumbFileSize || 0);
    const activeSub = photographer.subscriptions[0];
    const portfolioLimitBytes = activeSub
      ? (activeSub.limitPortfolioBytes ?? BigInt(0))
      : BigInt(0);
    if (portfolioLimitBytes > BigInt(0)) {
      const portfolioUsed = await this.getPortfolioStorageUsed(photographer.id);
      if (portfolioUsed + totalSize > portfolioLimitBytes) {
        throw new BadRequestException(
          `Portfolio storage limit exceeded (${Math.round(Number(portfolioLimitBytes) / 1024 / 1024)} MB). Please upgrade your plan.`
        );
      }
    }

    const ext = data.filename ? data.filename.split('.').pop() : 'mp4';
    const timestamp = Date.now();
    // Video inside: {photographer.id}/portfolio/hero-video/video/{timestamp}.mp4
    const key = `${photographer.id}/portfolio/hero-video/video/${timestamp}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: key,
      ContentType: data.mimeType || 'video/mp4',
    });

    const uploadUrl = await getSignedUrl(this.s3Client, command, {
      expiresIn: 3600,
      unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']),
    });
    const url = await this.getReadUrl(key);

    // Poster thumbnail inside: {photographer.id}/portfolio/hero-video/thumb/{timestamp}_thumb.webp
    const thumbKey = `${photographer.id}/portfolio/hero-video/thumb/${timestamp}_thumb.webp`;
    const thumbCommand = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: thumbKey,
      ContentType: data.thumbMimeType || 'image/webp',
    });

    const thumbUploadUrl = await getSignedUrl(this.s3Client, thumbCommand, {
      expiresIn: 3600,
      unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']),
    });
    const thumbUrl = await this.getReadUrl(thumbKey);

    return { uploadUrl, key, url, thumbUploadUrl, thumbKey, thumbUrl };
  }

  async getPortfolioReelItemUploadUrl(
    userId: string,
    data: {
      video?: { filename: string; mimeType: string; fileSize: number };
      thumb?: { filename?: string; mimeType?: string; fileSize?: number };
      filename?: string;
      mimeType?: string;
      fileSize?: number;
    }
  ) {
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

    const videoData = data.video || {
      filename: data.filename || 'reel.mp4',
      mimeType: data.mimeType || 'video/mp4',
      fileSize: data.fileSize || 0
    };
    const thumbData = data.thumb;

    const totalRequested = BigInt(videoData.fileSize) + BigInt(thumbData?.fileSize || 0);
    const activeSub = photographer.subscriptions[0];
    const portfolioLimitBytes = activeSub
      ? (activeSub.limitPortfolioBytes ?? BigInt(0))
      : BigInt(0);
    if (portfolioLimitBytes > BigInt(0)) {
      const portfolioUsed = await this.getPortfolioStorageUsed(photographer.id);
      if (portfolioUsed + totalRequested > portfolioLimitBytes) {
        throw new BadRequestException(
          `Portfolio storage limit exceeded (${Math.round(Number(portfolioLimitBytes) / 1024 / 1024)} MB). Please upgrade your plan.`
        );
      }
    }

    const reelUuid = uuidv4();
    const videoKey = `${photographer.id}/portfolio/reels/videos/${reelUuid}.mp4`;
    const thumbKey = `${photographer.id}/portfolio/reels/thumbs/${reelUuid}_thumb.jpg`;

    const videoCommand = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: videoKey,
      ContentType: 'video/mp4',
    });

    const videoUploadUrl = await getSignedUrl(this.s3Client, videoCommand, {
      expiresIn: 3600,
      unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']),
    });

    let thumbUploadUrl: string | undefined;
    if (thumbData) {
      const thumbCommand = new PutObjectCommand({
        Bucket: this.bucketName,
        Key: thumbKey,
        ContentType: 'image/jpeg',
      });
      thumbUploadUrl = await getSignedUrl(this.s3Client, thumbCommand, {
        expiresIn: 3600,
        unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']),
      });
    }

    return {
      video: {
        uploadUrl: videoUploadUrl,
        key: videoKey,
      },
      thumb: {
        uploadUrl: thumbUploadUrl,
        key: thumbKey,
      },
      uploadUrl: videoUploadUrl,
      key: videoKey,
      thumbKey: thumbUploadUrl ? thumbKey : undefined,
    };
  }

  async completePortfolioReelItemUpload(
    userId: string,
    data: {
      key: string;
      thumbKey?: string;
      title?: string;
      category?: string;
      fileSize?: number;
      thumbSizeBytes?: number;
    }
  ) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    const reel = await this.prisma.portfolioReel.create({
      data: {
        photographerId: photographer.id,
        title: data.title || 'Untitled Reel',
        category: data.category || 'Highlights',
        r2Key: data.key,
        r2KeyThumb: data.thumbKey || null,
        fileSize: data.fileSize ? BigInt(data.fileSize) : BigInt(0),
        thumbSizeBytes: data.thumbSizeBytes ? BigInt(data.thumbSizeBytes) : BigInt(0),
      }
    });

    await this.recalculateStorage(photographer.id);
    await this.invalidatePortfolioCache(photographer.id);
    const url = await this.getReadUrl(data.key);
    const thumbUrl = data.thumbKey ? await this.getReadUrl(data.thumbKey) : null;
    return {
      success: true,
      reel: {
        id: reel.id,
        title: reel.title,
        category: reel.category,
        r2Key: reel.r2Key,
        r2KeyThumb: reel.r2KeyThumb,
        url,
        thumbUrl,
        viewsCount: reel.viewsCount,
        createdAt: reel.createdAt
      }
    };
  }

  async getPortfolioPhotoUploadUrl(
    userId: string,
    data: {
      original: { filename: string; mimeType: string; fileSize: number };
      thumb: { filename: string; mimeType: string; fileSize: number };
    }
  ) {
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

    const activeSub = photographer.subscriptions[0];
    const portfolioLimitBytes = activeSub
      ? (activeSub.limitPortfolioBytes ?? BigInt(0))
      : BigInt(0);
    if (portfolioLimitBytes > BigInt(0)) {
      const portfolioUsed = await this.getPortfolioStorageUsed(photographer.id);
      const totalRequested = BigInt(data.original.fileSize) + BigInt(data.thumb.fileSize);
      if (portfolioUsed + totalRequested > portfolioLimitBytes) {
        throw new BadRequestException(
          `Portfolio storage limit exceeded (${Math.round(Number(portfolioLimitBytes) / 1024 / 1024)} MB). Please upgrade your plan.`
        );
      }
    }

    const photoUuid = uuidv4();
    const originalKey = `${photographer.id}/portfolio/showcase/${photoUuid}_original.jpg`;
    const thumbKey = `${photographer.id}/portfolio/showcase/${photoUuid}_thumb.jpg`;

    const originalCommand = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: originalKey,
      ContentType: 'image/jpeg',
    });

    const thumbCommand = new PutObjectCommand({
      Bucket: this.bucketName,
      Key: thumbKey,
      ContentType: 'image/jpeg',
    });

    const originalUploadUrl = await getSignedUrl(this.s3Client, originalCommand, {
      expiresIn: 3600,
      unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']),
    });
    const thumbUploadUrl = await getSignedUrl(this.s3Client, thumbCommand, {
      expiresIn: 3600,
      unhoistableHeaders: new Set(['x-amz-checksum-crc32', 'x-amz-sdk-checksum-algorithm', 'x-amz-checksum-mode']),
    });

    return {
      original: {
        uploadUrl: originalUploadUrl,
        key: originalKey
      },
      thumb: {
        uploadUrl: thumbUploadUrl,
        key: thumbKey
      }
    };
  }

  async completePortfolioPhotoUpload(userId: string, data: { originalKey: string; thumbKey: string; category?: string; fileSize?: number; thumbSizeBytes?: number }) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { userId }
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    const portfolioPhoto = await this.prisma.portfolioPhoto.create({
      data: {
        photographerId: photographer.id,
        r2KeyOriginal: data.originalKey,
        r2KeyThumb: data.thumbKey,
        fileSize: data.fileSize ? BigInt(data.fileSize) : BigInt(0),
        thumbSizeBytes: data.thumbSizeBytes ? BigInt(data.thumbSizeBytes) : BigInt(0),
        category: data.category || 'General'
      }
    });

    await this.recalculateStorage(photographer.id);
    await this.invalidatePortfolioCache(photographer.id);

    const url = await this.getReadUrl(data.originalKey);
    const thumbUrl = await this.getReadUrl(data.thumbKey);

    return {
      success: true,
      photo: {
        id: portfolioPhoto.id,
        url,
        thumbUrl,
        category: portfolioPhoto.category,
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
    await this.invalidatePortfolioCache(photographer.id);

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
    await this.invalidatePortfolioCache(photographer.id);

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

    // Also delete any direct video keys
    if (photographer.portfolioVideoUrl) {
      await deleteIfKeyExists(photographer.portfolioVideoUrl);
    }
    if (photographer.portfolioBtsUrl) {
      await deleteIfKeyExists(photographer.portfolioBtsUrl);
    }

    // Clean reels keys from database and R2
    const dbReels = await this.prisma.portfolioReel.findMany({
      where: { photographerId: photographer.id },
      select: { id: true, r2Key: true }
    });
    for (const r of dbReels) {
      if (r.r2Key) {
        await deleteIfKeyExists(r.r2Key);
      }
      await this.prisma.portfolioReel.delete({ where: { id: r.id } });
    }


    // 3. Reset photographer settings fields
    await this.prisma.photographer.update({
      where: { id: photographer.id },
      data: {
        portfolioAboutImageKey: null,
        portfolioAboutImageSizeBytes: BigInt(0),
        portfolioVideoUrl: null,
        portfolioVideoSizeBytes: BigInt(0),
        portfolioBtsUrl: null,
        portfolioBtsSizeBytes: BigInt(0),
      }
    });

    // Recalculate storage
    await this.recalculateStorage(photographer.id);
    await this.invalidatePortfolioCache(photographer.id);

    return { success: true };
  }

  async invalidatePortfolioCache(photographerId: string, subdomain?: string) {
    try {
      if (subdomain) {
        const clean = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
        await this.redis.del(`cache:public:portfolio:${clean}`);
      } else {
        const photographer = await this.prisma.photographer.findUnique({
          where: { id: photographerId },
          select: { studioSubdomain: true }
        });
        if (photographer?.studioSubdomain) {
          const clean = photographer.studioSubdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
          await this.redis.del(`cache:public:portfolio:${clean}`);
        }
      }
    } catch (err: any) {
      this.logger.error(`[invalidatePortfolioCache] Redis del error: ${err.message}`);
    }
  }

  async getPublicPortfolioBySubdomain(subdomain: string) {
    const cleanSubdomain = subdomain.toLowerCase().replace(/[^a-z0-9-]/g, '');
    const cacheKey = `cache:public:portfolio:${cleanSubdomain}`;

    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err: any) {
      this.logger.error(`[getPublicPortfolioBySubdomain] Redis get error: ${err.message}`);
    }

    const photographer = await this.prisma.photographer.findUnique({
      where: { studioSubdomain: cleanSubdomain },
      include: {
        portfolioPhotos: {
          orderBy: { sortOrder: 'asc' }
        },
        portfolioReels: {
          orderBy: { createdAt: 'desc' }
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

    const reels = await Promise.all(
      (photographer.portfolioReels || []).map(async (r) => {
        const url = await this.getReadUrl(r.r2Key);
        const thumbUrl = r.r2KeyThumb ? await this.getReadUrl(r.r2KeyThumb) : null;
        return {
          id: r.id,
          title: r.title,
          category: r.category || 'Highlights',
          r2Key: r.r2Key,
          r2KeyThumb: r.r2KeyThumb,
          url,
          thumbUrl,
          viewsCount: r.viewsCount,
          createdAt: r.createdAt
        };
      })
    );

    const aboutImageUrl = photographer.portfolioAboutImageKey
      ? await this.getReadUrl(photographer.portfolioAboutImageKey)
      : null;

    const freshVideoUrl = await this.getFreshVideoUrl(photographer.portfolioVideoUrl);
    const freshThumbUrl = await this.getFreshVideoUrl(photographer.portfolioVideoThumbUrl);
    const freshBtsUrl = await this.getFreshVideoUrl(photographer.portfolioBtsUrl);
    const freshBtsThumbUrl = await this.getFreshVideoUrl(photographer.portfolioBtsThumbUrl);

    const result = {
      portfolioEnabled: photographer.portfolioEnabled,
      portfolioTheme: photographer.portfolioTheme,
      portfolioHeroTitle: photographer.portfolioHeroTitle,
      portfolioHeroSubtitle: photographer.portfolioHeroSubtitle,
      portfolioAboutTitle: photographer.portfolioAboutTitle,
      portfolioAboutText: photographer.portfolioAboutText,
      portfolioAboutImageUrl: aboutImageUrl,
      portfolioMapEmbed: photographer.portfolioMapEmbed,
      portfolioPackages: photographer.portfolioPackages,
      portfolioServices: photographer.portfolioServices,
      portfolioTestimonials: photographer.portfolioTestimonials,
      portfolioStats: photographer.portfolioStats,
      portfolioFaqs: photographer.portfolioFaqs,
      portfolioVideoUrl: freshVideoUrl,
      portfolioVideoThumbUrl: freshThumbUrl,
      portfolioProcess: photographer.portfolioProcess,
      portfolioBtsUrl: freshBtsUrl,
      portfolioBtsThumbUrl: freshBtsThumbUrl,
      portfolioEquipment: photographer.portfolioEquipment,
      portfolioDestinations: photographer.portfolioDestinations,
      portfolioBookingPolicy: photographer.portfolioBookingPolicy,
      portfolioPress: photographer.portfolioPress,
      portfolioReels: reels,
      portfolioStyles: photographer.portfolioStyles,
      portfolioPhone: photographer.portfolioPhone,
      portfolioEmail: photographer.portfolioEmail,
      portfolioAddress: photographer.portfolioAddress,
      portfolioWhatsapp: photographer.portfolioWhatsapp,
      portfolioPhotos: photos,
      studioName: photographer.studioName,
      instagramUrl: photographer.instagramUrl,
      facebookUrl: photographer.facebookUrl,
      whatsappPhone: photographer.whatsappPhone,
      studioLogoKey: photographer.studioLogoKey,
      seoTitle: photographer.seoTitle,
      seoDescription: photographer.seoDescription,
      hidePoweredBy: photographer.hidePoweredBy,
      customFooterText: photographer.customFooterText,
      photographerId: photographer.id
    };

    try {
      await this.redis.setex(cacheKey, 600, JSON.stringify(result));
    } catch (err: any) {
      this.logger.error(`[getPublicPortfolioBySubdomain] Redis set error: ${err.message}`);
    }

    return result;
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
      const path = require('path');
      const logoPath = path.join(process.cwd(), 'assets', 'logo', 'fotosetgo.png');
      if (fs.existsSync(logoPath)) {
        return {
          buffer: fs.readFileSync(logoPath),
          contentType: 'image/png'
        };
      }
      throw new NotFoundException('Logo not found');
    }

    const directUrl = await this.getReadUrl(photographer.studioLogoKey);
    return { redirectUrl: directUrl };
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
    const updated = await this.prisma.portfolioReview.update({
      where: { id: reviewId },
      data: { isApproved: approve }
    });
    await this.invalidatePortfolioCache(photographer.id);
    return updated;
  }

  async deletePortfolioReview(userId: string, reviewId: string) {
    const photographer = await this.prisma.photographer.findUnique({ where: { userId } });
    if (!photographer) throw new NotFoundException('Photographer not found');
    const review = await this.prisma.portfolioReview.findUnique({ where: { id: reviewId } });
    if (!review || review.photographerId !== photographer.id) {
      throw new NotFoundException('Review not found or ownership mismatch');
    }
    await this.prisma.portfolioReview.delete({ where: { id: reviewId } });
    await this.invalidatePortfolioCache(photographer.id);
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

  async completeThumbnailWebhook(data: { photoId: string; thumbKey: string; previewKey?: string; thumbSize?: number; previewSize?: number; secretKey: string }) {
    // Validate secret key to match environmental setup
    const secret = process.env.WORKER_SECRET_KEY;
    if (!secret || data.secretKey !== secret) {
      throw new Error('Unauthorized webhook signature mismatch');
    }

    const photo = await this.prisma.photo.findUnique({
      where: { id: data.photoId },
      include: { event: true }
    });

    if (!photo) {
      throw new Error('Photo not found');
    }

    const thumbSizeBytes = data.thumbSize ? BigInt(data.thumbSize) : BigInt(0);
    const previewSizeBytes = data.previewSize ? BigInt(data.previewSize) : BigInt(0);
    const extraBytes = thumbSizeBytes + previewSizeBytes;

    // Update photo with thumbnail keys, byte sizes + set thumbnailStatus & overall status to READY
    const isPendingApproval = photo.status === 'PENDING_APPROVAL';

    await this.prisma.photo.update({
      where: { id: data.photoId },
      data: {
        r2KeyThumb: data.thumbKey,
        r2KeyPreview: data.previewKey || null,
        thumbSizeBytes,
        previewSizeBytes,
        thumbnailStatus: 'READY',
        ...(isPendingApproval ? {} : { status: 'READY' })
      }
    });

    // Add generated derivatives size to Redis storage counters
    if (extraBytes > BigInt(0)) {
      await this.redis.hincrby("agg:photographer:storage", photo.photographerId, extraBytes.toString()).catch(() => { });
      const activeSub = await this.prisma.subscription.findFirst({
        where: { photographerId: photo.photographerId, status: 'ACTIVE' },
        orderBy: { startsAt: 'desc' }
      });
      if (activeSub) {
        await this.redis.hincrby("agg:subscription:storage", activeSub.id, extraBytes.toString()).catch(() => { });
      }
    }

    await this.invalidateStorageBreakdownCache(photo.photographerId);

    if (!isPendingApproval) {
      if (photo.type === 'VIDEO') {
        this.runBackgroundVideoProcessing(
          photo.photographerId,
          photo.id,
          photo.eventId,
          photo.r2KeyOriginal,
          photo.uploadBatchId
        ).catch(err => {
          this.logger.error(`[Webhook] Background video processing failed for ${photo.id}: ${err.message}`);
        });
      } else {
        // If face scanning is enabled, trigger background batch face indexing silently without blocking photo status
        if (photo.event.faceScanningEnabled) {
          this.triggerFaceScanForEvent(
            photo.photographerId,
            photo.eventId
          ).catch(err => {
            console.error('[Webhook] Background Face Indexing trigger failed:', err);
          });
        }

        // Update upload batch progress status
        if (photo.uploadBatchId) {
          await this.updateBatchProgress(photo.uploadBatchId, true);
        }
      }
    } else {
      // For pending guest uploads, update the upload batch progress status
      if (photo.uploadBatchId) {
        await this.updateBatchProgress(photo.uploadBatchId, true);
      }
    }

    await this.invalidateEventCache(photo.eventId);
    return { success: true };
  }

  async completeVideoFaceWebhook(data: {
    photoId: string;
    duration?: number;
    faces?: Array<{
      faceIndex?: number;
      bbox?: { x: number; y: number; w: number; h: number };
      confidence?: number;
      embedding: number[];
      timestamp?: number;
    }>;
    secretKey: string;
    error?: string;
  }) {
    const secret = process.env.WORKER_SECRET_KEY;
    if (!secret || data.secretKey !== secret) {
      throw new UnauthorizedException('Unauthorized webhook signature mismatch');
    }

    const photo = await this.prisma.photo.findUnique({
      where: { id: data.photoId },
      include: { event: true }
    });

    if (!photo) {
      throw new NotFoundException('Photo not found');
    }

    const photographerId = photo.photographerId;
    const eventId = photo.eventId;
    const duration = Math.round(data.duration || photo.duration || 0);

    if (data.error) {
      this.logger.error(`[VideoFaceWebhook] Processing failed for video ${data.photoId}: ${data.error}`);
      await this.prisma.photo.update({
        where: { id: data.photoId },
        data: { faceScanStatus: 'SKIPPED', status: 'READY' }
      });
      return { success: false, message: 'Recorded failure status without deducting credits' };
    }

    // Deduct actual cost from photographer credit balance atomically upon verified success
    const actualMinutes = Math.ceil(duration / 60) || 1;
    const actualCost = actualMinutes * 50; // 50 paise per minute

    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
      select: { creditBalance: true }
    });
    const latestBalance = photographer?.creditBalance || 0;
    const deductAmount = Math.min(actualCost, latestBalance);

    if (deductAmount > 0) {
      await this.prisma.photographer.update({
        where: { id: photographerId },
        data: {
          creditBalance: {
            decrement: deductAmount
          }
        }
      });

      // Log transaction
      await this.prisma.creditTransaction.create({
        data: {
          photographerId,
          amount: -deductAmount,
          action: 'VIDEO_SCAN',
          description: `Scanned video (duration ${actualMinutes} min) for event: ${photo.event?.title || 'Unknown Event'}`
        }
      });
    }

    // Delete any existing face embeddings for this video photo first to prevent duplicates
    await this.prisma.faceEmbedding.deleteMany({
      where: { photoId: data.photoId }
    });

    if (data.faces && data.faces.length > 0) {
      const faceData = data.faces.map((f: any) => ({
        photoId: data.photoId,
        eventId,
        photographerId,
        faceIndex: f.faceIndex ?? 0,
        bboxX: f.bbox?.x ?? 0,
        bboxY: f.bbox?.y ?? 0,
        bboxW: f.bbox?.w ?? 0,
        bboxH: f.bbox?.h ?? 0,
        confidence: f.confidence ?? 0.95,
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

    const targetStatus = photo.status === 'PENDING_APPROVAL' ? 'PENDING_APPROVAL' : 'READY';
    await this.prisma.photo.update({
      where: { id: data.photoId },
      data: {
        faceScanStatus: 'READY',
        status: targetStatus,
        duration: duration > 0 ? duration : undefined
      }
    });

    if (photo.uploadBatchId) {
      await this.updateBatchProgress(photo.uploadBatchId, true);
    }

    await this.invalidateEventCache(eventId);

    this.logger.log(`[VideoFaceWebhook] Successfully indexed video ${data.photoId} with ${data.faces?.length || 0} faces, duration ${duration}s.`);
    return { success: true, faceCount: data.faces?.length || 0, duration };
  }

  async completePhotoFaceWebhook(data: {
    eventId?: string;
    photographerId?: string;
    results?: Array<{
      photoId: string;
      faces?: Array<{
        faceIndex?: number;
        bbox?: { x: number; y: number; w: number; h: number };
        confidence?: number;
        embedding: number[];
      }>;
      faceCount?: number;
      success?: boolean;
      error?: string;
    }>;
    photoId?: string;
    faces?: Array<{
      faceIndex?: number;
      bbox?: { x: number; y: number; w: number; h: number };
      confidence?: number;
      embedding: number[];
    }>;
    secretKey: string;
    error?: string;
  }) {
    const secret = process.env.WORKER_SECRET_KEY;
    if (!secret || data.secretKey !== secret) {
      throw new UnauthorizedException('Unauthorized webhook signature mismatch');
    }

    // Normalize single-photo or batch format to standard results array
    let items = data.results || [];
    if (!items.length && data.photoId) {
      items = [{
        photoId: data.photoId,
        faces: data.faces,
        faceCount: data.faces?.length || 0,
        success: !data.error,
        error: data.error
      }];
    }

    if (items.length === 0) {
      return { success: true, processedCount: 0 };
    }

    const firstPhoto = await this.prisma.photo.findUnique({
      where: { id: items[0].photoId },
      include: { event: true }
    });

    if (!firstPhoto) {
      this.logger.error(`[PhotoFaceWebhook] Photo ${items[0].photoId} not found`);
      return { success: false, message: 'Photo not found' };
    }

    const photographerId = data.photographerId || firstPhoto.photographerId;
    const eventId = data.eventId || firstPhoto.eventId;

    // Filter successfully scanned photos (only deduct for photos that were actually processed without error)
    const successfulItems = items.filter(r => r.success !== false && !r.error);
    const totalSuccessfulPhotos = successfulItems.length;

    // For failed items from Modal, update status to SKIPPED to prevent infinite background retry loops
    const failedItems = items.filter(r => r.success === false || !!r.error);
    if (failedItems.length > 0) {
      const failedIds = failedItems.map(f => f.photoId);
      await this.prisma.photo.updateMany({
        where: { id: { in: failedIds } },
        data: { faceScanStatus: 'SKIPPED' }
      }).catch(err => this.logger.error(`[PhotoFaceWebhook] Error marking failed items: ${err.message}`));
    }

    // 10 paise per successfully scanned photo
    const actualCost = totalSuccessfulPhotos * 10;

    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
      select: { creditBalance: true }
    });
    const latestBalance = photographer?.creditBalance || 0;
    const deductAmount = Math.min(actualCost, latestBalance);

    if (deductAmount > 0) {
      await this.prisma.photographer.update({
        where: { id: photographerId },
        data: {
          creditBalance: {
            decrement: deductAmount
          }
        }
      });

      // Log transaction
      await this.prisma.creditTransaction.create({
        data: {
          photographerId,
          amount: -deductAmount,
          action: 'PHOTO_SCAN',
          description: `Scanned ${totalSuccessfulPhotos} photo(s) for event: ${firstPhoto.event?.title || 'Unknown Event'}`
        }
      });
    }

    // Fetch existing faces in this event for auto-cluster assignment
    interface RawExistingFace {
      clusterId: string;
      embeddingStr: string;
    }
    const existingFaces = await this.prisma.$queryRaw<RawExistingFace[]>`
      SELECT "clusterId", "embedding"::text as "embeddingStr"
      FROM face_embeddings
      WHERE "eventId" = ${eventId} AND "clusterId" IS NOT NULL
    `.catch(() => [] as RawExistingFace[]);

    // Process each item: insert face embeddings and update photo record
    for (const item of items) {
      if (item.success === false || item.error) {
        this.logger.warn(`[PhotoFaceWebhook] Photo ${item.photoId} face scan failed: ${item.error}`);
        await this.prisma.photo.update({
          where: { id: item.photoId },
          data: { faceScanStatus: 'SKIPPED', status: 'READY' }
        }).catch(() => { });
        continue;
      }

      const faces = item.faces || [];
      const hasFaces = faces.length > 0;
      const faceCount = faces.length;

      // Delete any previous face embeddings for this photo first to prevent duplicates
      await this.prisma.faceEmbedding.deleteMany({
        where: { photoId: item.photoId }
      }).catch(() => { });

      if (hasFaces) {
        const faceData = faces.map((f: any, idx: number) => {
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

              let dotProduct = 0;
              for (let i = 0; i < newEmbArray.length; i++) {
                dotProduct += newEmbArray[i] * extEmbArray[i];
              }

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
            photoId: item.photoId,
            eventId,
            photographerId,
            faceIndex: f.faceIndex ?? idx,
            bboxX: f.bbox?.x ?? 0,
            bboxY: f.bbox?.y ?? 0,
            bboxW: f.bbox?.w ?? 0,
            bboxH: f.bbox?.h ?? 0,
            confidence: f.confidence ?? 0.95,
            embedding: f.embedding,
            clusterId: assignedClusterId
          };
        });

        const values = faceData.map((f: any) => {
          const vectorStr = `[${f.embedding.join(',')}]`;
          const clusterIdVal = f.clusterId ? `'${f.clusterId}'` : 'NULL';
          return `('${uuidv4()}', '${f.photoId}', '${f.eventId}', '${f.photographerId}', ${f.faceIndex}, ${f.bboxX}, ${f.bboxY}, ${f.bboxW}, ${f.bboxH}, ${f.confidence}, '${vectorStr}'::vector, ${clusterIdVal})`;
        }).join(',');

        await this.prisma.$executeRawUnsafe(`
          INSERT INTO face_embeddings ("id", "photoId", "eventId", "photographerId", "faceIndex", "bboxX", "bboxY", "bboxW", "bboxH", "confidence", "embedding", "clusterId")
          VALUES ${values}
        `).catch(err => {
          this.logger.error(`[PhotoFaceWebhook] Error inserting face embeddings for photo ${item.photoId}: ${err.message}`);
        });
      }

      const currentPhoto = await this.prisma.photo.findUnique({
        where: { id: item.photoId },
        select: { status: true }
      });

      const targetStatus = currentPhoto?.status === 'PENDING_APPROVAL' ? 'PENDING_APPROVAL' : 'READY';

      const updated = await this.prisma.photo.update({
        where: { id: item.photoId },
        data: {
          faceScanStatus: 'READY',
          hasFaces,
          faceCount,
          status: targetStatus
        }
      }).catch(() => null);

      if (updated?.uploadBatchId) {
        await this.updateBatchProgress(updated.uploadBatchId, true).catch(() => { });
      }
    }

    await this.invalidateEventCache(eventId);

    this.logger.log(`[PhotoFaceWebhook] Successfully indexed ${totalSuccessfulPhotos}/${items.length} photos for event ${eventId}. Deducted ${deductAmount} paise.`);
    return { success: true, processedCount: totalSuccessfulPhotos, totalCount: items.length };
  }

  async triggerCloudflareWorker(photoId: string, r2KeyOriginal: string): Promise<void> {
    const modalUrl = (process.env.THUMBNAIL_ENGINE_URL || 'https://sahilshah778800--thumbnail-engine-fastapi-app.modal.run') + '/generate-thumbnail';
    let selectedUrl = process.env.USE_MODAL_THUMBNAILS !== 'false' ? modalUrl : (process.env.THUMBNAIL_WORKER_URL || modalUrl);

    if (!selectedUrl.endsWith('/generate-thumbnail') && !selectedUrl.endsWith('/generate-batch-thumbnails')) {
      selectedUrl = `${selectedUrl.replace(/\/$/, '')}/generate-thumbnail`;
    }

    this.logger.log(`[Worker Trigger] Dispatching item ${photoId} to Modal CPU Thumbnail Engine: ${selectedUrl}`);

    try {
      const res = await fetch(selectedUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          objectKey: r2KeyOriginal,
          photoId: photoId
        }),
        signal: AbortSignal.timeout(30000)
      });

      this.logger.log(`[Worker Trigger] Response status from ${selectedUrl} for photo ${photoId}: ${res.status}`);
      if (res.ok) {
        const data: any = await res.json();
        const result = data?.results?.[0];
        if (result && result.success && result.thumbKey) {
          this.logger.log(`[Worker Trigger] Updating DB thumbnailStatus to READY for photo: ${photoId} (thumb: ${result.thumbSize}B, preview: ${result.previewSize}B)`);
          await this.completeThumbnailWebhook({
            photoId: photoId,
            thumbKey: result.thumbKey,
            previewKey: result.previewKey || null,
            thumbSize: result.thumbSize,
            previewSize: result.previewSize,
            secretKey: process.env.WORKER_SECRET_KEY || ''
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

    const modalUrl = (process.env.THUMBNAIL_ENGINE_URL || 'https://sahilshah778800--thumbnail-engine-fastapi-app.modal.run') + '/generate-thumbnail';
    let selectedUrl = process.env.USE_MODAL_THUMBNAILS !== 'false' ? modalUrl : (process.env.THUMBNAIL_WORKER_URL || modalUrl);

    if (!selectedUrl.endsWith('/generate-thumbnail') && !selectedUrl.endsWith('/generate-batch-thumbnails')) {
      selectedUrl = `${selectedUrl.replace(/\/$/, '')}/generate-thumbnail`;
    }

    const chunkSize = 20;
    const chunks: { photoId: string; objectKey: string }[][] = [];
    for (let i = 0; i < photos.length; i += chunkSize) {
      chunks.push(photos.slice(i, i + chunkSize).map(p => ({ photoId: p.id, objectKey: p.r2KeyOriginal })));
    }

    this.logger.log(`[GoWorkerBatch] Dispatching ${chunks.length} parallel batches to CPU Resizer...`);

    const promises = chunks.map(async (chunk, index) => {
      try {
        const res = await fetch(selectedUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: chunk }),
          signal: AbortSignal.timeout(30000)
        });

        if (res.ok) {
          const data: any = await res.json();
          if (data && data.results) {
            const readyItems = data.results.filter((r: any) => r.success);
            for (const item of readyItems) {
              const tSize = item.thumbSize ? BigInt(item.thumbSize) : BigInt(0);
              const pSize = item.previewSize ? BigInt(item.previewSize) : BigInt(0);
              await this.prisma.photo.update({
                where: { id: item.photoId },
                data: {
                  r2KeyThumb: item.thumbKey,
                  r2KeyPreview: item.previewKey || null,
                  thumbSizeBytes: tSize,
                  previewSizeBytes: pSize,
                  thumbnailStatus: 'READY',
                  status: 'READY'
                }
              }).catch(() => { });
            }
            this.logger.log(`[GoWorkerBatch] Batch #${index + 1} processed ${readyItems.length}/${chunk.length} items successfully.`);
            if (readyItems.length > 0) {
              const samplePhoto = await this.prisma.photo.findUnique({
                where: { id: readyItems[0].photoId },
                select: { eventId: true }
              });
              if (samplePhoto) {
                await this.invalidateEventCache(samplePhoto.eventId);
              }
            }
          }
        }
      } catch (err: any) {
        this.logger.error(`[GoWorkerBatch] Error in parallel batch #${index + 1} via ${selectedUrl}: ${err.message}`);
      }
    });

    // Run all batch calls concurrently so Modal scale-out starts immediately
    await Promise.all(promises);
  }

  // AI Face Toggle ON hone par ya Thumbnail complete hone par Batch Scan chalata hai (with Auto-Recheck loop)
  async triggerFaceScanForEvent(photographerId: string, eventId: string): Promise<void> {
    if (this.activeEventScans.has(eventId)) {
      this.logger.log(`[BatchFaceScan] Scanning is already active for event ${eventId}. Skipping trigger.`);
      return;
    }
    const initialEventObj = await this.prisma.event.findUnique({ where: { id: eventId } });
    if (!initialEventObj) return;

    this.activeEventScans.add(eventId);

    try {
      // Reset any stuck faceScanStatus from 'PROCESSING' to 'PENDING' at start to allow reprocessing if server crashed
      await this.prisma.photo.updateMany({
        where: { eventId, faceScanStatus: 'PROCESSING' },
        data: { faceScanStatus: 'PENDING' }
      });

      while (true) {
        // Re-fetch event settings on EVERY iteration so toggle changes are picked up dynamically
        const eventObj = await this.prisma.event.findUnique({ where: { id: eventId } });
        if (!eventObj) break;

        // Enforce toggle settings dynamically and verify photographer's active plan features
        const activeSub = await this.prisma.subscription.findFirst({
          where: { photographerId, status: 'ACTIVE' },
          include: { package: true }
        });
        const hasPhotoAi = activeSub?.package ? activeSub.package.featureAiPhotoSearch : false;
        const hasVideoAi = activeSub?.package ? activeSub.package.featureAiVideoSearch : false;

        const isPhotoScanningActive = Boolean(eventObj.faceScanningEnabled && hasPhotoAi);
        const isVideoScanningActive = Boolean(eventObj.videoScanningEnabled && hasVideoAi);

        if (!isPhotoScanningActive && !isVideoScanningActive) {
          this.logger.log(`[BatchFaceScan] Both photo and video scanning are disabled or not included in plan. Aborting loop.`);
          break;
        }

        // Check if there are active uploads in progress for this event
        const activeUploadingCount = await this.prisma.photo.count({
          where: { eventId, status: 'UPLOADING' }
        });

        // Build type filter from active settings
        const typeFilter: string[] = [];
        if (isPhotoScanningActive) typeFilter.push('IMAGE');
        if (isVideoScanningActive) typeFilter.push('VIDEO');

        const pendingItems = await this.prisma.photo.findMany({
          where: {
            eventId,
            photographerId,
            status: 'READY',
            faceScanStatus: { notIn: ['PROCESSING', 'READY'] },
            type: { in: typeFilter },
            OR: [
              { thumbnailStatus: 'READY' },
              { r2KeyThumb: { not: null } }
            ],
            embeddings: { none: {} }
          },
          take: 30
        });

        if (pendingItems.length === 0) {
          this.logger.log(`[BatchFaceScan] All ready items for event ${eventId} are scanned. Loop finished.`);
          break;
        }

        // Rule: If uploading is currently active and we have less than 30 ready items, defer scanning until 30 accumulate or uploading finishes
        if (activeUploadingCount > 0 && pendingItems.length < 30) {
          this.logger.log(`[BatchFaceScan] Uploading in progress (${activeUploadingCount} uploading). Waiting for 30 items or upload finish. Current ready: ${pendingItems.length}`);
          break;
        }

        this.logger.log(`[BatchFaceScan] Found ${pendingItems.length} items to batch scan for event ${eventId}`);

        const photos = pendingItems.filter(p => p.type === 'IMAGE');
        const videos = pendingItems.filter(p => p.type === 'VIDEO');

        // Enforce pay-per-use credits for photos
        const photographer = await this.prisma.photographer.findUnique({
          where: { id: photographerId }
        });
        const currentCredits = photographer?.creditBalance || 0;
        const maxPhotosAllowed = Math.floor(currentCredits / 10);

        if (maxPhotosAllowed === 0) {
          this.logger.warn(`[BatchFaceScan] Photographer ${photographerId} has insufficient credits (${currentCredits} paise). Skipping photo scanning.`);
          // Mark as SKIPPED (not READY) so the UI knows these were NOT actually scanned
          const photoIds = photos.map(p => p.id);
          if (photoIds.length > 0) {
            await this.prisma.photo.updateMany({
              where: { id: { in: photoIds } },
              data: { faceScanStatus: 'SKIPPED', status: 'READY' }
            });
            for (const p of photos) {
              if (p.uploadBatchId) {
                await this.updateBatchProgress(p.uploadBatchId, true);
              }
            }
          }
          // Also mark videos as SKIPPED — no credits for AI scanning
          const videoIds = videos.map(v => v.id);
          if (videoIds.length > 0) {
            await this.prisma.photo.updateMany({
              where: { id: { in: videoIds } },
              data: { faceScanStatus: 'SKIPPED', status: 'READY' }
            });
            for (const v of videos) {
              if (v.uploadBatchId) {
                await this.updateBatchProgress(v.uploadBatchId, true);
              }
            }
          }
          // Auto-disable scanning toggles on this event since credits are exhausted
          await this.prisma.event.update({
            where: { id: eventId },
            data: { faceScanningEnabled: false, videoScanningEnabled: false }
          });
          await this.invalidateEventCache(eventId);
          this.logger.warn(`[BatchFaceScan] Credits exhausted. Auto-disabled scanning toggles for event ${eventId}. Breaking out of scan loop.`);
          break; // Fully stop the loop — no more scanning possible
        } else if (photos.length > maxPhotosAllowed) {
          const scannablePhotos = photos.slice(0, maxPhotosAllowed);
          const skippedPhotos = photos.slice(maxPhotosAllowed);

          this.logger.warn(`[BatchFaceScan] Photographer ${photographerId} has credits for only ${maxPhotosAllowed} photos. Skipping remaining ${skippedPhotos.length} photos.`);
          const skippedIds = skippedPhotos.map(p => p.id);
          await this.prisma.photo.updateMany({
            where: { id: { in: skippedIds } },
            data: { faceScanStatus: 'SKIPPED', status: 'READY' }
          });
          for (const p of skippedPhotos) {
            if (p.uploadBatchId) {
              await this.updateBatchProgress(p.uploadBatchId, true);
            }
          }

          photos.length = 0;
          photos.push(...scannablePhotos);
        }

        // Mark items as PROCESSING
        const finalPendingItems = [...photos, ...videos];
        if (finalPendingItems.length === 0) {
          await new Promise(resolve => setTimeout(resolve, 300));
          continue;
        }

        const itemIds = finalPendingItems.map(p => p.id);
        await this.prisma.photo.updateMany({
          where: { id: { in: itemIds } },
          data: { faceScanStatus: 'PROCESSING' }
        });

        // 1. Process Batch of Photos in 1 SINGLE HTTP Request to Modal GPU (/faces/index-batch-photos)
        if (photos.length > 0) {
          try {
            const faceEngineUrl = process.env.FACE_ENGINE_URL || 'https://sahilshah778800--face-engine-fastapi-app.modal.run';
            const photoBatchPayload: { photoId: string; imageUrl: string }[] = [];

            for (const photo of photos) {
              // Use real r2KeyPreview if present in database (correct .jpg extension for HEIC/images), fallback to r2KeyOriginal
              const scanKey = photo.r2KeyPreview || photo.r2KeyOriginal;
              const signedUrl = await this.getReadUrl(scanKey);
              if (signedUrl) {
                photoBatchPayload.push({ photoId: photo.id, imageUrl: signedUrl });
              }
            }

            if (photoBatchPayload.length > 0) {
              const backendAppUrl = process.env.APP_URL || process.env.NEXT_PUBLIC_API_URL || 'https://api.fotosetgo.com';
              const webhookUrl = `${backendAppUrl}/api/public/webhook/photo-face-complete`;
              const secretKey = process.env.WORKER_SECRET_KEY || '';

              const response = await fetch(`${faceEngineUrl}/faces/index-batch-photos`, {
                method: 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  'x-api-key': process.env.MODAL_API_KEY || ''
                },
                body: JSON.stringify({
                  eventId,
                  photographerId,
                  items: photoBatchPayload,
                  webhookUrl,
                  secretKey
                }),
                signal: AbortSignal.timeout(40000)
              });

              if (response.ok) {
                const batchResult = await response.json();
                if (batchResult && batchResult.results) {
                  // Synchronous return from Modal: complete using standard webhook handler
                  await this.completePhotoFaceWebhook({
                    eventId,
                    photographerId,
                    results: batchResult.results,
                    secretKey
                  });
                } else if (batchResult && batchResult.status === 'QUEUED') {
                  this.logger.log(`[BatchFaceScan] Batch of ${photoBatchPayload.length} photos queued in Modal worker. Result will arrive via Webhook.`);
                }
              }
            }
          } catch (batchErr: any) {
            this.logger.error(`[BatchFaceScan] Photo batch scanning dispatch error for event ${eventId}: ${batchErr.message}`);
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

