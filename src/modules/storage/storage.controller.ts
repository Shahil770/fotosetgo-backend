import { Controller, Post, Get, Body, UseGuards, UseInterceptors, UploadedFile, Delete, Param, Patch, Query } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { StorageService } from './storage.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FeatureGuard } from '../../common/guards/feature.guard';

function getPhotographerId(user: any): string {
  return user?.photographer?.id || user?.id || '';
}

@UseGuards(JwtAuthGuard)
@Controller('storage')
export class StorageController {
  constructor(private storageService: StorageService) { }

  @Get('breakdown')
  async getStorageBreakdown(@CurrentUser() user: any) {
    return this.storageService.getStorageBreakdown(getPhotographerId(user));
  }


  @Post('batch/start')
  async startBatch(
    @CurrentUser() user: any,
    @Body() body: { eventId: string; totalFiles: number },
  ) {
    return this.storageService.startUploadBatch(getPhotographerId(user), body.eventId, body.totalFiles);
  }


  @Post('upload-url')
  async getUploadUrl(
    @CurrentUser() user: any,
    @Body() body: { eventId: string; filename: string; mimeType: string; fileSize: number; uploadBatchId?: string },
  ) {
    return this.storageService.getUploadPresignedUrl(getPhotographerId(user), body.eventId, {
      filename: body.filename,
      mimeType: body.mimeType,
      fileSize: body.fileSize,
      uploadBatchId: body.uploadBatchId,
    });
  }

  @Post('complete-upload')
  async completeUpload(
    @CurrentUser() user: any,
    @Body() body: { photoId: string; thumbSizeBytes?: number; previewSizeBytes?: number; duration?: number },
  ) {
    return this.storageService.completeUpload(getPhotographerId(user), body.photoId, body.thumbSizeBytes, body.previewSizeBytes, body.duration);
  }

  @Post('upload-url-batch')
  async getBatchUploadUrls(
    @CurrentUser() user: any,
    @Body() body: { eventId: string; uploadBatchId: string; files: { filename: string; mimeType: string; fileSize: number }[]; totalBatchBytes?: number },
  ) {
    return this.storageService.getBatchUploadPresignedUrls(
      getPhotographerId(user),
      body.eventId,
      body.uploadBatchId,
      body.files,
      body.totalBatchBytes,
    );
  }

  @Post('complete-upload-batch')
  async completeBatchUpload(
    @CurrentUser() user: any,
    @Body() body: { photoIds?: string[]; items?: { photoId: string; thumbSizeBytes?: number; previewSizeBytes?: number; duration?: number }[] },
  ) {
    const list = body.items && body.items.length > 0 ? body.items : (body.photoIds || []);
    return this.storageService.completeBatchUpload(getPhotographerId(user), list);
  }

  @Post('cancel-upload')
  async cancelUpload(
    @CurrentUser() user: any,
    @Body() body: { photoId: string },
  ) {
    // Remove orphaned UPLOADING DB entry when R2 upload failed completely
    return this.storageService.cancelUpload(getPhotographerId(user), body.photoId);
  }

  @Post('batch/cancel')
  async cancelBatchUpload(
    @CurrentUser() user: any,
    @Body() body: { uploadBatchId: string },
  ) {
    return this.storageService.cancelBatchUpload(getPhotographerId(user), body.uploadBatchId);
  }

  @Post('clear-waste')
  async clearWasteStorage(@CurrentUser() user: any) {
    return this.storageService.clearWasteStorage(getPhotographerId(user));
  }

  @Get('events/:eventId/pending-guest-photos')
  @UseGuards(FeatureGuard('featureGuestUpload'))
  async getEventPendingPhotos(
    @CurrentUser() user: any,
    @Param('eventId') eventId: string
  ) {
    return this.storageService.getEventPendingPhotos(getPhotographerId(user), eventId);
  }

  @Post('guest-photos/:photoId/approve')
  @UseGuards(FeatureGuard('featureGuestUpload'))
  async approveGuestPhoto(
    @CurrentUser() user: any,
    @Param('photoId') photoId: string
  ) {
    return this.storageService.approveGuestPhoto(getPhotographerId(user), photoId);
  }

  @Post('guest-photos/:photoId/reject')
  @UseGuards(FeatureGuard('featureGuestUpload'))
  async rejectGuestPhoto(
    @CurrentUser() user: any,
    @Param('photoId') photoId: string
  ) {
    return this.storageService.rejectGuestPhoto(getPhotographerId(user), photoId);
  }



  @Post('search-face')
  @UseGuards(FeatureGuard('featureAiPhotoSearch'))
  async searchFace(
    @CurrentUser() user: any,
    @Body() body: { r2Key?: string; vector?: number[]; eventId?: string },
  ) {
    return this.storageService.searchFace(getPhotographerId(user), body.r2Key, body.eventId, body.vector);
  }

  @Delete('photo/:id')
  async deletePhoto(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    return this.storageService.softDeletePhoto(getPhotographerId(user), id);
  }

  @Post('batch-delete')
  async batchDeletePhotos(
    @CurrentUser() user: any,
    @Body() body: { photoIds: string[] },
  ) {
    return this.storageService.batchSoftDeletePhotos(getPhotographerId(user), body.photoIds);
  }

  @Get('trash')
  async getTrashData(
    @CurrentUser() user: any,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
  ) {
    const pageNum = page ? Math.max(1, parseInt(page, 10)) : 1;
    const limitNum = limit ? Math.max(1, Math.min(100, parseInt(limit, 10))) : 40;
    return this.storageService.getTrashData(getPhotographerId(user), pageNum, limitNum);
  }

  @Post('trash/restore-photo')
  async restorePhoto(
    @CurrentUser() user: any,
    @Body() body: { photoId: string; targetEventId?: string },
  ) {
    return this.storageService.restorePhoto(getPhotographerId(user), body.photoId, body.targetEventId);
  }

  @Delete('trash/empty')
  async emptyTrash(@CurrentUser() user: any) {
    return this.storageService.emptyTrash(getPhotographerId(user));
  }

  @Delete('trash/photo/:id')
  async hardDeletePhoto(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    return this.storageService.deletePhoto(getPhotographerId(user), id);
  }

  @Post('trash/batch-delete')
  async batchHardDeletePhotos(
    @CurrentUser() user: any,
    @Body() body: { photoIds: string[] },
  ) {
    return this.storageService.batchDeletePhotos(getPhotographerId(user), body.photoIds);
  }

  @Post('trash/batch-restore')
  async batchRestorePhotos(
    @CurrentUser() user: any,
    @Body() body: { photoIds: string[]; targetEventId?: string },
  ) {
    return this.storageService.batchRestorePhotos(getPhotographerId(user), body.photoIds, body.targetEventId);
  }


  @Post('batch-move')
  async batchMove(
    @CurrentUser() user: any,
    @Body() body: { photoIds: string[]; targetEventId: string },
  ) {
    return this.storageService.batchMove(getPhotographerId(user), body.photoIds, body.targetEventId);
  }

  @Post('batch-copy')
  async batchCopy(
    @CurrentUser() user: any,
    @Body() body: { photoIds: string[]; targetEventId: string },
  ) {
    return this.storageService.batchCopy(getPhotographerId(user), body.photoIds, body.targetEventId);
  }

  @Post('reindex-event/:eventId')
  async reindexEvent(
    @CurrentUser() user: any,
    @Param('eventId') eventId: string,
  ) {
    return this.storageService.reindexEventPhotos(getPhotographerId(user), eventId);
  }

  @Get('event-faces/:eventId')
  async getEventFaces(
    @CurrentUser() user: any,
    @Param('eventId') eventId: string,
  ) {
    return this.storageService.getEventFaces(getPhotographerId(user), eventId);
  }

  @Post('merge-clusters')
  async mergeClusters(
    @CurrentUser() user: any,
    @Body() body: { eventId: string; faceIds: string[] },
  ) {
    return this.storageService.mergeClusters(getPhotographerId(user), body.eventId, body.faceIds);
  }

  @Get('events/:eventId/favorites')
  async getEventFavorites(
    @CurrentUser() user: any,
    @Param('eventId') eventId: string,
  ) {
    return this.storageService.getEventFavorites(getPhotographerId(user), eventId);
  }

  @Post('watermark/settings')
  async updateWatermarkSettings(
    @CurrentUser() user: any,
    @Body() body: any,
  ) {
    return this.storageService.updateWatermarkSettings(user.id, body);
  }

  @Post('watermark/upload')
  @UseInterceptors(FileInterceptor('watermark'))
  async uploadWatermarkImage(
    @CurrentUser() user: any,
    @UploadedFile() file: any,
  ) {
    return this.storageService.uploadWatermarkImage(user.id, file);
  }

  @Post('branding/settings')
  @UseGuards(FeatureGuard('featureCustomBranding'))
  async updateBrandingSettings(
    @CurrentUser() user: any,
    @Body() body: any,
  ) {
    return this.storageService.updateBrandingSettings(user.id, body);
  }

  @Post('branding/logo')
  @UseGuards(FeatureGuard('featureCustomBranding'))
  @UseInterceptors(FileInterceptor('logo'))
  async uploadBrandingLogo(
    @CurrentUser() user: any,
    @UploadedFile() file: any,
  ) {
    return this.storageService.uploadBrandingLogo(user.id, file);
  }

  @Get('portfolio')
  async getPortfolioSettings(@CurrentUser() user: any) {
    return this.storageService.getPortfolioSettings(user.id);
  }

  @Post('portfolio/settings')
  async updatePortfolioSettings(
    @CurrentUser() user: any,
    @Body() body: any
  ) {
    return this.storageService.updatePortfolioSettings(user.id, body);
  }

  @Post('portfolio/about-image/upload-url')
  async getPortfolioAboutImageUploadUrl(
    @CurrentUser() user: any,
    @Body() body: { mimeType: string; fileSize: number }
  ) {
    return this.storageService.getPortfolioAboutImageUploadUrl(user.id, body);
  }

  @Post('portfolio/about-image/complete')
  async completePortfolioAboutImageUpload(
    @CurrentUser() user: any,
    @Body() body: { key: string; fileSize?: number }
  ) {
    return this.storageService.completePortfolioAboutImageUpload(user.id, body.key, body.fileSize);
  }

  @Post('portfolio/reel-video/upload-url')
  async getPortfolioReelVideoUploadUrl(
    @CurrentUser() user: any,
    @Body() body: { filename: string; mimeType: string; fileSize: number; thumbMimeType?: string; thumbFileSize?: number }
  ) {
    return this.storageService.getPortfolioReelVideoUploadUrl(user.id, body);
  }

  @Delete('portfolio/hero-video')
  async deletePortfolioHeroVideo(@CurrentUser() user: any) {
    return this.storageService.deletePortfolioHeroVideo(user.id);
  }

  @Post('portfolio/bts-video/upload-url')
  async getPortfolioBtsVideoUploadUrl(
    @CurrentUser() user: any,
    @Body() body: { filename: string; mimeType: string; fileSize: number; thumbMimeType?: string; thumbFileSize?: number }
  ) {
    return this.storageService.getPortfolioBtsVideoUploadUrl(user.id, body);
  }

  @Delete('portfolio/bts-video')
  async deletePortfolioBtsVideo(@CurrentUser() user: any) {
    return this.storageService.deletePortfolioBtsVideo(user.id);
  }

  @Post('portfolio/reels/upload-url')
  async getPortfolioReelItemUploadUrl(
    @CurrentUser() user: any,
    @Body() body: {
      video?: { filename: string; mimeType: string; fileSize: number };
      thumb?: { filename?: string; mimeType?: string; fileSize?: number };
      filename?: string;
      mimeType?: string;
      fileSize?: number;
    }
  ) {
    return this.storageService.getPortfolioReelItemUploadUrl(user.id, body);
  }

  @Post('portfolio/reels/complete')
  async completePortfolioReelItemUpload(
    @CurrentUser() user: any,
    @Body() body: {
      key: string;
      thumbKey?: string;
      title?: string;
      category?: string;
      fileSize?: number;
      thumbSizeBytes?: number;
    }
  ) {
    return this.storageService.completePortfolioReelItemUpload(user.id, body);
  }

  @Delete('portfolio/reels/:id')
  async deletePortfolioReelItem(
    @CurrentUser() user: any,
    @Param('id') id: string
  ) {
    return this.storageService.deletePortfolioReelItem(user.id, id);
  }

  @Post('portfolio/photos/upload-url')
  async getPortfolioPhotoUploadUrl(
    @CurrentUser() user: any,
    @Body() body: {
      original: { filename: string; mimeType: string; fileSize: number };
      thumb: { filename: string; mimeType: string; fileSize: number };
    }
  ) {
    return this.storageService.getPortfolioPhotoUploadUrl(user.id, body);
  }

  @Post('portfolio/photos/complete')
  async completePortfolioPhotoUpload(
    @CurrentUser() user: any,
    @Body() body: { originalKey: string; thumbKey: string; category?: string; fileSize?: number; thumbSizeBytes?: number }
  ) {
    return this.storageService.completePortfolioPhotoUpload(user.id, body);
  }

  @Delete('portfolio/photos/:id')
  async deletePortfolioPhoto(
    @CurrentUser() user: any,
    @Param('id') id: string
  ) {
    return this.storageService.deletePortfolioPhoto(user.id, id);
  }

  @Delete('portfolio/category/:categoryName')
  async deletePortfolioCategory(
    @CurrentUser() user: any,
    @Param('categoryName') categoryName: string
  ) {
    return this.storageService.deletePortfolioCategory(user.id, categoryName);
  }

  @Delete('portfolio/clear')
  async clearPortfolioData(@CurrentUser() user: any) {
    return this.storageService.clearPortfolioData(user.id);
  }


  @Get('portfolio/inquiries')
  async getPortfolioInquiries(@CurrentUser() user: any) {
    return this.storageService.getPortfolioInquiries(user.id);
  }

  @Delete('portfolio/inquiries/:id')
  async deletePortfolioInquiry(
    @CurrentUser() user: any,
    @Param('id') id: string
  ) {
    return this.storageService.deletePortfolioInquiry(user.id, id);
  }

  @Get('portfolio-themes/all')
  async getAllPortfolioThemes() {
    return this.storageService.getAllPortfolioThemes();
  }

  @Patch('portfolio-themes/:id/status')
  async togglePortfolioThemeStatus(
    @Param('id') id: string,
    @Body() body: { isActive: boolean }
  ) {
    return this.storageService.togglePortfolioThemeStatus(id, body.isActive);
  }
  @Get('portfolio/reviews')
  async getPortfolioReviews(@CurrentUser() user: any) {
    return this.storageService.getPortfolioReviews(user.id);
  }

  @Patch('portfolio/reviews/:id/approve')
  async approvePortfolioReview(
    @CurrentUser() user: any,
    @Param('id') id: string,
    @Body() body: { approve: boolean }
  ) {
    return this.storageService.approvePortfolioReview(user.id, id, body.approve);
  }

  @Delete('portfolio/reviews/:id')
  async deletePortfolioReview(
    @CurrentUser() user: any,
    @Param('id') id: string
  ) {
    return this.storageService.deletePortfolioReview(user.id, id);
  }
}

