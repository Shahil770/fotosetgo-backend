import {
  Controller,
  Get,
  Post,
  Put,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
} from '@nestjs/common';
import { ReferralsService } from './referrals.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { AdminGuard } from '../../common/guards/admin.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('referrals')
export class ReferralsController {
  constructor(private readonly referralsService: ReferralsService) {}

  /**
   * User: Get My Referral Dashboard Metrics & Link
   */
  @UseGuards(JwtAuthGuard)
  @Get('my-stats')
  async getMyStats(@CurrentUser() user: any) {
    const photographerId = user.photographer?.id || user.id;
    return this.referralsService.getMyStats(photographerId);
  }

  /**
   * User: Get My Referred Friends List
   */
  @UseGuards(JwtAuthGuard)
  @Get('my-referrals')
  async getMyReferrals(@CurrentUser() user: any) {
    const photographerId = user.photographer?.id || user.id;
    return this.referralsService.getMyReferrals(photographerId);
  }

  /**
   * Admin: Get Referral Reward Configs Matrix
   */
  @UseGuards(AdminGuard)
  @Get('admin/configs')
  async getAdminConfigs() {
    return this.referralsService.getAdminConfigs();
  }

  /**
   * Admin: Update Referral Reward Configs Matrix
   */
  @UseGuards(AdminGuard)
  @Put('admin/configs')
  async updateAdminConfigs(@Body() body: any) {
    const configs = Array.isArray(body) ? body : body.configs || [];
    return this.referralsService.updateAdminConfigs(configs);
  }

  /**
   * Admin: List All Platform Referrals
   */
  @UseGuards(AdminGuard)
  @Get('admin/all')
  async getAdminAllReferrals(
    @Query('search') search?: string,
    @Query('status') status?: string
  ) {
    return this.referralsService.getAdminAllReferrals(search, status);
  }

  /**
   * Admin: Override Referral Rate or Status
   */
  @UseGuards(AdminGuard)
  @Patch('admin/:referralId/override')
  async overrideAdminReferral(
    @Param('referralId') referralId: string,
    @Body() body: any
  ) {
    return this.referralsService.overrideAdminReferral(referralId, body);
  }
}
