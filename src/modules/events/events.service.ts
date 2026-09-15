import { Injectable, NotFoundException, BadRequestException, ForbiddenException, Inject } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { StorageService } from '../storage/storage.service';
import Redis from 'ioredis';

@Injectable()
export class EventsService {
  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
    @Inject('REDIS_CLIENT') private redis: Redis,
  ) { }

  private async invalidateCache(photographerId: string, eventId?: string) {
    try {
      const listKeys = await this.redis.keys(`cache:events:list:${photographerId}*`);
      const keys = [...listKeys];
      if (eventId) {
        keys.push(`cache:event:detail:${eventId}`);
        // Fetch event slug and ftpUsername to clear public caches and Beam credentials
        const event = await this.prisma.event.findUnique({ where: { id: eventId }, select: { slug: true, ftpUsername: true } });
        if (event?.slug) {
          keys.push(`cache:public:event:${event.slug}`);
          keys.push(`cache:public:photos:${event.slug}`);
        }
        if (event?.ftpUsername) {
          keys.push(`auth:ftp:${event.ftpUsername}`);
          keys.push(`beam:auth:${event.ftpUsername}`);
        }
      }
      if (keys.length > 0) {
        await this.redis.del(...keys);
      }
    } catch (err) {
      console.error('[EventsService] Failed to invalidate Redis cache:', err);
    }
  }

  async create(photographerId: string, data: any) {
    // Plan check: block disabling downloads if plan doesn't support it
    if (data.allowDownload === false) {
      const activeSub = await this.prisma.subscription.findFirst({
        where: { photographerId, status: 'ACTIVE' },
        include: { package: true },
        orderBy: { createdAt: 'desc' }
      });
      const canDisableDownload = activeSub?.package?.featureDisableDownload ?? false;
      if (!canDisableDownload) {
        throw new ForbiddenException('Your current plan does not support disabling photo downloads. Please upgrade.');
      }
    }

    const slug = data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Math.floor(1000 + Math.random() * 9000);
    const event = await this.prisma.event.create({
      data: {
        photographerId,
        title: data.title,
        slug,
        location: data.location,
        eventDate: data.eventDate ? new Date(data.eventDate) : null,
        visibility: data.visibility || 'PRIVATE',
        status: data.status || 'DRAFT',
        allowDownload: data.allowDownload !== undefined ? data.allowDownload : true,
        passcode: data.passcode !== undefined ? String(data.passcode).slice(0, 6) : '123456',
        allowFavorites: data.allowFavorites !== undefined ? Boolean(data.allowFavorites) : false,
        maxFavorites: data.maxFavorites !== undefined ? Number(data.maxFavorites) : 0,
        watermarkEnabled: data.watermarkEnabled !== undefined ? Boolean(data.watermarkEnabled) : false,
        faceSearchEnabled: data.faceSearchEnabled !== undefined ? Boolean(data.faceSearchEnabled) : false,
        themeKey: data.themeKey || 'CLASSIC_LIGHT',
        applyThemeToClientGallery: data.applyThemeToClientGallery !== undefined ? data.applyThemeToClientGallery : false,
        allowGuestUploads: data.allowGuestUploads !== undefined ? Boolean(data.allowGuestUploads) : false,
        maxGuestUploadFiles: data.maxGuestUploadFiles !== undefined ? Math.min(200, Math.max(1, Number(data.maxGuestUploadFiles))) : 200,
        maxGuestUploadStorage: data.maxGuestUploadStorage !== undefined ? BigInt(Math.min(500 * 1024 * 1024, Number(data.maxGuestUploadStorage))) : BigInt(500 * 1024 * 1024),
        beamUploadMode: 'PHOTOS_ONLY',
      },
    });
    await this.invalidateCache(photographerId);
    return event;
  }

  async findAll(
    photographerId: string,
    query?: { page?: number; limit?: number; search?: string; status?: string }
  ) {
    const page = Math.max(1, query?.page || 1);
    const limit = Math.min(Math.max(1, query?.limit || 12), 50);
    const skip = (page - 1) * limit;
    const search = query?.search?.trim() || '';
    const status = query?.status?.toUpperCase();

    const cacheKey = `cache:events:list:${photographerId}:${page}:${limit}:${search}:${status || ''}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      console.error('[EventsService] Redis get failed inside findAll:', err);
    }

    const where: any = {
      photographerId,
      isDeleted: false,
    };

    const conditions: any[] = [];

    if (search) {
      conditions.push({
        OR: [
          { title: { contains: search, mode: 'insensitive' } },
          { location: { contains: search, mode: 'insensitive' } },
          { slug: { contains: search, mode: 'insensitive' } },
        ],
      });
    }

    if (status === 'PUBLISHED') {
      conditions.push({
        status: 'PUBLISHED',
        visibility: { not: 'PRIVATE' },
      });
    } else if (status === 'DRAFT') {
      conditions.push({
        OR: [
          { status: 'DRAFT' },
          { visibility: 'PRIVATE' },
        ],
      });
    }

    if (conditions.length > 0) {
      where.AND = conditions;
    }

    const [total, events] = await Promise.all([
      this.prisma.event.count({ where }),
      this.prisma.event.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
        include: {
          _count: {
            select: { photos: { where: { isDeleted: false } } },
          },
          photos: {
            where: { isDeleted: false },
            orderBy: { createdAt: 'desc' },
            take: 5,
            select: { id: true, r2KeyThumb: true, r2KeyPreview: true, r2KeyOriginal: true, type: true },
          },
        },
      }),
    ]);

    const eventIds = events.map((e) => e.id);
    let storageGroup: any[] = [];
    let typeGroup: any[] = [];

    if (eventIds.length > 0) {
      [storageGroup, typeGroup] = await Promise.all([
        this.prisma.photo.groupBy({
          by: ['eventId'],
          where: { eventId: { in: eventIds }, isDeleted: false },
          _sum: { fileSize: true, thumbSizeBytes: true, previewSizeBytes: true },
        }),
        this.prisma.photo.groupBy({
          by: ['eventId', 'type'],
          where: { eventId: { in: eventIds }, isDeleted: false },
          _count: { id: true },
        }),
      ]);
    }

    const storageMap: Record<string, number> = {};
    for (const item of storageGroup) {
      const sum =
        Number(item._sum.fileSize || 0) +
        Number(item._sum.thumbSizeBytes || 0) +
        Number(item._sum.previewSizeBytes || 0);
      storageMap[item.eventId] = sum;
    }

    const mediaCountMap: Record<string, { photos: number; videos: number }> = {};
    for (const item of typeGroup) {
      if (!mediaCountMap[item.eventId]) {
        mediaCountMap[item.eventId] = { photos: 0, videos: 0 };
      }
      if (item.type === 'VIDEO') {
        mediaCountMap[item.eventId].videos += item._count.id;
      } else {
        mediaCountMap[item.eventId].photos += item._count.id;
      }
    }

    const results = await Promise.all(
      events.map(async (event: any) => {
        const coverPhoto = event.photos?.[0];
        let autoCover: string | null = null;
        if (coverPhoto) {
          const isVideo = coverPhoto.type === 'VIDEO' || coverPhoto.mimeType?.startsWith('video');
          const key = isVideo
            ? (coverPhoto.r2KeyThumb || coverPhoto.r2KeyPreview)
            : (coverPhoto.r2KeyPreview || coverPhoto.r2KeyOriginal || coverPhoto.r2KeyThumb);
          if (key) {
            try {
              autoCover = await this.storageService.getReadUrl(key);
            } catch (err) {
              console.error(`[EventsService] Failed to sign cover URL for event ${event.id}:`, err);
            }
          }
        }
        const mediaCounts = mediaCountMap[event.id] || { photos: event._count?.photos || 0, videos: 0 };
        return {
          ...event,
          coverPhotoId: autoCover,
          storageUsedBytes: storageMap[event.id] || 0,
          photosCount: mediaCounts.photos,
          videosCount: mediaCounts.videos,
          photos: event.photos || [],
        };
      })
    );

    const totalPages = Math.ceil(total / limit);
    const responsePayload = {
      events: results,
      total,
      page,
      limit,
      totalPages,
      hasMore: page < totalPages,
    };

    try {
      await this.redis.set(cacheKey, JSON.stringify(responsePayload), 'EX', 120); // 2 minutes cache TTL
    } catch (err) {
      console.error('[EventsService] Redis set failed inside findAll:', err);
    }

    return responsePayload;
  }

  async findOne(photographerId: string, eventId: string) {
    const cacheKey = `cache:event:detail:${eventId}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached);
    } catch (err) {
      console.error('[EventsService] Redis get failed inside findOne:', err);
    }

    const event = await this.prisma.event.findFirst({
      where: { id: eventId, photographerId, isDeleted: false },
      include: {
        photos: {
          where: { isDeleted: false, status: 'READY' },
          orderBy: { createdAt: 'desc' }
        },
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    // Process signed URLs in concurrent chunks of 50 for fast response and minimal latency
    const batchSize = 50;
    const photosWithUrls: any[] = [];
    
    for (let i = 0; i < event.photos.length; i += batchSize) {
      const batch = event.photos.slice(i, i + batchSize);
      const signedBatch = await Promise.all(
        batch.map(async (photo) => {
          try {
            const isVideo = photo.type === 'VIDEO';
            const fullKey = isVideo
              ? photo.r2KeyOriginal
              : (photo.r2KeyPreview || photo.r2KeyOriginal || photo.r2KeyThumb);
            const url = fullKey ? await this.storageService.getReadUrl(fullKey) : '';
            const previewUrl = isVideo
              ? (photo.r2KeyThumb ? await this.storageService.getReadUrl(photo.r2KeyThumb) : url)
              : (photo.r2KeyPreview ? await this.storageService.getReadUrl(photo.r2KeyPreview) : url);
            const thumbUrl = photo.r2KeyThumb
              ? await this.storageService.getReadUrl(photo.r2KeyThumb)
              : (isVideo ? url : previewUrl);
            return { ...photo, url, previewUrl, thumbUrl };
          } catch (err) {
            console.error(`[EventsService] Failed to sign URL for photo ${photo.id}:`, err);
            return { ...photo, url: '', previewUrl: '', thumbUrl: '' };
          }
        })
      );
      photosWithUrls.push(...signedBatch);
    }

    const result = { ...event, photos: photosWithUrls };

    try {
      await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 600); // 10 minutes cache TTL
    } catch (err) {
      console.error('[EventsService] Redis set failed inside findOne:', err);
    }

    return result;
  }

  async update(photographerId: string, eventId: string, data: any) {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, photographerId, isDeleted: false },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const activeSub = await this.prisma.subscription.findFirst({
      where: { photographerId, status: 'ACTIVE' },
      include: { package: true },
      orderBy: { createdAt: 'desc' }
    });

    const hasPhotoAi = activeSub?.package ? activeSub.package.featureAiPhotoSearch : false;
    const hasVideoAi = activeSub?.package ? activeSub.package.featureAiVideoSearch : false;
    const canDisableDownload = activeSub?.package ? activeSub.package.featureDisableDownload : false;

    // Block disabling downloads if plan doesn't support it
    if (data.allowDownload === false && !canDisableDownload) {
      throw new ForbiddenException('Your current plan does not support disabling photo downloads. Please upgrade.');
    }

    const faceScanningEnabled = data.faceScanningEnabled !== undefined ? (hasPhotoAi ? Boolean(data.faceScanningEnabled) : false) : undefined;
    const videoScanningEnabled = data.videoScanningEnabled !== undefined ? (hasVideoAi ? Boolean(data.videoScanningEnabled) : false) : undefined;

    const updatedEvent = await this.prisma.event.update({
      where: { id: eventId },
      data: {
        title: data.title,
        location: data.location,
        eventDate: data.eventDate ? new Date(data.eventDate) : undefined,
        status: data.status,
        visibility: data.visibility,
        passcode: data.passcode !== undefined ? String(data.passcode).slice(0, 6) : undefined,
        allowDownload: data.allowDownload !== undefined ? Boolean(data.allowDownload) : undefined,
        allowFavorites: data.allowFavorites !== undefined ? Boolean(data.allowFavorites) : undefined,
        faceSearchEnabled: data.faceSearchEnabled !== undefined ? Boolean(data.faceSearchEnabled) : undefined,
        faceScanningEnabled: faceScanningEnabled !== undefined ? faceScanningEnabled : undefined,
        videoScanningEnabled: videoScanningEnabled !== undefined ? videoScanningEnabled : undefined,
        maxFavorites: data.maxFavorites !== undefined ? Number(data.maxFavorites) : undefined,
        watermarkEnabled: data.watermarkEnabled,
        themeKey: data.themeKey,
        applyThemeToClientGallery: data.applyThemeToClientGallery,
        allowGuestUploads: data.allowGuestUploads,
        maxGuestUploadFiles: data.maxGuestUploadFiles !== undefined ? Math.min(200, Math.max(1, Number(data.maxGuestUploadFiles))) : undefined,
        maxGuestUploadStorage: data.maxGuestUploadStorage !== undefined ? BigInt(Math.min(500 * 1024 * 1024, Number(data.maxGuestUploadStorage))) : undefined,
      },
    });

    if (
      (faceScanningEnabled === true && event.faceScanningEnabled === false) ||
      (videoScanningEnabled === true && event.videoScanningEnabled === false)
    ) {
      // Check credit balance before allowing scan toggle ON
      const photographer = await this.prisma.photographer.findUnique({
        where: { id: photographerId },
        select: { creditBalance: true }
      });
      const credits = photographer?.creditBalance || 0;
      if (credits <= 0) {
        // Revert the toggle — don't allow turning on scanning with 0 credits
        await this.prisma.event.update({
          where: { id: eventId },
          data: {
            faceScanningEnabled: event.faceScanningEnabled,
            videoScanningEnabled: event.videoScanningEnabled
          }
        });
        throw new BadRequestException({
          message: 'Insufficient AI scan credits. Please buy more credits to enable scanning.',
          insufficientCredits: true,
          currentBalance: credits
        });
      }

      // 1. If turning ON: Restore any previously scanned photos to READY, and reset truly pending unscanned photos
      if (faceScanningEnabled === true && event.faceScanningEnabled === false) {
        // Restore photos that already have faces/embeddings back to READY
        await this.prisma.photo.updateMany({
          where: {
            eventId,
            type: 'IMAGE',
            hasFaces: true,
          },
          data: { faceScanStatus: 'READY' }
        }).catch(() => {});

        // Reset truly unscanned photos from SKIPPED to PENDING so scanner can pick them up
        await this.prisma.photo.updateMany({
          where: {
            eventId,
            type: 'IMAGE',
            hasFaces: false,
            faceScanStatus: 'SKIPPED',
          },
          data: { faceScanStatus: 'PENDING' }
        }).catch(() => {});
      }

      // 2. Trigger face scan after DB has been successfully updated
      this.storageService.triggerFaceScanForEvent(photographerId, eventId).catch(err => {
        console.error('[EventsService] Failed to trigger face scan on toggle on:', err);
      });
    }

    // If face/video scanning is turned OFF, safely release only un-scanned photos without corrupting scanned ones
    if (faceScanningEnabled === false && event.faceScanningEnabled === true) {
      await this.prisma.photo.updateMany({
        where: {
          eventId,
          faceScanStatus: { in: ['PENDING', 'PROCESSING'] },
          hasFaces: false,
          type: 'IMAGE',
          thumbnailStatus: 'READY'
        },
        data: {
          faceScanStatus: 'SKIPPED',
          status: 'READY'
        }
      }).catch(() => {});
    }

    if (videoScanningEnabled === false && event.videoScanningEnabled === true) {
      await this.prisma.photo.updateMany({
        where: {
          eventId,
          faceScanStatus: { in: ['PENDING', 'PROCESSING'] },
          hasFaces: false,
          type: 'VIDEO',
          thumbnailStatus: 'READY'
        },
        data: {
          faceScanStatus: 'SKIPPED',
          status: 'READY'
        }
      }).catch(() => {});
    }

    await this.invalidateCache(photographerId, eventId);
    return updatedEvent;
  }

  // Soft delete event and all its child photos/videos (Move to Trash)
  async softDelete(photographerId: string, eventId: string) {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, photographerId, isDeleted: false },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const now = new Date();

    // Mark event deleted
    await this.prisma.event.update({
      where: { id: eventId },
      data: { isDeleted: true, deletedAt: now },
    });

    // Mark all photos under this event as soft deleted
    await this.prisma.photo.updateMany({
      where: { eventId },
      data: { isDeleted: true, deletedAt: now },
    });

    await this.invalidateCache(photographerId, eventId);
    return { success: true, message: 'Event moved to trash' };
  }

  // Bulk Soft delete events and all their child photos/videos (Move to Trash)
  async bulkSoftDelete(photographerId: string, eventIds: string[]) {
    if (!eventIds || eventIds.length === 0) return { success: true, count: 0 };
    const now = new Date();

    await this.prisma.event.updateMany({
      where: { id: { in: eventIds }, photographerId, isDeleted: false },
      data: { isDeleted: true, deletedAt: now },
    });

    await this.prisma.photo.updateMany({
      where: { eventId: { in: eventIds }, photographerId },
      data: { isDeleted: true, deletedAt: now },
    });

    await this.invalidateCache(photographerId);
    return { success: true, count: eventIds.length, message: `${eventIds.length} events moved to trash` };
  }

  // Restore event from trash
  async restore(photographerId: string, eventId: string) {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, photographerId, isDeleted: true },
    });

    if (!event) {
      throw new NotFoundException('Deleted event not found in trash');
    }

    // Restore event
    await this.prisma.event.update({
      where: { id: eventId },
      data: { isDeleted: false, deletedAt: null },
    });

    // Restore all child photos
    await this.prisma.photo.updateMany({
      where: { eventId },
      data: { isDeleted: false, deletedAt: null },
    });

    await this.invalidateCache(photographerId, eventId);
    return { success: true, message: 'Event restored successfully' };
  }

  // Hard delete event permanently (from Trash)
  async remove(photographerId: string, eventId: string) {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, photographerId },
      include: { photos: true }
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    // 1. Delete all photo DB records and individual R2 files
    await Promise.all(
      event.photos.map(async (photo) => {
        try {
          await this.storageService.deletePhoto(photographerId, photo.id);
        } catch (err) {
          console.error(`Failed to delete photo ${photo.id} during event removal:`, err);
        }
      })
    );

    // 2. Direct wipe of all remaining R2 objects under this event's R2 prefixes
    await this.storageService.deleteEventObjectsFromR2(photographerId, eventId);

    // 3. Delete event database record
    const deleteResult = await this.prisma.event.delete({
      where: { id: eventId },
    });

    // 4. Live calculate storage directly from Cloudflare R2 bucket listing
    await this.storageService.recalculateStorage(photographerId);

    await this.invalidateCache(photographerId, eventId);
    return deleteResult;
  }




}
