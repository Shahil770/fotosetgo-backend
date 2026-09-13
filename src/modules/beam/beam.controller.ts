import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
import { BeamService } from './beam.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('beam')
export class BeamController {
  constructor(private beamService: BeamService) {}

  @UseGuards(JwtAuthGuard)
  @Get('events/:eventId/credentials')
  async getCredentials(@CurrentUser() user: any, @Param('eventId') eventId: string) {
    return this.beamService.getCredentials(user.photographer.id, eventId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('events/:eventId/toggle')
  async toggleBeam(@CurrentUser() user: any, @Param('eventId') eventId: string, @Body() body: { enabled: boolean }) {
    return this.beamService.toggleBeam(user.photographer.id, eventId, body.enabled);
  }

  @UseGuards(JwtAuthGuard)
  @Post('events/:eventId/regenerate-pin')
  async regeneratePin(@CurrentUser() user: any, @Param('eventId') eventId: string) {
    return this.beamService.regeneratePin(user.photographer.id, eventId);
  }

  @UseGuards(JwtAuthGuard)
  @Post('events/:eventId/upload-mode')
  async updateUploadMode(@CurrentUser() user: any, @Param('eventId') eventId: string, @Body() body: { uploadMode: string }) {
    return this.beamService.updateUploadMode(user.photographer.id, eventId, body.uploadMode);
  }

  @Post('internal/verify-credentials')
  async verifyCredentials(@Body() body: { username: string; password: string; sessionId?: string }) {
    return this.beamService.verifyCredentials(body.username, body.password, body.sessionId);
  }

  @Post('internal/camera-connected')
  async handleCameraConnected(@Body() body: { photographerId: string; sessionId: string; eventId: string }) {
    return this.beamService.registerCameraSession(body.photographerId, body.sessionId, body.eventId);
  }

  @Post('internal/camera-disconnected')
  async handleCameraDisconnected(@Body() body: { photographerId: string; sessionId: string }) {
    return this.beamService.deregisterCameraSession(body.photographerId, body.sessionId);
  }

  @Post('internal/photo-ingested')
  async handlePhotoIngested(@Body() body: any) {
    return this.beamService.handlePhotoIngested(body);
  }
}

