import {
  Controller,
  Get,
  Post,
  Put,
  Body,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { WalletService } from './wallet.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  /**
   * User: Get My Dual-Wallet Balances, Rate & Recent Transactions
   */
  @UseGuards(JwtAuthGuard)
  @Get('my-wallet')
  async getMyWallet(@CurrentUser() user: any) {
    const photographerId = user.photographer?.id || user.id;
    return this.walletService.getMyWallet(photographerId);
  }

  /**
   * User: Liquidate Expiring AI Fuel Credits into Permanent Studio Cash
   */
  @UseGuards(JwtAuthGuard)
  @Post('convert')
  async convertCreditsToCash(
    @CurrentUser() user: any,
    @Body('credits') credits: number,
  ) {
    const photographerId = user.photographer?.id || user.id;
    if (!credits || Number(credits) <= 0) {
      throw new BadRequestException('Please provide a valid positive number of credits to convert.');
    }
    return this.walletService.convertCreditsToCash(photographerId, Number(credits));
  }

  /**
   * User: 100% Full Wallet Checkout (Instant Zero-Gateway Payment)
   */
  @UseGuards(JwtAuthGuard)
  @Post('pay-order')
  async payWithFullWalletCash(
    @CurrentUser() user: any,
    @Body()
    body: {
      packageId?: string;
      yearsCount?: number;
      creditPackId?: string;
      promoCode?: string;
    },
  ) {
    const photographerId = user.photographer?.id || user.id;
    return this.walletService.payWithFullWalletCash(photographerId, body);
  }

  // ================= ADMIN ROUTES ================= //

  /**
   * Admin: Get Wallet Global Conversion Configuration
   */
  @Get('admin/config')
  async getAdminConfig() {
    return this.walletService.getAdminConfig();
  }

  /**
   * Admin: Update Global Conversion Settings (Rate, Min Limit, Toggle)
   */
  @Put('admin/config')
  async updateAdminConfig(
    @Body()
    body: {
      creditsPerRupee?: number;
      minCreditsToConvert?: number;
      isConversionEnabled?: boolean;
      cashBackPercent?: number;
    },
  ) {
    return this.walletService.updateAdminConfig(body);
  }

  /**
   * Admin: Manually Adjust (Add/Deduct/Set) Studio Cash for any Photographer
   */
  @Post('admin/adjust')
  async adminAdjustWalletCash(
    @Body()
    body: {
      photographerId: string;
      amountRupees: number;
      mode: 'ADD' | 'DEDUCT' | 'SET';
      reason?: string;
    },
  ) {
    if (!body.photographerId || body.amountRupees === undefined || !body.mode) {
      throw new BadRequestException('photographerId, amountRupees and mode (ADD/DEDUCT/SET) are required.');
    }
    return this.walletService.adminAdjustWalletCash(body);
  }

  /**
   * Admin: Get All Studio Cash Wallets & Summary Statistics
   */
  @Get('admin/summary')
  async getAdminWalletsSummary() {
    return this.walletService.getAdminWalletsSummary();
  }
}
