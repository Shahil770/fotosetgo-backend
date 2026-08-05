import { Controller, Post, Get, Body, Param, UseInterceptors, UploadedFile, Res, Query, Headers, NotFoundException, UseGuards } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { StorageService } from './storage.service';
import { FeatureGuard } from 'src/common/guards/feature.guard';

@Controller('public')
export class PublicStorageController {
  constructor(private storageService: StorageService) {}

  @Get('events')
  async getPublicEvents() {
    return this.storageService.getPublicEvents();
  }

  @Get('events/:slug')
  async getPublicEventBySlug(@Param('slug') slug: string) {
    return this.storageService.getPublicEventBySlug(slug);
  }

  @Post('events/:slug/photos')
  async getPublicEventPhotos(
    @Param('slug') slug: string,
    @Body() body: { passcode?: string }
  ) {
    return this.storageService.getPublicEventPhotos(slug, body.passcode);
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
    @Body() body: { photoId: string }
  ) {
    return this.storageService.completeGuestUpload(body.photoId);
  }

  @Post('events/:slug/guest-direct-upload')
  @UseInterceptors(FileInterceptor('file'))
  async uploadGuestPhotoDirect(
    @Param('slug') slug: string,
    @UploadedFile() file: any
  ) {
    return this.storageService.uploadGuestPhotoDirect(slug, file);
  }

  @Get('events/:slug/guest-upload-status')
  async getGuestUploadStatus(@Param('slug') slug: string) {
    return this.storageService.getGuestUploadLimitsStatus(slug);
  }




  @Post('events/:slug/favorites')
  async saveClientFavorites(
    @Param('slug') slug: string,
    @Body() body: {
      clientSessionId: string;
      clientName: string;
      clientPhone?: string;
      photoIds: string[];
    }
  ) {
    return this.storageService.saveClientFavorites(
      slug,
      body.clientSessionId,
      body.clientName,
      body.clientPhone,
      body.photoIds
    );
  }

  @Post('events/:slug/get-client-favorites')
  async getClientFavorites(
    @Param('slug') slug: string,
    @Body() body: { clientSessionId: string; clientPhone?: string }
  ) {
    return this.storageService.getClientFavorites(slug, body.clientSessionId, body.clientPhone);
  }

  @Get('events/:slug/photos/:photoId/view')
  async viewPhoto(
    @Param('slug') slug: string,
    @Param('photoId') photoId: string,
    @Query('thumb') thumb: string,
    @Res() res: any
  ) {
    const isThumb = thumb === 'true';
    const result = await this.storageService.getWatermarkedImageStream(slug, photoId, isThumb);
    if (result.redirectUrl) {
      return res.redirect(result.redirectUrl);
    }
    res.setHeader('Content-Type', result.contentType);
    res.setHeader('Content-Disposition', 'inline; filename="preview.jpg"');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.end(result.buffer);
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

  @Get('branding/banner/:photographerId')
  async viewPublicBrandingBanner(
    @Param('photographerId') photographerId: string,
    @Res() res: any
  ) {
    const result = await this.storageService.getBrandingBannerStream(photographerId) as any;
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

  @Post('search-face')
  @UseInterceptors(FileInterceptor('selfie'))
  async searchFacePublic(
    @UploadedFile() selfie: any,
    @Body() body: { eventId?: string; passcode?: string },
  ) {
    return this.storageService.searchFacePublic(selfie, body.eventId, body.passcode);
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

  @Get('portfolio/video/stream')
  async streamVideo(
    @Query('key') key: string,
    @Headers('range') range: string,
    @Res() res: any
  ) {
    if (!key) {
      return res.status(400).send('Missing key parameter');
    }
    const { stream, contentType, contentLength, contentRange, statusCode } = 
      await this.storageService.streamPortfolioVideo(key, range);

    res.status(statusCode);
    res.setHeader('Content-Type', contentType);
    if (contentLength) {
      res.setHeader('Content-Length', contentLength);
    }
    if (contentRange) {
      res.setHeader('Content-Range', contentRange);
    }
    res.setHeader('Accept-Ranges', 'bytes');
    
    // Pipe the S3 readable stream to the express response object
    if (stream && typeof (stream as any).pipe === 'function') {
      (stream as any).pipe(res);
    } else if (stream) {
      const readable = require('stream').Readable.from(stream as any);
      readable.pipe(res);
    } else {
      res.end();
    }
  }

  // Public webhook call from Cloudflare Worker upon thumbnail resize success
  @Post('webhook/thumbnail-complete')
  async handleThumbnailComplete(
    @Body() body: { photoId: string; thumbKey: string; previewKey?: string; secretKey: string }
  ) {
    return this.storageService.completeThumbnailWebhook(body);
  }
}

