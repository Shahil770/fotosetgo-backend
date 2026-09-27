import { Controller, Post, Get, Body, UseGuards, HttpCode, HttpStatus } from '@nestjs/common';
import { ScannerService } from './scanner.service';
import { ScannerGuard } from './scanner.guard';

@Controller('v1/scanner')
@UseGuards(ScannerGuard)
export class ScannerController {
  constructor(private readonly scannerService: ScannerService) {}

  @Post('claim-videos')
  @HttpCode(HttpStatus.OK)
  async claimVideos(@Body() body: { limit?: number; workerName?: string }) {
    return this.scannerService.claimPendingVideos(body?.limit || 1, body?.workerName);
  }

  @Post('claim-photos')
  @HttpCode(HttpStatus.OK)
  async claimPhotos(@Body() body: { limit?: number; workerName?: string }) {
    return this.scannerService.claimPendingPhotos(body?.limit || 10, body?.workerName);
  }

  @Post('heartbeat')
  @HttpCode(HttpStatus.OK)
  async heartbeat(@Body() body: { photoId: string }) {
    return this.scannerService.touchHeartbeat(body.photoId);
  }

  @Post('event-faces')
  @HttpCode(HttpStatus.OK)
  async getEventFaces(@Body() body: { eventId: string; limit?: number }) {
    return this.scannerService.getEventExistingFaces(body.eventId, body?.limit || 200);
  }

  @Post('save-video')
  @HttpCode(HttpStatus.OK)
  async saveVideo(@Body() body: { video: any; scanResult: any }) {
    return this.scannerService.saveVideoScanResults(body);
  }

  @Post('save-photo')
  @HttpCode(HttpStatus.OK)
  async savePhoto(@Body() body: { photo: any; scanResult: any }) {
    return this.scannerService.savePhotoScanResults(body);
  }

  @Post('save-photos-batch')
  @HttpCode(HttpStatus.OK)
  async savePhotosBatch(@Body() body: { batch: Array<{ photo: any; scanResult: any }> }) {
    return this.scannerService.savePhotosBatch(body?.batch || []);
  }

  @Post('release-stale')
  @HttpCode(HttpStatus.OK)
  async releaseStale() {
    return this.scannerService.releaseStaleJobs();
  }

  @Get('stats')
  @HttpCode(HttpStatus.OK)
  async getStats() {
    return this.scannerService.getStats();
  }
}
