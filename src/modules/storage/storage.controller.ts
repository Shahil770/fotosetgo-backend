import { Controller, Post, Get, Body, UseGuards, UseInterceptors, UploadedFile, Delete, Param, Patch } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { StorageService } from './storage.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { FeatureGuard } from '../../common/guards/feature.guard';

@UseGuards(JwtAuthGuard)
@Controller('storage')
export class StorageController {
  constructor(private storageService: StorageService) {}

  @Get('breakdown')
  async getStorageBreakdown(@CurrentUser() user: any) {
    return this.storageService.getStorageBreakdown(user.photographer?.id || user.id);
  }


  @Post('batch/start')
  async startBatch(
    @CurrentUser() user: any,
    @Body() body: { eventId: string; totalFiles: number },
  ) {
    return this.storageService.startUploadBatch(user.photographer.id, body.eventId, body.totalFiles);
  }


  @Post('upload-url')
  async getUploadUrl(
    @CurrentUser() user: any,
    @Body() body: { eventId: string; filename: string; mimeType: string; fileSize: number; uploadBatchId?: string },
  ) {
    return this.storageService.getUploadPresignedUrl(user.photographer.id, body.eventId, {
      filename: body.filename,
      mimeType: body.mimeType,
      fileSize: body.fileSize,
      uploadBatchId: body.uploadBatchId,
    });
  }

  @Post('complete-upload')
  async completeUpload(
    @CurrentUser() user: any,
    @Body() body: { photoId: string },
  ) {
    return this.storageService.completeUpload(user.photographer.id, body.photoId);
  }

  @Post('upload-url-batch')
  async getBatchUploadUrls(
    @CurrentUser() user: any,
    @Body() body: { eventId: string; uploadBatchId: string; files: { filename: string; mimeType: string; fileSize: number }[] },
  ) {
    return this.storageService.getBatchUploadPresignedUrls(
      user.photographer.id,
      body.eventId,
      body.uploadBatchId,
      body.files
    );
  }

  @Post('complete-upload-batch')
  async completeBatchUpload(
    @CurrentUser() user: any,
    @Body() body: { photoIds: string[] },
  ) {
    return this.storageService.completeBatchUpload(user.photographer.id, body.photoIds);
  }

  @Post('cancel-upload')
  async cancelUpload(
    @CurrentUser() user: any,
    @Body() body: { photoId: string },
  ) {
    // Remove orphaned UPLOADING DB entry when R2 upload failed completely
    return this.storageService.cancelUpload(user.photographer.id, body.photoId);
  }

  @Post('clear-waste')
  async clearWasteStorage(@CurrentUser() user: any) {
    return this.storageService.clearWasteStorage(user.photographer.id);
  }

  @Get('events/:eventId/pending-guest-photos')
  @UseGuards(FeatureGuard('featureGuestUpload'))
  async getEventPendingPhotos(
    @CurrentUser() user: any,
    @Param('eventId') eventId: string
  ) {
    return this.storageService.getEventPendingPhotos(user.photographer.id, eventId);
  }

  @Post('guest-photos/:photoId/approve')
  @UseGuards(FeatureGuard('featureGuestUpload'))
  async approveGuestPhoto(
    @CurrentUser() user: any,
    @Param('photoId') photoId: string
  ) {
    return this.storageService.approveGuestPhoto(user.photographer.id, photoId);
  }

  @Post('guest-photos/:photoId/reject')
  @UseGuards(FeatureGuard('featureGuestUpload'))
  async rejectGuestPhoto(
    @CurrentUser() user: any,
    @Param('photoId') photoId: string
  ) {
    return this.storageService.rejectGuestPhoto(user.photographer.id, photoId);
  }



  @Post('search-face')
  @UseGuards(FeatureGuard('featureAiPhotoSearch'))
  @UseInterceptors(FileInterceptor('selfie'))
  async searchFace(
    @CurrentUser() user: any,
    @UploadedFile() selfie: any,
    @Body() body: { eventId?: string },
  ) {
    return this.storageService.searchFace(user.photographer.id, selfie, body.eventId);
  }

  @Delete('photo/:id')
  async deletePhoto(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    return this.storageService.softDeletePhoto(user.photographer.id, id);
  }

  @Post('batch-delete')
  async batchDeletePhotos(
    @CurrentUser() user: any,
    @Body() body: { photoIds: string[] },
  ) {
    return this.storageService.batchSoftDeletePhotos(user.photographer.id, body.photoIds);
  }

  @Get('trash')
  async getTrashData(@CurrentUser() user: any) {
    return this.storageService.getTrashData(user.photographer.id);
  }

  @Post('trash/restore-photo')
  async restorePhoto(
    @CurrentUser() user: any,
    @Body() body: { photoId: string; targetEventId?: string },
  ) {
    return this.storageService.restorePhoto(user.photographer.id, body.photoId, body.targetEventId);
  }

  @Delete('trash/empty')
  async emptyTrash(@CurrentUser() user: any) {
    return this.storageService.emptyTrash(user.photographer.id);
  }

  @Delete('trash/photo/:id')
  async hardDeletePhoto(
    @CurrentUser() user: any,
    @Param('id') id: string,
  ) {
    return this.storageService.deletePhoto(user.photographer.id, id);
  }

  @Post('trash/batch-delete')
  async batchHardDeletePhotos(
    @CurrentUser() user: any,
    @Body() body: { photoIds: string[] },
  ) {
    return this.storageService.batchDeletePhotos(user.photographer.id, body.photoIds);
  }

  @Post('trash/batch-restore')
  async batchRestorePhotos(
    @CurrentUser() user: any,
    @Body() body: { photoIds: string[]; targetEventId?: string },
  ) {
    return this.storageService.batchRestorePhotos(user.photographer.id, body.photoIds, body.targetEventId);
  }


  @Post('batch-move')
  async batchMove(
    @CurrentUser() user: any,
    @Body() body: { photoIds: string[]; targetEventId: string },
  ) {
    return this.storageService.batchMove(user.photographer.id, body.photoIds, body.targetEventId);
  }

  @Post('batch-copy')
  async batchCopy(
    @CurrentUser() user: any,
    @Body() body: { photoIds: string[]; targetEventId: string },
  ) {
    return this.storageService.batchCopy(user.photographer.id, body.photoIds, body.targetEventId);
  }

  @Post('reindex-event/:eventId')
  async reindexEvent(
    @CurrentUser() user: any,
    @Param('eventId') eventId: string,
  ) {
    return this.storageService.reindexEventPhotos(user.photographer.id, eventId);
  }

  @Get('event-faces/:eventId')
  async getEventFaces(
    @CurrentUser() user: any,
    @Param('eventId') eventId: string,
  ) {
    return this.storageService.getEventFaces(user.photographer.id, eventId);
  }

  @Post('merge-clusters')
  async mergeClusters(
    @CurrentUser() user: any,
    @Body() body: { eventId: string; faceIds: string[] },
  ) {
    return this.storageService.mergeClusters(user.photographer.id, body.eventId, body.faceIds);
  }

  @Get('events/:eventId/favorites')
  async getEventFavorites(
    @CurrentUser() user: any,
    @Param('eventId') eventId: string,
  ) {
    return this.storageService.getEventFavorites(user.photographer.id, eventId);
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

  @Post('branding/banner')
  @UseGuards(FeatureGuard('featureCustomBranding'))
  @UseInterceptors(FileInterceptor('banner'))
  async uploadBrandingBanner(
    @CurrentUser() user: any,
    @UploadedFile() file: any,
  ) {
    return this.storageService.uploadBrandingBanner(user.id, file);
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

  @Post('portfolio/about-image')
  @UseInterceptors(FileInterceptor('aboutImage'))
  async uploadPortfolioAboutImage(
    @CurrentUser() user: any,
    @UploadedFile() file: any
  ) {
    return this.storageService.uploadPortfolioAboutImage(user.id, file);
  }

  @Post('portfolio/hero-image')
  @UseInterceptors(FileInterceptor('heroImage'))
  async uploadPortfolioHeroImage(
    @CurrentUser() user: any,
    @UploadedFile() file: any
  ) {
    return this.storageService.uploadPortfolioHeroImage(user.id, file);
  }

  @Post('portfolio/reel-video')
  @UseInterceptors(FileInterceptor('reelVideo'))
  async uploadPortfolioReelVideo(
    @CurrentUser() user: any,
    @UploadedFile() file: any
  ) {
    return this.storageService.uploadPortfolioReelVideo(user.id, file);
  }

  @Post('portfolio/photos')
  @UseInterceptors(FileInterceptor('photo'))
  async uploadPortfolioPhoto(
    @CurrentUser() user: any,
    @UploadedFile() file: any,
    @Body() body: { category?: string }
  ) {
    return this.storageService.uploadPortfolioPhoto(user.id, file, body.category);
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

