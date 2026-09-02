import { Injectable, Logger, NotFoundException, BadRequestException, Inject, OnModuleInit } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { StorageService } from '../storage/storage.service';
import Redis from 'ioredis';
import { v4 as uuidv4 } from 'uuid';

const BEAM_SESSION_TTL_SECONDS = 14400; // 4 Hours (14,400 seconds)

@Injectable()
export class BeamService implements OnModuleInit {
  private readonly logger = new Logger(BeamService.name);
  private oracleRedis: Redis | null = null;

  constructor(
    private prisma: PrismaService,
    private storageService: StorageService,
    @Inject('REDIS_CLIENT') private redis: Redis,
  ) {}

  onModuleInit() {
    const oracleUrl = process.env.ORACLE_REDIS_URL;
    if (oracleUrl) {
      try {
        this.oracleRedis = new Redis(oracleUrl, {
          lazyConnect: true,
          maxRetriesPerRequest: 1,
          retryStrategy: (times) => Math.min(times * 1000, 10000),
          connectTimeout: 4000,
        });
        this.oracleRedis.on('error', (err) => {
          // Suppress unhandled error crash when tunnel is inactive
        });
        this.oracleRedis.connect().then(() => {
          this.logger.log('[BeamService] Successfully connected to Oracle Cloud Redis via SSH Tunnel (Port 6380)');
        }).catch(err => {
          this.logger.warn(`[BeamService] Oracle Cloud Redis connect warning (Tunnel inactive): ${err.message}`);
        });
      } catch (err: any) {
        this.logger.warn(`[BeamService] Oracle Redis init warning: ${err.message}`);
      }
    }
  }

  private async syncToAllRedis(key: string, value: string, op: 'set' | 'del' = 'set', ttlSeconds?: number) {
    // 1. Sync to local Redis
    try {
      if (op === 'set') {
        if (ttlSeconds && ttlSeconds > 0) {
          await this.redis.set(key, value, 'EX', ttlSeconds);
        } else {
          await this.redis.set(key, value);
        }
      } else {
        await this.redis.del(key);
      }
    } catch (err: any) {
      this.logger.error(`[BeamService] Local Redis sync failed for ${key}: ${err.message}`);
    }

    // 2. Sync to Oracle Cloud Redis (when connected/tunneled)
    if (this.oracleRedis && this.oracleRedis.status === 'ready') {
      try {
        if (op === 'set') {
          if (ttlSeconds && ttlSeconds > 0) {
            await this.oracleRedis.set(key, value, 'EX', ttlSeconds);
          } else {
            await this.oracleRedis.set(key, value);
          }
        } else {
          await this.oracleRedis.del(key);
        }
        this.logger.log(`[BeamService] Successfully synced ${key} (${op}) to Oracle Cloud Redis`);
      } catch (err: any) {
        this.logger.warn(`[BeamService] Oracle Redis sync failed: ${err.message}`);
      }
    }
  }

  private async checkBeamPlanAccess(photographerId: string) {
    const activeSub = await this.prisma.subscription.findFirst({
      where: { photographerId, status: 'ACTIVE' },
      include: { package: true },
      orderBy: { createdAt: 'desc' }
    });
    const hasBeam = activeSub?.package ? activeSub.package.featureBeamLiveCamera : false;
    if (!hasBeam) {
      throw new BadRequestException('Beam Live Camera (FTP Ingestion) is not included in your current plan. Please upgrade to unlock.');
    }
  }

  async getCredentials(photographerId: string, eventId: string) {
    const event = await this.prisma.event.findFirst({
      where: { id: eventId, photographerId, isDeleted: false },
    });
    if (!event) throw new NotFoundException('Event not found');

    const activeSub = await this.prisma.subscription.findFirst({
      where: { photographerId, status: 'ACTIVE' },
      include: { package: true },
      orderBy: { createdAt: 'desc' }
    });
    const hasBeam = activeSub?.package ? activeSub.package.featureBeamLiveCamera : false;

    const host = process.env.BEAM_FTP_HOST || '158.178.226.189';
    const port = 2121;
    const username = event.ftpUsername || `evt_${event.id.slice(0, 8)}`;
    const pin = event.ftpPassword || '1234';
    const mode = event.beamUploadMode || 'PHOTOS_ONLY';

    let isEnabled = event.beamEnabled;
    // Auto 4-Hour Expiry Check: If session passed 4 hours, auto-disable toggle and clean Redis
    if (isEnabled && event.beamExpiresAt && new Date() > new Date(event.beamExpiresAt)) {
      isEnabled = false;
      await this.prisma.event.update({
        where: { id: eventId },
        data: { beamEnabled: false, beamExpiresAt: null },
      }).catch(() => {});
      await this.syncEventAuthToRedis(photographerId, event, false);
      this.logger.log(`[BeamService] 4-Hour session expired for event ${eventId}. Toggle auto-disabled & Redis cleared.`);
    }

    if (!event.ftpUsername || !event.ftpPassword || !event.beamUploadMode) {
      await this.prisma.event.update({
        where: { id: eventId },
        data: { ftpUsername: username, ftpPassword: pin, beamUploadMode: mode },
      });
    }

    return {
      host,
      port,
      username,
      pin,
      beamEnabled: isEnabled,
      beamUploadMode: mode,
      beamExpiresAt: event.beamExpiresAt,
      lastCameraConnectedAt: event.lastCameraConnectedAt,
      lastCameraModel: event.lastCameraModel,
      hasBeamPlanAccess: hasBeam,
    };
  }

  private async syncEventAuthToRedis(photographerId: string, event: any, enabled: boolean) {
    const username = event.ftpUsername || `evt_${event.id.slice(0, 8)}`;
    const pin = event.ftpPassword || '1234';

    if (enabled) {
      const breakdown = await this.storageService.getStorageBreakdown(photographerId);
      const limitBytes = BigInt(breakdown.limitEventsBytes || 5242880000);
      const usedBytes = BigInt(breakdown.eventsBytes || 0);
      const remainingBytes = limitBytes > usedBytes ? limitBytes - usedBytes : BigInt(0);

      const authData = JSON.stringify({
        username,
        ftpUsername: username,
        pin,
        ftpPassword: pin,
        eventId: event.id,
        photographerId,
        enabled: true,
        beamEnabled: true,
        beamUploadMode: event.beamUploadMode || 'PHOTOS_ONLY',
        limitBytes: limitBytes.toString(),
        usedBytes: usedBytes.toString(),
        remainingBytes: remainingBytes.toString(),
        storageLimitBytes: limitBytes.toString(),
        storageUsedBytes: usedBytes.toString(),
        storageRemainingBytes: remainingBytes.toString(),
        expiresAt: event.beamExpiresAt ? new Date(event.beamExpiresAt).toISOString() : undefined,
        updatedAt: new Date().toISOString()
      });

      const storageData = JSON.stringify({
        photographerId,
        limitBytes: limitBytes.toString(),
        usedBytes: usedBytes.toString(),
        remainingBytes: remainingBytes.toString()
      });

      // Set credentials & storage with 4-hour fixed TTL in Redis
      await this.syncToAllRedis(`auth:ftp:${username}`, authData, 'set', BEAM_SESSION_TTL_SECONDS);
      await this.syncToAllRedis(`beam:auth:${username}`, authData, 'set', BEAM_SESSION_TTL_SECONDS);
      await this.syncToAllRedis(`beam:storage:${photographerId}`, storageData, 'set', BEAM_SESSION_TTL_SECONDS);

      // Also set hash for Oracle VM storage check with 4-hour TTL
      if (this.oracleRedis && this.oracleRedis.status === 'ready') {
        try {
          await this.oracleRedis.hset(`storage:photographer:${photographerId}`, 'limit', limitBytes.toString(), 'used', usedBytes.toString());
          await this.oracleRedis.expire(`storage:photographer:${photographerId}`, BEAM_SESSION_TTL_SECONDS);
        } catch (err: any) {
          this.logger.warn(`[BeamService] Oracle Redis hash storage sync failed: ${err.message}`);
        }
      }

      // Sync existing photo filenames to Redis Set with 4-hour TTL so camera auto-transfer skips duplicates
      try {
        const existingPhotos = await this.prisma.photo.findMany({
          where: { eventId: event.id, isDeleted: false },
          select: { filenameOriginal: true }
        });
        const fileNames = existingPhotos.map(p => p.filenameOriginal).filter(Boolean);
        const filesKey = `beam:event:files:${event.id}`;
        
        if (fileNames.length > 0) {
          await this.redis.del(filesKey).catch(() => {});
          await this.redis.sadd(filesKey, ...fileNames).catch(() => {});
          await this.redis.expire(filesKey, BEAM_SESSION_TTL_SECONDS).catch(() => {});

          if (this.oracleRedis && this.oracleRedis.status === 'ready') {
            await this.oracleRedis.del(filesKey).catch(() => {});
            await this.oracleRedis.sadd(filesKey, ...fileNames).catch(() => {});
            await this.oracleRedis.expire(filesKey, BEAM_SESSION_TTL_SECONDS).catch(() => {});
          }
          this.logger.log(`[BeamService] Synced ${fileNames.length} existing filenames to Redis for event ${event.id} (TTL: 4h)`);
        } else {
          await this.redis.del(filesKey).catch(() => {});
          if (this.oracleRedis && this.oracleRedis.status === 'ready') {
            await this.oracleRedis.del(filesKey).catch(() => {});
          }
        }
      } catch (err: any) {
        this.logger.warn(`[BeamService] Failed to sync existing filenames to Redis: ${err.message}`);
      }

      this.logger.log(`[BeamService] Synced auth & storage for user ${username} (Mode: ${event.beamUploadMode || 'PHOTOS_ONLY'}, TTL: 4h) to Redis`);
    } else {
      // Complete wipe of all session keys from Redis
      await this.syncToAllRedis(`auth:ftp:${username}`, '', 'del');
      await this.syncToAllRedis(`beam:auth:${username}`, '', 'del');
      await this.syncToAllRedis(`beam:storage:${photographerId}`, '', 'del');
      await this.redis.del(`beam:event:files:${event.id}`).catch(() => {});
      if (this.oracleRedis && this.oracleRedis.status === 'ready') {
        try {
          await this.oracleRedis.del(`storage:photographer:${photographerId}`);
          await this.oracleRedis.del(`beam:event:files:${event.id}`);
        } catch (err: any) {}
      }
      this.logger.log(`[BeamService] Completely removed auth & storage cache for user ${username} from Redis`);
    }
  }

  async toggleBeam(photographerId: string, eventId: string, enabled: boolean) {
    if (enabled) {
      await this.checkBeamPlanAccess(photographerId);
    }

    const event = await this.prisma.event.findFirst({
      where: { id: eventId, photographerId, isDeleted: false },
    });
    if (!event) throw new NotFoundException('Event not found');

    const username = event.ftpUsername || `evt_${event.id.slice(0, 8)}`;
    const pin = event.ftpPassword || '1234';
    const mode = event.beamUploadMode || 'PHOTOS_ONLY';
    const expiresAt = enabled ? new Date(Date.now() + BEAM_SESSION_TTL_SECONDS * 1000) : null;

    const updated = await this.prisma.event.update({
      where: { id: eventId },
      data: {
        beamEnabled: enabled,
        beamUploadMode: mode,
        beamExpiresAt: expiresAt,
        ftpUsername: username,
        ftpPassword: pin,
      },
    });

    await this.syncEventAuthToRedis(photographerId, updated, enabled);
    return updated;
  }

  async verifyCredentials(username: string, password: string) {
    const event = await this.prisma.event.findFirst({
      where: { ftpUsername: username, isDeleted: false },
    });

    if (!event || !event.beamEnabled || event.ftpPassword !== password) {
      return { valid: false, message: 'Invalid credentials or Beam disabled' };
    }

    // Check if 4-hour session expired
    if (event.beamExpiresAt && new Date() > new Date(event.beamExpiresAt)) {
      await this.prisma.event.update({
        where: { id: event.id },
        data: { beamEnabled: false, beamExpiresAt: null }
      }).catch(() => {});
      await this.syncEventAuthToRedis(event.photographerId, event, false);
      return { valid: false, message: 'Beam session has expired after 4 hours' };
    }

    const breakdown = await this.storageService.getStorageBreakdown(event.photographerId);
    const limitBytes = BigInt(breakdown.limitEventsBytes || 5242880000);
    const usedBytes = BigInt(breakdown.eventsBytes || 0);
    const remainingBytes = limitBytes > usedBytes ? limitBytes - usedBytes : BigInt(0);

    return {
      valid: true,
      eventId: event.id,
      photographerId: event.photographerId,
      ftpUsername: event.ftpUsername,
      username: event.ftpUsername,
      beamEnabled: event.beamEnabled,
      ftpPassword: event.ftpPassword,
      beamUploadMode: event.beamUploadMode || 'PHOTOS_ONLY',
      storageRemainingBytes: remainingBytes.toString()
    };
  }

  async regeneratePin(photographerId: string, eventId: string) {
    const newPin = Math.floor(1000 + Math.random() * 9000).toString();
    const updated = await this.prisma.event.update({
      where: { id: eventId },
      data: { ftpPassword: newPin },
    });

    if (updated.beamEnabled) {
      await this.syncEventAuthToRedis(photographerId, updated, true);
    }

    return updated;
  }

  async updateUploadMode(photographerId: string, eventId: string, mode: string) {
    const updated = await this.prisma.event.update({
      where: { id: eventId },
      data: { beamUploadMode: mode },
    });

    if (updated.beamEnabled) {
      await this.syncEventAuthToRedis(photographerId, updated, true);
      this.logger.log(`[BeamService] Updated upload mode to ${mode} for event ${eventId}`);
    }

    return updated;
  }

  async handlePhotoIngested(payload: {
    photographerId: string;
    eventId: string;
    r2KeyOriginal: string;
    filenameOriginal: string;
    fileSize: number;
    mimeType?: string;
    cameraModel?: string;
    duration?: number;
  }) {
    const photoId = uuidv4();
    const fileSizeBigInt = BigInt(payload.fileSize || 0);
    const isVideo = payload.mimeType?.startsWith('video/') || payload.filenameOriginal?.match(/\.(mp4|mov|mkv|webm)$/i);

    const photo = await this.prisma.photo.create({
      data: {
        id: photoId,
        photographerId: payload.photographerId,
        eventId: payload.eventId,
        filenameOriginal: payload.filenameOriginal,
        filenameStored: payload.filenameOriginal,
        fileSize: fileSizeBigInt,
        mimeType: payload.mimeType || (isVideo ? 'video/mp4' : 'image/jpeg'),
        r2KeyOriginal: payload.r2KeyOriginal,
        thumbnailStatus: 'PENDING',
        type: isVideo ? 'VIDEO' : 'IMAGE',
        duration: payload.duration || 0,
        status: 'READY' as any,
      },
    });

    // Update event last camera connection
    await this.prisma.event.update({
      where: { id: payload.eventId },
      data: {
        lastCameraConnectedAt: new Date(),
        lastCameraModel: payload.cameraModel || 'FTP Camera',
      }
    }).catch(() => {});

    // Invalidate local Redis caches so new photo appears immediately and storage recalculates
    try {
      await this.redis.del(`cache:photographer:${payload.photographerId}:storage-breakdown`);
      await this.redis.del(`cache:event:${payload.eventId}`);
      await this.redis.del(`cache:events:${payload.photographerId}`);
      await this.redis.del(`cache:events:${payload.photographerId}:${payload.eventId}:photos`);
    } catch (cacheErr: any) {
      this.logger.warn(`[BeamService] Cache invalidation warning: ${cacheErr.message}`);
    }

    if (isVideo) {
      this.storageService.runBackgroundVideoProcessing(
        payload.photographerId,
        photo.id,
        payload.eventId,
        payload.r2KeyOriginal,
        null
      ).catch(err => {
        this.logger.error(`[BeamService] Background video processing failed for ${photo.id}: ${err.message}`);
      });
    } else {
      this.storageService.processIngestedPhoto(
        payload.photographerId,
        photo.id,
        payload.eventId,
        payload.r2KeyOriginal
      ).catch(err => {
        this.logger.error(`[BeamService] Background photo processing failed for ${photo.id}: ${err.message}`);
      });
    }

    // Sync updated remaining storage live to Oracle Redis on EVERY FTP photo ingest
    const breakdown = await this.storageService.getStorageBreakdown(payload.photographerId);
    const limitBytes = BigInt(breakdown.limitEventsBytes || 5242880000);
    const usedBytes = BigInt(breakdown.eventsBytes || 0);
    const remainingBytes = limitBytes > usedBytes ? limitBytes - usedBytes : BigInt(0);

    const storageData = JSON.stringify({
      photographerId: payload.photographerId,
      limitBytes: limitBytes.toString(),
      usedBytes: usedBytes.toString(),
      remainingBytes: remainingBytes.toString()
    });
    await this.syncToAllRedis(`beam:storage:${payload.photographerId}`, storageData, 'set', BEAM_SESSION_TTL_SECONDS);

    // Live update Oracle Redis storage hash
    if (this.oracleRedis && this.oracleRedis.status === 'ready') {
      try {
        await this.oracleRedis.hset(
          `storage:photographer:${payload.photographerId}`,
          'limit', limitBytes.toString(),
          'used', usedBytes.toString()
        );
        this.logger.log(`[BeamService] Live updated Oracle Redis storage hash for photographer ${payload.photographerId}: used=${usedBytes}, limit=${limitBytes}`);
      } catch (err: any) {
        this.logger.warn(`[BeamService] Oracle Redis hash storage sync failed: ${err.message}`);
      }
    }

    // Add newly ingested photo filename to Redis Set so camera never re-uploads it in current 4h session
    if (payload.filenameOriginal) {
      const filesKey = `beam:event:files:${payload.eventId}`;
      await this.redis.sadd(filesKey, payload.filenameOriginal).catch(() => {});
      if (this.oracleRedis && this.oracleRedis.status === 'ready') {
        await this.oracleRedis.sadd(filesKey, payload.filenameOriginal).catch(() => {});
      }
    }

    return { success: true, photoId: photo.id };
  }
}
