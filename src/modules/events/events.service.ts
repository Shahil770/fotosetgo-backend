import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { StorageService } from '../storage/storage.service';

@Injectable()
export class EventsService {
  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
  ) { }

  async create(photographerId: string, data: any) {
    const slug = data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') + '-' + Math.floor(1000 + Math.random() * 9000);
    return this.prisma.event.create({
      data: {
        photographerId,
        title: data.title,
        slug,
        eventType: data.eventType || 'Other',
        description: data.description,
        location: data.location,
        eventDate: data.eventDate ? new Date(data.eventDate) : null,
        visibility: data.visibility || 'PRIVATE',
        status: data.status || 'DRAFT',
        allowDownload: data.allowDownload !== undefined ? data.allowDownload : false,
        passcode: data.passcode !== undefined ? data.passcode : '1234',
        maxFavorites: data.maxFavorites !== undefined ? Number(data.maxFavorites) : 0,
        watermarkEnabled: data.watermarkEnabled !== undefined ? data.watermarkEnabled : false,
        themeKey: data.themeKey || 'CLASSIC_LIGHT',
        applyThemeToClientGallery: data.applyThemeToClientGallery !== undefined ? data.applyThemeToClientGallery : false,
      },
    });
  }

  async findAll(photographerId: string) {
    const events = await this.prisma.event.findMany({
      where: { photographerId, isDeleted: false },
      orderBy: { createdAt: 'desc' },
      include: {
        photos: {
          where: { isDeleted: false },
        },
        _count: {
          select: { photos: { where: { isDeleted: false } } },
        },
      },
    });

    // Map each photo to include its dynamically signed GET URL
    return Promise.all(
      events.map(async (event) => {
        const photosWithUrls = await Promise.all(
          event.photos.map(async (photo) => {
            const url = await this.storageService.getReadUrl(photo.r2KeyOriginal);
            const thumbUrl = photo.r2KeyThumb
              ? await this.storageService.getReadUrl(photo.r2KeyThumb)
              : url;
            return { ...photo, url, thumbUrl };
          }),
        );
        return { ...event, photos: photosWithUrls };
      }),
    );
  }

  async findOne(photographerId: string, eventId: string) {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, photographerId, isDeleted: false },
      include: {
        photos: {
          where: { isDeleted: false },
        },
      },
    });

    if (!event) {
      throw new NotFoundException('Event not found');
    }

    const photosWithUrls = await Promise.all(
      event.photos.map(async (photo) => {
        const url = await this.storageService.getReadUrl(photo.r2KeyOriginal);
        const thumbUrl = photo.r2KeyThumb
          ? await this.storageService.getReadUrl(photo.r2KeyThumb)
          : url;
        return { ...photo, url, thumbUrl };
      }),
    );

    return { ...event, photos: photosWithUrls };
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

    const faceScanningEnabled = hasPhotoAi ? data.faceScanningEnabled : false;
    const videoScanningEnabled = hasVideoAi ? data.videoScanningEnabled : false;

    if (
      (faceScanningEnabled === true && event.faceScanningEnabled === false) ||
      (videoScanningEnabled === true && event.videoScanningEnabled === false)
    ) {
      this.storageService.reindexEventPhotos(photographerId, eventId).catch(err => {
        console.error('[EventsService] Failed to trigger auto re-indexing on toggle on:', err);
      });
    }

    return this.prisma.event.update({
      where: { id: eventId },
      data: {
        title: data.title,
        description: data.description,
        location: data.location,
        eventType: data.eventType,
        eventDate: data.eventDate ? new Date(data.eventDate) : undefined,
        status: data.status,
        visibility: data.visibility,
        passcode: data.passcode,
        allowDownload: data.allowDownload,
        allowFavorites: data.allowFavorites,
        faceSearchEnabled: data.faceSearchEnabled,
        faceScanningEnabled,
        videoScanningEnabled,
        maxFavorites: data.maxFavorites !== undefined ? Number(data.maxFavorites) : undefined,
        watermarkEnabled: data.watermarkEnabled,
        themeKey: data.themeKey,
        applyThemeToClientGallery: data.applyThemeToClientGallery,
        allowGuestUploads: data.allowGuestUploads,
        maxGuestUploadFiles: data.maxGuestUploadFiles !== undefined ? Number(data.maxGuestUploadFiles) : undefined,
        maxGuestUploadStorage: data.maxGuestUploadStorage !== undefined ? BigInt(data.maxGuestUploadStorage) : undefined,
      },
    });
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

    return { success: true, message: 'Event moved to trash' };
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

    return deleteResult;
  }




}
