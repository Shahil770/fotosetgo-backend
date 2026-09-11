import { Controller, Post, Get, Body, Param, Res, Query, NotFoundException, UseGuards, Req } from '@nestjs/common';
import { StorageService } from './storage.service';
import { FeatureGuard } from 'src/common/guards/feature.guard';

@Controller('public')
export class PublicStorageController {
  constructor(private storageService: StorageService) { }

  @Get('events')
  async getPublicEvents() {
    return this.storageService.getPublicEvents();
  }

  @Get('events/:slug')
  async getPublicEventBySlug(@Param('slug') slug: string) {
    return this.storageService.getPublicEventBySlug(slug);
  }

  @Post('events/:slug/init')
  async getPublicEventInit(
    @Param('slug') slug: string,
    @Body() body: { passcode?: string },
    @Req() req: any
  ) {
    const clientIp = (req.headers['cf-connecting-ip'] as string) || (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket?.remoteAddress || '127.0.0.1';
    return this.storageService.getPublicEventInit(slug, body.passcode, clientIp);
  }

  @Post('events/:slug/photos')
  async getPublicEventPhotos(
    @Param('slug') slug: string,
    @Body() body: { passcode?: string; limit?: number; cursor?: string },
    @Req() req: any
  ) {
    const clientIp = (req.headers['cf-connecting-ip'] as string) || (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket?.remoteAddress || '127.0.0.1';
    return this.storageService.getPublicEventPhotos(slug, body.passcode, body.limit, body.cursor, clientIp);
  }

  @Post('events/:slug/guest-upload-url')
  async getGuestUploadUrl(
    @Param('slug') slug: string,
    @Body() body: { filename: string; mimeType: string; fileSize: number }
  ) {
    return this.storageService.getGuestUploadPresignedUrl(slug, body);
  }

  @Post('events/:slug/guest-complete-upload')
  async completeGuestUpload(
    @Param('slug') slug: string,
    @Body() body: { photoId: string; thumbSizeBytes?: number; previewSizeBytes?: number; duration?: number }
  ) {
    return this.storageService.completeGuestUpload(body.photoId, body.thumbSizeBytes, body.previewSizeBytes, body.duration);
  }

  @Get('events/:slug/guest-upload-status')
  async getGuestUploadStatus(@Param('slug') slug: string) {
    return this.storageService.getGuestUploadLimitsStatus(slug);
  }




  @Post('events/:slug/favorites/toggle')
  async toggleClientFavorite(
    @Param('slug') slug: string,
    @Body() body: {
      photoId: string;
      action?: 'ADD' | 'REMOVE' | 'TOGGLE';
    }
  ) {
    return this.storageService.toggleClientFavorite(
      slug,
      body.photoId,
      body.action
    );
  }

  @Post('events/:slug/favorites')
  async saveClientFavorites(
    @Param('slug') slug: string,
    @Body() body: {
      photoIds: string[];
    }
  ) {
    return this.storageService.saveClientFavorites(
      slug,
      body.photoIds || []
    );
  }

  @Post('events/:slug/get-client-favorites')
  async getClientFavorites(
    @Param('slug') slug: string
  ) {
    return this.storageService.getClientFavorites(slug);
  }

  @Get('events/:slug/photos/:photoId/view')
  async viewPhoto(
    @Param('slug') slug: string,
    @Param('photoId') photoId: string,
    @Query('thumb') thumb: string,
    @Query('download') download: string,
    @Res() res: any
  ) {
    const isThumb = thumb === 'true';
    const isDownload = download === 'true';

    const result = await this.storageService.getWatermarkedImageStream(slug, photoId, isThumb, isDownload);
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.redirect(result.redirectUrl);
  }

  @Post('events/:slug/bulk-download-urls')
  async getBulkDownloadUrls(
    @Param('slug') slug: string,
    @Body() body: { photoIds?: string[]; passcode?: string },
    @Req() req: any
  ) {
    const clientIp = (req.headers['cf-connecting-ip'] as string) || (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket?.remoteAddress || '127.0.0.1';
    return this.storageService.getBulkDownloadUrls(slug, body.photoIds, body.passcode, clientIp);
  }

  @Get('watermark/:photographerId')
  async viewPublicWatermark(
    @Param('photographerId') photographerId: string,
    @Res() res: any
  ) {
    const result = await this.storageService.getWatermarkImageStreamByPhotographerId(photographerId) as any;
    if (result.redirectUrl) {
      return res.redirect(result.redirectUrl);
    }
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.end(result.buffer);
  }

  @Get('branding/logo/:photographerId')
  async viewPublicBrandingLogo(
    @Param('photographerId') photographerId: string,
    @Res() res: any
  ) {
    const result = await this.storageService.getBrandingLogoStream(photographerId) as any;
    if (result.redirectUrl) {
      return res.redirect(result.redirectUrl);
    }
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.end(result.buffer);
  }

  @Get('subdomain/check/:subdomain')
  async checkSubdomain(
    @Param('subdomain') subdomain: string,
    @Query('photographerId') photographerId?: string
  ) {
    return this.storageService.checkSubdomainAvailability(subdomain, photographerId);
  }

  @Post('selfie-upload-url')
  async getSelfieUploadUrl(
    @Body() body: { filename: string; mimeType: string }
  ) {
    return this.storageService.getSelfieUploadUrl(body.filename, body.mimeType);
  }

  @Post('search-face')
  async searchFacePublic(
    @Body() body: { r2Key?: string; vector?: number[]; eventId?: string; passcode?: string },
    @Req() req: any
  ) {
    const clientIp = (req.headers['cf-connecting-ip'] as string) || (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket?.remoteAddress || '127.0.0.1';
    return this.storageService.searchFacePublic(body.r2Key, body.eventId, body.passcode, clientIp, body.vector);
  }

  @Get('portfolio/:subdomain')
  async getPublicPortfolio(@Param('subdomain') subdomain: string) {
    const portfolio = await this.storageService.getPublicPortfolioBySubdomain(subdomain);
    if (!portfolio) {
      throw new NotFoundException('Portfolio not found or currently offline');
    }
    return portfolio;
  }

  @Post('portfolio/:subdomain/inquiry')
  async createPortfolioInquiry(
    @Param('subdomain') subdomain: string,
    @Body() body: {
      clientName: string;
      clientEmail: string;
      clientPhone: string;
      eventDate?: string;
      message: string;
    }
  ) {
    return this.storageService.createPortfolioInquiry(subdomain, body);
  }

  @Post('portfolio/:subdomain/reviews')
  async createPortfolioReview(
    @Param('subdomain') subdomain: string,
    @Body() body: {
      clientName: string;
      clientRole?: string;
      rating: number;
      comment: string;
    }
  ) {
    return this.storageService.createPortfolioReview(subdomain, body);
  }

  @Get('portfolio/:subdomain/reviews')
  async getPublicApprovedReviews(@Param('subdomain') subdomain: string) {
    return this.storageService.getPublicApprovedReviews(subdomain);
  }

  @Get('portfolio-themes')
  async getPublicPortfolioThemes() {
    return this.storageService.getActivePortfolioThemes();
  }

  // Public webhook call from Cloudflare Worker upon thumbnail resize success
  @Post('webhook/thumbnail-complete')
  async handleThumbnailComplete(
    @Body() body: { photoId: string; thumbKey: string; previewKey?: string; thumbSize?: number; previewSize?: number; secretKey: string }
  ) {
    return this.storageService.completeThumbnailWebhook(body);
  }

  // Public webhook call from Cloudflare Worker upon Google Drive backup completion
  @Post('webhook/drive-backup-complete')
  async handleDriveBackupComplete(
    @Body() body: { photoId: string; driveFileId?: string; status: string; secretKey?: string; error?: string }
  ) {
    return this.storageService.completeDriveBackupWebhook(body);
  }

  // Public webhook call from Modal GPU upon video face indexing completion
  @Post('webhook/video-face-complete')
  async handleVideoFaceComplete(
    @Body() body: {
      photoId: string;
      duration?: number;
      faces?: any[];
      secretKey: string;
      error?: string;
    }
  ) {
    return this.storageService.completeVideoFaceWebhook(body);
  }

  // Public webhook call from Modal GPU upon photo face batch/single indexing completion
  @Post('webhook/photo-face-complete')
  async handlePhotoFaceComplete(
    @Body() body: {
      eventId?: string;
      photographerId?: string;
      results?: Array<{
        photoId: string;
        faces?: any[];
        faceCount?: number;
        success?: boolean;
        error?: string;
      }>;
      // Also support single photo payload format
      photoId?: string;
      faces?: any[];
      secretKey: string;
      error?: string;
    }
  ) {
    return this.storageService.completePhotoFaceWebhook(body);
  }

  // Public AI Models Presigned Direct Download URLs (From Cloudflare R2)
  @Get('ai-models/urls')
  async getAiModelUrls() {
    return this.storageService.getAiModelUrls();
  }
}

