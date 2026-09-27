import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { v4 as uuidv4 } from 'uuid';

@Injectable()
export class ScannerService {
  private readonly logger = new Logger(ScannerService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Auto-releases jobs stuck in PROCESSING state for more than 45 minutes.
   */
  async releaseStaleJobs() {
    try {
      const result: any = await this.prisma.$executeRawUnsafe(`
        UPDATE photos
        SET "faceScanStatus" = 'PENDING', "updatedAt" = NOW()
        WHERE "faceScanStatus" = 'PROCESSING'
          AND "isDeleted" = false
          AND "updatedAt" < NOW() - INTERVAL '5 minutes';
      `);
      return { success: true, releasedCount: result };
    } catch (err: any) {
      this.logger.error(`Error releasing stale jobs: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Heartbeat to prevent timeouts during long processing jobs.
   */
  async touchHeartbeat(photoId: string) {
    try {
      await this.prisma.photo.updateMany({
        where: {
          id: photoId,
          faceScanStatus: 'PROCESSING',
        },
        data: {
          updatedAt: new Date(),
        },
      });
      return { success: true };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }

  /**
   * Fetch existing face clusters for an event for incremental similarity grouping.
   */
  async getEventExistingFaces(eventId: string, limit: number = 200) {
    try {
      const rows: any[] = await this.prisma.$queryRawUnsafe(`
        SELECT id, "clusterId", embedding::text as vector_str
        FROM face_embeddings
        WHERE "eventId" = $1 AND "clusterId" IS NOT NULL
        LIMIT $2;
      `, eventId, limit);

      const faces: any[] = [];
      for (const r of rows) {
        try {
          const vStr = (r.vector_str || '').replace(/[\[\]]/g, '');
          const vArr = vStr
            .split(',')
            .map((x: string) => parseFloat(x.trim()))
            .filter((n: number) => !isNaN(n));
          faces.push({
            id: r.id,
            clusterId: r.clusterId,
            embedding: vArr,
          });
        } catch {
          // ignore parsing error
        }
      }
      return { success: true, faces };
    } catch (err: any) {
      this.logger.error(`Error fetching existing event faces: ${err.message}`);
      return { success: false, faces: [], error: err.message };
    }
  }

  /**
   * Atomically claims pending video(s) for dedicated video AI scanning.
   */
  async claimPendingVideos(limit: number = 1, workerName: string = 'VideoWorker') {
    try {
      await this.prisma.$executeRawUnsafe(`
        UPDATE events
        SET "videoScanningEnabled" = false, "updatedAt" = NOW()
        FROM photographers ph
        WHERE events."photographerId" = ph.id
          AND events."videoScanningEnabled" = true
          AND ph."creditBalance" < 50;
      `);

      const rows: any[] = await this.prisma.$queryRawUnsafe(`
        UPDATE photos p
        SET "faceScanStatus" = 'PROCESSING', "updatedAt" = NOW()
        FROM events e
        WHERE p."eventId" = e.id
          AND p.id IN (
            SELECT p2.id
            FROM photos p2
            INNER JOIN events ev ON p2."eventId" = ev.id
            INNER JOIN photographers ph ON p2."photographerId" = ph.id
            WHERE p2."faceScanStatus" IN ('PENDING', 'SKIPPED')
              AND (p2."status"::text IN ('READY', 'UPLOADED') OR p2."status"::text NOT IN ('UPLOADING'))
              AND (p2."thumbnailStatus" = 'READY' OR p2."thumbnailStatus" IS NULL)
              AND p2."isDeleted" = false
              AND p2."type" = 'VIDEO'
              AND ev."isDeleted" = false
              AND ev."videoScanningEnabled" = true
              AND ph."creditBalance" >= 50
            ORDER BY p2."createdAt" ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING p.id, p."eventId", p."photographerId", p."r2KeyPreview", p."r2KeyThumb", p."r2KeyOriginal", p.duration, e.title as "eventTitle";
      `, limit);

      return { success: true, videos: rows || [] };
    } catch (err: any) {
      this.logger.error(`Error claiming pending videos: ${err.message}`);
      return { success: false, videos: [], error: err.message };
    }
  }

  /**
   * Atomically claims pending photo(s) for photo face scanning.
   */
  async claimPendingPhotos(limit: number = 16, workerName: string = 'PhotoWorker') {
    try {
      await this.prisma.$executeRawUnsafe(`
        UPDATE events
        SET "faceScanningEnabled" = false, "updatedAt" = NOW()
        FROM photographers ph
        WHERE events."photographerId" = ph.id
          AND events."faceScanningEnabled" = true
          AND ph."creditBalance" < 5;
      `);

      const rows: any[] = await this.prisma.$queryRawUnsafe(`
        UPDATE photos p
        SET "faceScanStatus" = 'PROCESSING', "updatedAt" = NOW()
        FROM events e
        WHERE p."eventId" = e.id
          AND p.id IN (
            SELECT p2.id
            FROM photos p2
            INNER JOIN events ev ON p2."eventId" = ev.id
            INNER JOIN photographers ph ON p2."photographerId" = ph.id
            WHERE p2."faceScanStatus" IN ('PENDING', 'SKIPPED')
              AND p2."thumbnailStatus" = 'READY'
              AND p2."status"::text NOT IN ('UPLOADING')
              AND p2."isDeleted" = false
              AND p2."type" = 'IMAGE'
              AND ev."isDeleted" = false
              AND ev."faceScanningEnabled" = true
              AND ph."creditBalance" >= 5
            ORDER BY p2."createdAt" ASC
            LIMIT $1
            FOR UPDATE SKIP LOCKED
        )
        RETURNING p.id, p."eventId", p."photographerId", p."r2KeyPreview", p."r2KeyThumb", p."r2KeyOriginal", e.title as "eventTitle";
      `, limit);

      return { success: true, photos: rows || [] };
    } catch (err: any) {
      this.logger.error(`Error claiming pending photos: ${err.message}`);
      return { success: false, photos: [], error: err.message };
    }
  }

  /**
   * Ultra-Fast Atomic Batch Save for Scanned Photos (Saves entire batch in 1 single DB roundtrip).
   */
  async savePhotosBatch(items: Array<{ photo: any; scanResult: any }>) {
    if (!items || items.length === 0) {
      return { success: true, count: 0 };
    }

    try {
      return await this.prisma.$transaction(async (tx) => {
        let totalCostPaise = 0;
        let totalFacesFound = 0;
        const photographerId = items[0].photo.photographerId;
        const eventId = items[0].photo.eventId;
        const eventTitle = items[0].photo.eventTitle || items[0].photo.event_title || 'Event Photos';
        let successfulPhotosCount = 0;

        for (const item of items) {
          const { photo, scanResult } = item;
          const photoId = photo.id;

          if (scanResult.status === 'ERROR') {
            await tx.photo.update({
              where: { id: photoId },
              data: { faceScanStatus: 'SKIPPED', updatedAt: new Date() },
            });
            continue;
          }

          const faces = scanResult.faces || [];
          const hasFaces = faces.length > 0;
          const faceCount = faces.length;
          totalFacesFound += faceCount;
          totalCostPaise += 5; // 5 paise per photo
          successfulPhotosCount += 1;

          // Delete previous embeddings for idempotency
          await tx.$executeRawUnsafe(`DELETE FROM face_embeddings WHERE "photoId" = $1;`, photoId);

          // Insert embeddings
          for (const f of faces) {
            const faceEmb = f.embedding;
            const faceId = uuidv4();
            const clusterId = f.clusterId || faceId;
            const vectorStr = `[${faceEmb.join(',')}]`;

            await tx.$executeRawUnsafe(`
              INSERT INTO face_embeddings 
              (id, "photoId", "eventId", "photographerId", "faceIndex", "bboxX", "bboxY", "bboxW", "bboxH", "confidence", "embedding", "clusterId", "createdAt")
              VALUES 
              ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector, $12, NOW());
            `,
              faceId,
              photoId,
              eventId,
              photographerId,
              f.faceIndex,
              f.bbox?.x ?? 0,
              f.bbox?.y ?? 0,
              f.bbox?.w ?? 0,
              f.bbox?.h ?? 0,
              f.confidence ?? 0.9,
              vectorStr,
              clusterId,
            );
          }

          // Update Photo status
          await tx.photo.update({
            where: { id: photoId },
            data: {
              faceScanStatus: 'READY',
              hasFaces,
              faceCount,
              updatedAt: new Date(),
            },
          });
        }

        if (successfulPhotosCount > 0 && totalCostPaise > 0) {
          // Deduct Photographer Credits atomically
          await tx.$executeRawUnsafe(`
            UPDATE photographers
            SET "creditBalance" = GREATEST(0, "creditBalance" - $1), "updatedAt" = NOW()
            WHERE id = $2;
          `, totalCostPaise, photographerId);

          // Update or create today's consolidated credit transaction
          const eventTag = `[Event: ${eventId}]`;

          // Find today's existing transaction for this event
          const existingRows: any[] = await tx.$queryRawUnsafe(`
            SELECT id, amount, description 
            FROM credit_transactions 
            WHERE "photographerId" = $1 
              AND "action" = 'PHOTO_SCAN' 
              AND "description" LIKE $2 
              AND "createdAt" >= CURRENT_DATE
            ORDER BY "createdAt" DESC 
            LIMIT 1
            FOR UPDATE;
          `, photographerId, `%${eventTag}%`);

          if (existingRows && existingRows.length > 0) {
            const currentTx = existingRows[0];
            const currentAmount = Math.abs(Number(currentTx.amount) || 0);
            const newTotalAmount = currentAmount + totalCostPaise;
            const totalPhotos = Math.round(newTotalAmount / 5);
            const newDesc = `AI Photo Face Scan - ${totalPhotos} Photos for event: ${eventTitle} ${eventTag}`;

            await tx.creditTransaction.update({
              where: { id: currentTx.id },
              data: {
                amount: -newTotalAmount,
                description: newDesc,
              },
            });
          } else {
            const txId = uuidv4();
            const desc = `AI Photo Face Scan - ${successfulPhotosCount} Photos for event: ${eventTitle} ${eventTag}`;
            await tx.creditTransaction.create({
              data: {
                id: txId,
                photographerId,
                amount: -totalCostPaise,
                action: 'PHOTO_SCAN',
                description: desc,
              },
            });
          }
        }

        return {
          success: true,
          processedCount: successfulPhotosCount,
          totalFaces: totalFacesFound,
          costPaise: totalCostPaise,
        };
      });
    } catch (err: any) {
      this.logger.error(`Error in savePhotosBatch: ${err.message}`);
      return { success: false, error: err.message };
    }
  }

  /**
   * Single Photo Scan Save (Backward compatible).
   */
  async savePhotoScanResults(body: { photo: any; scanResult: any }) {
    return this.savePhotosBatch([body]);
  }

  /**
   * Saves Video Scan Results.
   */
  async saveVideoScanResults(body: { video: any; scanResult: any }) {
    const { video, scanResult } = body;
    const videoId = video.id;
    const eventId = video.eventId;
    const photographerId = video.photographerId;

    if (scanResult.status === 'ERROR') {
      try {
        await this.prisma.photo.update({
          where: { id: videoId },
          data: { faceScanStatus: 'SKIPPED', updatedAt: new Date() },
        });
        return { success: false, message: 'Marked as SKIPPED due to error.' };
      } catch (err: any) {
        return { success: false, error: err.message };
      }
    }

    const faces = scanResult.faces || [];
    const hasFaces = faces.length > 0;
    const faceCount = faces.length;
    const durationSec = scanResult.duration || 0;
    const durationMin = scanResult.durationMinutes || (durationSec / 60.0);
    const costPaise = Math.max(1, Math.round(durationMin * 50.0));

    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
      select: { creditBalance: true },
    });

    const currentCredits = photographer?.creditBalance ?? 0;
    if (currentCredits < costPaise) {
      await this.prisma.photo.update({
        where: { id: videoId },
        data: { faceScanStatus: 'PENDING', updatedAt: new Date() },
      });
      await this.prisma.event.update({
        where: { id: eventId },
        data: { videoScanningEnabled: false, updatedAt: new Date() },
      });
      return {
        success: false,
        message: `Insufficient credits (${currentCredits} paise, required ${costPaise} paise). Video left PENDING.`,
      };
    }

    return await this.prisma.$transaction(async (tx) => {
      // 1. Delete previous embeddings
      await tx.$executeRawUnsafe(`DELETE FROM face_embeddings WHERE "photoId" = $1;`, videoId);

      // 2. Insert face embeddings
      for (const f of faces) {
        const faceEmb = f.embedding;
        const faceId = uuidv4();
        const clusterId = f.clusterId || faceId;
        const vectorStr = `[${faceEmb.join(',')}]`;
        const timestampVal = f.timestamp ?? null;

        await tx.$executeRawUnsafe(`
          INSERT INTO face_embeddings 
          (id, "photoId", "eventId", "photographerId", "faceIndex", "bboxX", "bboxY", "bboxW", "bboxH", "confidence", "embedding", "clusterId", "timestamp", "createdAt")
          VALUES 
          ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::vector, $12, $13, NOW());
        `,
          faceId,
          videoId,
          eventId,
          photographerId,
          f.faceIndex,
          f.bbox?.x ?? 0,
          f.bbox?.y ?? 0,
          f.bbox?.w ?? 0,
          f.bbox?.h ?? 0,
          f.confidence ?? 0.9,
          vectorStr,
          clusterId,
          timestampVal,
        );
      }

      // 3. Update Video Record
      await tx.photo.update({
        where: { id: videoId },
        data: {
          faceScanStatus: 'READY',
          hasFaces,
          faceCount,
          duration: durationSec,
          updatedAt: new Date(),
        },
      });

      // 4. Deduct Photographer Credits
      await tx.$executeRawUnsafe(`
        UPDATE photographers
        SET "creditBalance" = GREATEST(0, "creditBalance" - $1), "updatedAt" = NOW()
        WHERE id = $2;
      `, costPaise, photographerId);

      // 5. Consolidated Event Video Credit Transaction Log
      const eventTitle = video.eventTitle || video.event_title || 'Event Video';
      const eventTag = `[Event: ${eventId}]`;

      const existingRows: any[] = await tx.$queryRawUnsafe(`
        SELECT id, amount, description 
        FROM credit_transactions 
        WHERE "photographerId" = $1 
          AND "action" = 'VIDEO_SCAN' 
          AND "description" LIKE $2 
          AND "createdAt" >= CURRENT_DATE
        ORDER BY "createdAt" DESC 
        LIMIT 1
        FOR UPDATE;
      `, photographerId, `%${eventTag}%`);

      if (existingRows && existingRows.length > 0) {
        const currentTx = existingRows[0];
        const currentAmount = Math.abs(Number(currentTx.amount) || 0);
        const newTotalAmount = currentAmount + costPaise;
        const totalMinutes = (newTotalAmount / 50.0).toFixed(1);

        const currentDesc = currentTx.description || '';
        const match = currentDesc.match(/([0-9]+)\s*Videos?/i);
        const prevCount = match ? parseInt(match[1], 10) : 1;
        const totalVideos = prevCount + 1;
        const videoLabel = totalVideos === 1 ? '1 Video' : `${totalVideos} Videos`;

        const newDesc = `AI Video Face Scan - ${videoLabel} (${totalMinutes} min) for event: ${eventTitle} ${eventTag}`;

        await tx.creditTransaction.update({
          where: { id: currentTx.id },
          data: {
            amount: -newTotalAmount,
            description: newDesc,
          },
        });
      } else {
        const txId = uuidv4();
        const desc = `AI Video Face Scan - 1 Video (${durationMin.toFixed(1)} min) for event: ${eventTitle} ${eventTag}`;
        await tx.creditTransaction.create({
          data: {
            id: txId,
            photographerId,
            amount: -costPaise,
            action: 'VIDEO_SCAN',
            description: desc,
          },
        });
      }

      return { success: true, faceCount, costPaise };
    });
  }

  /**
   * Worker status overview.
   */
  async getStats() {
    try {
      const [pendingPhotos, pendingVideos, readyPhotos, readyVideos] = await Promise.all([
        this.prisma.photo.count({
          where: {
            type: 'IMAGE',
            faceScanStatus: 'PENDING',
            thumbnailStatus: 'READY',
            isDeleted: false,
            event: { isDeleted: false, faceScanningEnabled: true },
          },
        }),
        this.prisma.photo.count({
          where: {
            type: 'VIDEO',
            faceScanStatus: 'PENDING',
            isDeleted: false,
            event: { isDeleted: false, videoScanningEnabled: true },
          },
        }),
        this.prisma.photo.count({
          where: { type: 'IMAGE', faceScanStatus: 'READY', isDeleted: false },
        }),
        this.prisma.photo.count({
          where: { type: 'VIDEO', faceScanStatus: 'READY', isDeleted: false },
        }),
      ]);

      return {
        success: true,
        stats: {
          pendingPhotos,
          pendingVideos,
          readyPhotos,
          readyVideos,
        },
      };
    } catch (err: any) {
      return { success: false, error: err.message };
    }
  }
}
