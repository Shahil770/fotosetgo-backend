import {
  Injectable,
  BadRequestException,
  NotFoundException,
  ForbiddenException,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { BillingService } from '../billing/billing.service';

@Injectable()
export class WalletService {
  private readonly logger = new Logger(WalletService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(forwardRef(() => BillingService))
    private readonly billingService: BillingService,
  ) { }

  /**
   * Get or Seed Default Wallet Configuration
   */
  async getWalletConfig() {
    let config = await this.prisma.walletConfig.findFirst();
    if (!config) {
      config = await this.prisma.walletConfig.create({
        data: {
          creditsPerRupee: 5,       // 5 AI Credits = ₹1 Studio Cash
          minCreditsToConvert: 250,  // Minimum 250 credits to liquidate
          isConversionEnabled: true,
          cashBackPercent: 0,
        },
      });
      this.logger.log('[Wallet] Seeded default WalletConfig (5 Credits = ₹1, Min 250 Credits)');
    }
    return config;
  }

  /**
   * Get Photographer's Dual-Wallet Balances & Recent Transactions
   */
  async getMyWallet(photographerId: string) {
    const [photographer, config] = await Promise.all([
      this.prisma.photographer.findUnique({
        where: { id: photographerId },
        include: {
          user: { select: { name: true, email: true } },
          subscriptions: {
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { package: true },
          },
        },
      }),
      this.getWalletConfig(),
    ]);

    if (!photographer) {
      throw new NotFoundException('Photographer not found');
    }

    const aiCreditsBalance = (photographer.creditBalance || 0) / 100; // in credit units
    const walletCashBalanceRupees = (photographer.walletCashBalance || 0) / 100;

    // Potential cash value if all current AI credits are converted
    const potentialCashRupees = Math.floor(aiCreditsBalance / config.creditsPerRupee);

    const recentTransactions = await this.prisma.walletCashTransaction.findMany({
      where: { photographerId },
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    const activeSub = photographer.subscriptions?.[0];

    return {
      aiCreditsBalance,
      aiCreditsBalanceRupees: aiCreditsBalance, // 1 credit ≈ ₹1 in scan power
      walletCashBalancePaise: photographer.walletCashBalance || 0,
      walletCashBalanceRupees,
      creditsPerRupee: config.creditsPerRupee,
      minCreditsToConvert: config.minCreditsToConvert,
      isConversionEnabled: config.isConversionEnabled,
      potentialCashRupees,
      currentPlanName: activeSub?.package?.name || 'Free',
      currentPlanExpiry: activeSub?.endsAt,
      transactions: recentTransactions.map((tx) => ({
        id: tx.id,
        amountRupees: tx.amount / 100,
        amountPaise: tx.amount,
        action: tx.action,
        description: tx.description,
        creditsDebited: tx.creditsDebited || 0,
        paymentOrderId: tx.paymentOrderId,
        createdAt: tx.createdAt,
      })),
    };
  }

  /**
   * Convert Expiring AI Credits -> Permanent Studio Cash Wallet
   */
  async convertCreditsToCash(photographerId: string, creditsToConvert: number) {
    const config = await this.getWalletConfig();

    if (!config.isConversionEnabled) {
      throw new ForbiddenException('Credit liquidation is currently paused by admin.');
    }

    const rawCredits = Math.floor(Number(creditsToConvert));
    if (isNaN(rawCredits) || rawCredits < config.minCreditsToConvert) {
      throw new BadRequestException(
        `Minimum conversion limit is ${config.minCreditsToConvert} AI credits.`,
      );
    }

    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
    });

    if (!photographer) {
      throw new NotFoundException('Photographer not found');
    }

    const creditsAvailable = (photographer.creditBalance || 0) / 100;
    if (creditsAvailable < rawCredits) {
      throw new BadRequestException(
        `Insufficient AI Credits. You have ${creditsAvailable.toFixed(0)} credits, but requested ${rawCredits}.`,
      );
    }

    // Rate Calculation: e.g. 2500 Credits / 5 = ₹500.00
    const cashGainedRupees = Math.floor(rawCredits / config.creditsPerRupee);
    if (cashGainedRupees <= 0) {
      throw new BadRequestException(
        `Credits requested yields less than ₹1. Minimum required is ${config.creditsPerRupee} credits for ₹1.`,
      );
    }

    const cashGainedPaise = cashGainedRupees * 100;
    const creditsDebitedPaise = rawCredits * 100;

    // Atomic Execution: Deduct AI Credits, Add Studio Cash, Log Both Ledgers
    const result = await this.prisma.$transaction(async (tx) => {
      // 1. Deduct from creditBalance
      const updatedPhotographer = await tx.photographer.update({
        where: { id: photographerId },
        data: {
          creditBalance: { decrement: creditsDebitedPaise },
          walletCashBalance: { increment: cashGainedPaise },
        },
      });

      // 2. Log in CreditTransaction (Scans ledger)
      await tx.creditTransaction.create({
        data: {
          photographerId,
          amount: -creditsDebitedPaise,
          action: 'LIQUIDATION_CONVERT',
          description: `Liquidated ${rawCredits} AI credits to permanent ₹${cashGainedRupees.toFixed(2)} Studio Cash`,
        },
      });

      // 3. Log in WalletCashTransaction (Store Cash ledger)
      const cashTx = await tx.walletCashTransaction.create({
        data: {
          photographerId,
          amount: cashGainedPaise,
          action: 'LIQUIDATION_CONVERT',
          creditsDebited: rawCredits,
          description: `Converted ${rawCredits} AI credits at ${config.creditsPerRupee}:1 rate (+₹${cashGainedRupees.toFixed(2)})`,
        },
      });

      return {
        updatedPhotographer,
        cashTx,
      };
    });

    this.logger.log(
      `[Wallet] Converted ${rawCredits} AI credits to ₹${cashGainedRupees} Studio Cash for photographer ${photographerId}`,
    );

    return {
      success: true,
      message: `Successfully converted ${rawCredits} AI Credits into ₹${cashGainedRupees.toFixed(2)} Permanent Studio Cash!`,
      creditsDebited: rawCredits,
      cashGainedRupees,
      newAiCreditsBalance: (result.updatedPhotographer.creditBalance || 0) / 100,
      newWalletCashBalanceRupees: (result.updatedPhotographer.walletCashBalance || 0) / 100,
    };
  }

  /**
   * 100% Full Wallet Cash Payment (Zero-Gateway Instant Activation)
   */
  async payWithFullWalletCash(
    photographerId: string,
    payload: {
      packageId?: string;
      yearsCount?: number;
      creditPackId?: string;
      promoCode?: string;
    },
  ) {
    const { packageId, yearsCount = 1, creditPackId, promoCode } = payload;

    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
      include: { user: true },
    });

    if (!photographer) {
      throw new NotFoundException('Photographer not found');
    }

    const currentWalletCashPaise = photographer.walletCashBalance || 0;

    if (packageId) {
      // SUBSCRIPTION PURCHASE VIA WALLET CASH
      const targetPackage = await this.prisma.package.findUnique({
        where: { id: packageId },
      });
      if (!targetPackage) {
        throw new NotFoundException('Package not found');
      }

      const pricing = await this.billingService.calculatePlanPricing(
        photographerId,
        packageId,
        yearsCount,
      );

      // Validate & calculate Promo Discount if present
      let promoDiscountPaise = 0;
      let appliedPromoCodeId: string | null = null;
      let appliedPromoCodeText: string | null = null;

      if (promoCode && promoCode.trim()) {
        try {
          const promoValidation = await this.billingService.validatePromoCodeInternal(
            photographerId,
            promoCode,
            'SUBSCRIPTION',
            pricing.taxableSubtotalRupees,
          );
          if (promoValidation.isValid && promoValidation.discountRupees !== undefined) {
            promoDiscountPaise = Math.round(promoValidation.discountRupees * 100);
            appliedPromoCodeId = promoValidation.promoCodeId || null;
            appliedPromoCodeText = promoValidation.code || null;
          }
        } catch (e) { }
      }

      const finalTaxableSubtotalPaise = Math.max(
        0,
        pricing.taxableSubtotalPaise - promoDiscountPaise,
      );
      const finalTaxAmountPaise = Math.round(
        finalTaxableSubtotalPaise * (pricing.taxPercent / 100),
      );
      const totalRequiredPaise = finalTaxableSubtotalPaise + finalTaxAmountPaise;

      if (currentWalletCashPaise < totalRequiredPaise) {
        throw new BadRequestException(
          `Insufficient Studio Cash balance. Required: ₹${(totalRequiredPaise / 100).toFixed(2)}, Available in Wallet: ₹${(currentWalletCashPaise / 100).toFixed(2)}.`,
        );
      }

      const currentYear = new Date().getFullYear();
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const invoiceNumber = `FSG-${currentYear}-${randomSuffix}`;

      const startsAt = new Date();
      const endsAt = new Date(startsAt);
      endsAt.setFullYear(endsAt.getFullYear() + pricing.yearsCount);

      // Execute atomic transaction for 100% wallet checkout
      const result = await this.prisma.$transaction(async (tx) => {
        // 1. Deduct full amount from Studio Cash
        await tx.photographer.update({
          where: { id: photographerId },
          data: {
            walletCashBalance: { decrement: totalRequiredPaise },
            activePackageId: targetPackage.id,
          },
        });

        // 2. Create PaymentOrder record
        const paymentOrder = await tx.paymentOrder.create({
          data: {
            photographerId,
            packageId: targetPackage.id,
            orderType: 'SUBSCRIPTION',
            razorpayOrderId: `WALLET_SUB_${Date.now()}_${randomSuffix}`,
            razorpayPaymentId: `WALLET_PAID_${Date.now()}`,
            razorpaySignature: 'wallet_internal_verified',
            subtotalAmount: finalTaxableSubtotalPaise,
            taxAmount: finalTaxAmountPaise,
            amount: totalRequiredPaise,
            walletCashUsedAmount: totalRequiredPaise,
            currency: 'INR',
            status: 'SUCCESS',
            billingInterval: pricing.yearsCount === 1 ? 'YEARLY' : `${pricing.yearsCount}_YEARS`,
            yearsCount: pricing.yearsCount,
            isFirstTime: pricing.isFirstTime,
            discountPercent: pricing.discountPercent,
            discountAmount: pricing.discountAmountPaise,
            promoCodeId: appliedPromoCodeId,
            promoCodeText: appliedPromoCodeText,
            promoDiscountAmount: promoDiscountPaise,
            invoiceNumber,
          },
        });

        // 3. Log WalletCashTransaction
        await tx.walletCashTransaction.create({
          data: {
            photographerId,
            amount: -totalRequiredPaise,
            action: 'SUBSCRIPTION_PAYMENT',
            paymentOrderId: paymentOrder.id,
            description: `100% Wallet Payment for ${targetPackage.name} Plan (${pricing.yearsCount} Year) (-₹${(totalRequiredPaise / 100).toFixed(2)})`,
          },
        });

        // 4. Update or create Subscription record
        const existingSub = await tx.subscription.findFirst({
          where: { photographerId, status: 'ACTIVE' },
        });

        if (existingSub) {
          await tx.subscription.update({
            where: { id: existingSub.id },
            data: {
              packageId: targetPackage.id,
              status: 'ACTIVE',
              startsAt,
              endsAt,
              yearsCount: pricing.yearsCount,
              amountPaid: totalRequiredPaise,
              limitBytes: BigInt(targetPackage.maxStorageGb) * BigInt(1024 * 1024 * 1024),
              limitEventsBytes: BigInt(targetPackage.maxEventsStorageMb) * BigInt(1024 * 1024),
              limitPortfolioBytes: BigInt(targetPackage.maxPortfolioStorageMb) * BigInt(1024 * 1024),
            },
          });
        } else {
          await tx.subscription.create({
            data: {
              photographerId,
              packageId: targetPackage.id,
              status: 'ACTIVE',
              startsAt,
              endsAt,
              yearsCount: pricing.yearsCount,
              amountPaid: totalRequiredPaise,
              limitBytes: BigInt(targetPackage.maxStorageGb) * BigInt(1024 * 1024 * 1024),
              limitEventsBytes: BigInt(targetPackage.maxEventsStorageMb) * BigInt(1024 * 1024),
              limitPortfolioBytes: BigInt(targetPackage.maxPortfolioStorageMb) * BigInt(1024 * 1024),
            },
          });
        }

        // 5. Credit Monthly Plan AI Credits Quota
        const monthlyCreditsPaise = targetPackage.faceScanCredits || 0;
        if (monthlyCreditsPaise > 0) {
          await tx.photographer.update({
            where: { id: photographerId },
            data: { creditBalance: { increment: monthlyCreditsPaise } },
          });

          await tx.creditTransaction.create({
            data: {
              photographerId,
              amount: monthlyCreditsPaise,
              action: 'PLAN_BENEFIT',
              description: `Monthly AI Fuel Quota for ${targetPackage.name} Plan (Paid with Studio Cash)`,
            },
          });
        }

        return { paymentOrder, invoiceNumber };
      });

      this.logger.log(
        `[Wallet] 100% Wallet checkout successful for photographer ${photographerId} -> ${targetPackage.name} (₹${(totalRequiredPaise / 100).toFixed(2)})`,
      );

      return {
        success: true,
        orderType: 'SUBSCRIPTION',
        packageName: targetPackage.name,
        invoiceNumber: result.invoiceNumber,
        startsAt,
        endsAt,
        amountPaidRupees: totalRequiredPaise / 100,
        paidWithWallet: true,
      };
    } else if (creditPackId) {
      // AI CREDIT PACK PURCHASE VIA WALLET CASH
      const creditPack = await this.prisma.aiCreditPack.findUnique({
        where: { id: creditPackId },
      });
      if (!creditPack) {
        throw new NotFoundException('AI Credit Pack not found');
      }

      const basePricePaise = creditPack.price;
      const discountPercent = creditPack.discountPercent || 0;
      const discountAmountPaise = Math.round(basePricePaise * (discountPercent / 100));
      const afterDiscountPaise = basePricePaise - discountAmountPaise;

      const taxPercent = creditPack.tax ?? 18;
      const taxAmountPaise = Math.round(afterDiscountPaise * (taxPercent / 100));
      const totalRequiredPaise = afterDiscountPaise + taxAmountPaise;

      if (currentWalletCashPaise < totalRequiredPaise) {
        throw new BadRequestException(
          `Insufficient Studio Cash balance. Required: ₹${(totalRequiredPaise / 100).toFixed(2)}, Available: ₹${(currentWalletCashPaise / 100).toFixed(2)}.`,
        );
      }

      const currentYear = new Date().getFullYear();
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      const invoiceNumber = `FSG-${currentYear}-${randomSuffix}`;

      await this.prisma.$transaction(async (tx) => {
        // 1. Deduct from Studio Cash Wallet
        await tx.photographer.update({
          where: { id: photographerId },
          data: {
            walletCashBalance: { decrement: totalRequiredPaise },
            creditBalance: { increment: creditPack.creditsGiven },
          },
        });

        // 2. Create PaymentOrder
        const paymentOrder = await tx.paymentOrder.create({
          data: {
            photographerId,
            creditPackId: creditPack.id,
            orderType: 'CREDIT_TOPUP',
            razorpayOrderId: `WALLET_PACK_${Date.now()}_${randomSuffix}`,
            razorpayPaymentId: `WALLET_PAID_${Date.now()}`,
            razorpaySignature: 'wallet_internal_verified',
            subtotalAmount: afterDiscountPaise,
            taxAmount: taxAmountPaise,
            amount: totalRequiredPaise,
            creditsGiven: creditPack.creditsGiven,
            walletCashUsedAmount: totalRequiredPaise,
            currency: 'INR',
            status: 'SUCCESS',
            invoiceNumber,
          },
        });

        // 3. Log WalletCashTransaction
        await tx.walletCashTransaction.create({
          data: {
            photographerId,
            amount: -totalRequiredPaise,
            action: 'CREDIT_TOPUP_PAYMENT',
            paymentOrderId: paymentOrder.id,
            description: `100% Wallet Payment for ${creditPack.name} (+${(creditPack.creditsGiven / 100).toFixed(0)} AI Credits) (-₹${(totalRequiredPaise / 100).toFixed(2)})`,
          },
        });

        // 4. Log CreditTransaction
        await tx.creditTransaction.create({
          data: {
            photographerId,
            amount: creditPack.creditsGiven,
            action: 'TOPUP',
            description: `Studio Cash purchase of ${creditPack.name} (+${(creditPack.creditsGiven / 100).toFixed(0)} AI Credits)`,
          },
        });
      });

      return {
        success: true,
        orderType: 'CREDIT_TOPUP',
        packName: creditPack.name,
        creditsGiven: creditPack.creditsGiven / 100,
        invoiceNumber,
        amountPaidRupees: totalRequiredPaise / 100,
        paidWithWallet: true,
      };
    }

    throw new BadRequestException('Please provide either packageId or creditPackId to purchase.');
  }

  // ================= ADMIN METHODS ================= //

  /**
   * Admin: Get Wallet Global Config
   */
  async getAdminConfig() {
    return this.getWalletConfig();
  }

  /**
   * Admin: Update Global Conversion Settings
   */
  async updateAdminConfig(data: {
    creditsPerRupee?: number;
    minCreditsToConvert?: number;
    isConversionEnabled?: boolean;
    cashBackPercent?: number;
  }) {
    const config = await this.getWalletConfig();
    const updated = await this.prisma.walletConfig.update({
      where: { id: config.id },
      data: {
        creditsPerRupee: data.creditsPerRupee !== undefined ? Number(data.creditsPerRupee) : config.creditsPerRupee,
        minCreditsToConvert: data.minCreditsToConvert !== undefined ? Number(data.minCreditsToConvert) : config.minCreditsToConvert,
        isConversionEnabled: data.isConversionEnabled !== undefined ? Boolean(data.isConversionEnabled) : config.isConversionEnabled,
        cashBackPercent: data.cashBackPercent !== undefined ? Number(data.cashBackPercent) : config.cashBackPercent,
      },
    });

    this.logger.log(`[Admin] Updated WalletConfig: ${JSON.stringify(updated)}`);
    return updated;
  }

  /**
   * Admin: Manually Adjust (Add/Deduct/Set) Studio Cash for any Photographer
   */
  async adminAdjustWalletCash(data: {
    photographerId: string;
    amountRupees: number;
    mode: 'ADD' | 'DEDUCT' | 'SET';
    reason?: string;
  }) {
    const { photographerId, amountRupees, mode, reason } = data;
    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
      include: { user: true },
    });

    if (!photographer) {
      throw new NotFoundException('Photographer not found');
    }

    const amountPaise = Math.round(Number(amountRupees) * 100);
    let newBalancePaise = photographer.walletCashBalance || 0;
    let deltaPaise = 0;

    if (mode === 'ADD') {
      newBalancePaise += amountPaise;
      deltaPaise = amountPaise;
    } else if (mode === 'DEDUCT') {
      newBalancePaise = Math.max(0, newBalancePaise - amountPaise);
      deltaPaise = -amountPaise;
    } else if (mode === 'SET') {
      deltaPaise = amountPaise - newBalancePaise;
      newBalancePaise = Math.max(0, amountPaise);
    }

    const updated = await this.prisma.photographer.update({
      where: { id: photographerId },
      data: { walletCashBalance: newBalancePaise },
    });

    await this.prisma.walletCashTransaction.create({
      data: {
        photographerId,
        amount: deltaPaise,
        action: deltaPaise >= 0 ? 'ADMIN_CREDIT' : 'ADMIN_DEBIT',
        description: reason || `Super Admin manual ${mode} adjustment of ₹${amountRupees}`,
      },
    });

    this.logger.log(
      `[Admin] Adjusted Studio Cash for ${photographer.user.email} (${mode} ₹${amountRupees} -> New Balance: ₹${(newBalancePaise / 100).toFixed(2)})`,
    );

    return {
      success: true,
      photographerId,
      newWalletCashBalanceRupees: newBalancePaise / 100,
    };
  }

  /**
   * Admin: Get all Studio Cash Wallets & Summary Statistics
   */
  async getAdminWalletsSummary() {
    const [photographers, config, transactions] = await Promise.all([
      this.prisma.photographer.findMany({
        include: {
          user: { select: { name: true, email: true, phone: true } },
          subscriptions: {
            where: { status: 'ACTIVE' },
            orderBy: { createdAt: 'desc' },
            take: 1,
            include: { package: true },
          },
        },
        orderBy: { walletCashBalance: 'desc' },
      }),
      this.getWalletConfig(),
      this.prisma.walletCashTransaction.findMany({
        take: 100,
        orderBy: { createdAt: 'desc' },
        include: {
          photographer: {
            include: { user: { select: { name: true, email: true } } },
          },
        },
      }),
    ]);

    const totalCashInCirculationPaise = photographers.reduce(
      (sum, p) => sum + (p.walletCashBalance || 0),
      0,
    );

    const totalAiCreditsInCirculation = photographers.reduce(
      (sum, p) => sum + ((p.creditBalance || 0) / 100),
      0,
    );

    const totalConvertedTxs = await this.prisma.walletCashTransaction.findMany({
      where: { action: 'LIQUIDATION_CONVERT' },
    });

    const totalLiquidatedCashPaise = totalConvertedTxs.reduce(
      (sum, t) => sum + t.amount,
      0,
    );

    const totalAiCreditsLiquidated = totalConvertedTxs.reduce(
      (sum, t) => sum + (t.creditsDebited || 0),
      0,
    );

    return {
      config,
      kpis: {
        totalCashInCirculationRupees: totalCashInCirculationPaise / 100,
        totalAiCreditsInCirculation,
        totalLiquidatedCashRupees: totalLiquidatedCashPaise / 100,
        totalAiCreditsLiquidated,
        totalUsersWithCash: photographers.filter((p) => (p.walletCashBalance || 0) > 0).length,
      },
      photographers: photographers.map((p) => ({
        id: p.id,
        name: p.studioName || p.user.name,
        email: p.user.email,
        phone: p.user.phone || 'N/A',
        planName: p.subscriptions?.[0]?.package?.name || 'Free',
        aiCredits: (p.creditBalance || 0) / 100,
        walletCashRupees: (p.walletCashBalance || 0) / 100,
        walletCashPaise: p.walletCashBalance || 0,
      })),
      recentTransactions: transactions.map((t) => ({
        id: t.id,
        photographerId: t.photographerId,
        photographerName: t.photographer?.studioName || t.photographer?.user?.name || 'Studio Member',
        photographerEmail: t.photographer?.user?.email || 'N/A',
        amountRupees: t.amount / 100,
        amountPaise: t.amount,
        action: t.action,
        description: t.description,
        creditsDebited: t.creditsDebited || 0,
        createdAt: t.createdAt,
      })),
    };
  }
}
