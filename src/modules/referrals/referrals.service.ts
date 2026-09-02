import { Injectable, NotFoundException, BadRequestException, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';

@Injectable()
export class ReferralsService {
  private readonly logger = new Logger(ReferralsService.name);

  constructor(private prisma: PrismaService) {}

  /**
   * Get Referral Statistics for Photographer Dashboard
   */
  async getMyStats(photographerId: string) {
    const photographer = await this.prisma.photographer.findUnique({
      where: { id: photographerId },
      include: {
        user: true,
        subscriptions: {
          where: { status: 'ACTIVE' },
          include: { package: true },
        },
      },
    });

    if (!photographer) {
      throw new NotFoundException('Photographer profile not found');
    }

    // Check Profile Completion: Name, Email and Phone
    const hasPhone = !!(photographer.user?.phone || photographer.whatsappPhone || photographer.portfolioPhone);
    const hasName = !!photographer.user?.name;
    const hasEmail = !!photographer.user?.email;
    const isProfileComplete = hasPhone && hasName && hasEmail;

    // Ensure photographer has a referral code
    let referralCode = photographer.referralCode;
    if (!referralCode) {
      const prefix = (photographer.studioName || photographer.user?.name || 'STUDIO')
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 5)
        .toUpperCase() || 'STUDIO';
      const randomSuffix = Math.floor(1000 + Math.random() * 9000);
      referralCode = `${prefix}-${randomSuffix}`;
      await this.prisma.photographer.update({
        where: { id: photographerId },
        data: { referralCode },
      });
    }

    const now = new Date();

    // Count all signups with this photographer's referral
    const totalInvited = await this.prisma.photographer.count({
      where: { referredById: photographerId },
    });

    // Query active paid converted referrals
    const activeReferrals = await this.prisma.referral.findMany({
      where: {
        referrerId: photographerId,
        status: 'ACTIVE',
        validUntil: { gt: now },
        referredUser: {
          subscriptions: {
            some: { status: 'ACTIVE', endsAt: { gt: now } },
          },
        },
      },
    });

    // Calculate active monthly boost in Rupees
    const activeMonthlyBoostPaise = activeReferrals.reduce((sum, r) => sum + (r.monthlyBoostCredits || 0), 0);
    const activeMonthlyBoostRupees = activeMonthlyBoostPaise / 100;

    // Calculate lifetime earned referral credits from ledger
    const totalCreditsTx = await this.prisma.creditTransaction.aggregate({
      where: {
        photographerId,
        action: {
          in: ['REFERRAL_INSTANT_BONUS', 'REFERRAL_MONTHLY_BOOST'],
        },
      },
      _sum: { amount: true },
    });
    const totalEarnedPaise = totalCreditsTx._sum.amount || 0;

    const activeSub = photographer.subscriptions?.[0];
    const isReferrerActivePaidTier = !!(activeSub && (activeSub.package?.faceScanCredits || 0) > 0);

    const packageConfigs = await this.prisma.package.findMany({
      where: { isActive: true, name: { not: 'Free' } },
      orderBy: { price: 'asc' },
      include: { referralConfig: true },
    });

    const packageRewardMatrix = packageConfigs.map((p) => ({
      packageName: p.name,
      instantBonusCredits: (p.referralConfig?.instantBonusCredits || 0) / 100,
      monthlyBoostCredits: (p.referralConfig?.monthlyBoostCredits || 0) / 100,
      refereeWelcomeCredits: (p.referralConfig?.refereeWelcomeCredits || 0) / 100,
    }));

    return {
      referralCode,
      referralLink: `http://localhost:3000/signup?ref=${referralCode}`,
      totalInvited,
      activeReferrals: activeReferrals.length,
      activeConversions: activeReferrals.length,
      currentMonthlyBoost: activeMonthlyBoostRupees,
      activeMonthlyBoostRupees,
      totalBonusCreditsEarned: totalEarnedPaise / 100,
      totalEarnedRupees: totalEarnedPaise / 100,
      isProfileComplete,
      referrerPlanActive: isReferrerActivePaidTier,
      isReferrerActivePaidTier,
      currentPlanName: activeSub?.package?.name || 'Free',
      currentPlanExpiry: activeSub?.endsAt,
      packageRewardMatrix,
    };
  }

  /**
   * Get List of Referred Photographers for User Dashboard
   */
  async getMyReferrals(photographerId: string) {
    const now = new Date();
    const referrals = await this.prisma.referral.findMany({
      where: { referrerId: photographerId },
      include: {
        referredUser: {
          include: {
            user: true,
            subscriptions: {
              where: { status: 'ACTIVE' },
              orderBy: { createdAt: 'desc' },
            },
          },
        },
        package: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    return referrals.map((r) => {
      const email = r.referredUser?.user?.email || '';
      const [namePart, domainPart] = email.split('@');
      const maskedEmail = namePart
        ? `${namePart.slice(0, 2)}***@${domainPart || 'gmail.com'}`
        : 'photographer@***.com';

      const friendName = r.referredUser?.studioName || r.referredUser?.user?.name || 'Studio Member';
      const isStillActive = r.status === 'ACTIVE' && new Date(r.validUntil) > now;

      return {
        id: r.id,
        refereeName: friendName,
        friendName,
        refereeEmail: maskedEmail,
        maskedEmail,
        packageName: r.package?.name || 'Subscription',
        planName: r.package?.name || 'Subscription',
        tenureYears: r.tenureYears,
        instantCreditsAwarded: (r.instantCreditsAwarded || 0) / 100,
        instantBonusRupees: (r.instantCreditsAwarded || 0) / 100,
        monthlyBoostCredits: (r.monthlyBoostCredits || 0) / 100,
        monthlyBoostRupees: (r.monthlyBoostCredits || 0) / 100,
        status: isStillActive ? 'ACTIVE' : r.status,
        validFrom: r.validFrom,
        validUntil: r.validUntil,
        joinedAt: r.createdAt,
      };
    });
  }

  /**
   * Admin: Get all packages with referral config
   */
  async getAdminConfigs() {
    const packages = await this.prisma.package.findMany({
      where: { isActive: true },
      orderBy: { price: 'asc' },
      include: { referralConfig: true },
    });

    return packages.map((pkg) => ({
      packageId: pkg.id,
      packageName: pkg.name,
      priceRupees: pkg.price / 100,
      faceScanCreditsRupees: (pkg.faceScanCredits || 0) / 100,
      isReferralEnabled: pkg.referralConfig?.isReferralEnabled ?? (pkg.name !== 'Free'),
      instantBonusRupees: ((pkg.referralConfig?.instantBonusCredits || 0) / 100),
      monthlyBoostRupees: ((pkg.referralConfig?.monthlyBoostCredits || 0) / 100),
      refereeWelcomeRupees: ((pkg.referralConfig?.refereeWelcomeCredits || 5000) / 100),
    }));
  }

  /**
   * Admin: Update Referral Configs
   */
  async updateAdminConfigs(
    configs: Array<{
      packageId: string;
      isReferralEnabled: boolean;
      instantBonusRupees: number;
      monthlyBoostRupees: number;
      refereeWelcomeRupees: number;
    }>
  ) {
    for (const c of configs) {
      await this.prisma.referralConfig.upsert({
        where: { packageId: c.packageId },
        create: {
          packageId: c.packageId,
          isReferralEnabled: c.isReferralEnabled,
          instantBonusCredits: Math.round((c.instantBonusRupees || 0) * 100),
          monthlyBoostCredits: Math.round((c.monthlyBoostRupees || 0) * 100),
          refereeWelcomeCredits: Math.round((c.refereeWelcomeRupees || 0) * 100),
        },
        update: {
          isReferralEnabled: c.isReferralEnabled,
          instantBonusCredits: Math.round((c.instantBonusRupees || 0) * 100),
          monthlyBoostCredits: Math.round((c.monthlyBoostRupees || 0) * 100),
          refereeWelcomeCredits: Math.round((c.refereeWelcomeRupees || 0) * 100),
        },
      });
    }

    this.logger.log('[Admin] Updated referral reward configurations.');
    return { success: true, message: 'Referral reward configurations saved successfully.' };
  }

  /**
   * Admin: Get all referrals across the platform
   */
  async getAdminAllReferrals(search?: string, status?: string) {
    const where: any = {};
    if (status && status !== 'ALL') {
      where.status = status;
    }

    const referrals = await this.prisma.referral.findMany({
      where,
      include: {
        referrer: { include: { user: true } },
        referredUser: { include: { user: true } },
        package: true,
      },
      orderBy: { createdAt: 'desc' },
    });

    let results = referrals.map((r) => ({
      id: r.id,
      referrerId: r.referrerId,
      referrerName: r.referrer?.studioName || r.referrer?.user?.name || 'Studio Owner',
      referrerEmail: r.referrer?.user?.email || '',
      referrerCode: r.referrer?.referralCode || 'CODE',
      referredUserId: r.referredUserId,
      referredUserName: r.referredUser?.studioName || r.referredUser?.user?.name || 'New Member',
      referredUserEmail: r.referredUser?.user?.email || '',
      packageName: r.package?.name || 'Plan',
      tenureYears: r.tenureYears,
      instantCreditsRupees: (r.instantCreditsAwarded || 0) / 100,
      monthlyBoostRupees: (r.monthlyBoostCredits || 0) / 100,
      status: r.status,
      validFrom: r.validFrom,
      validUntil: r.validUntil,
      createdAt: r.createdAt,
    }));

    if (search && search.trim()) {
      const q = search.toLowerCase().trim();
      results = results.filter(
        (item) =>
          item.referrerName.toLowerCase().includes(q) ||
          item.referrerEmail.toLowerCase().includes(q) ||
          item.referrerCode.toLowerCase().includes(q) ||
          item.referredUserName.toLowerCase().includes(q) ||
          item.referredUserEmail.toLowerCase().includes(q)
      );
    }

    return results;
  }

  /**
   * Admin: Override individual referral rate or status
   */
  async overrideAdminReferral(
    referralId: string,
    data: { monthlyBoostRupees?: number; status?: string }
  ) {
    const referral = await this.prisma.referral.findUnique({
      where: { id: referralId },
    });

    if (!referral) {
      throw new NotFoundException('Referral record not found');
    }

    const updateData: any = {};
    if (data.monthlyBoostRupees !== undefined) {
      updateData.monthlyBoostCredits = Math.round(Number(data.monthlyBoostRupees) * 100);
    }
    if (data.status) {
      updateData.status = data.status;
    }

    const updated = await this.prisma.referral.update({
      where: { id: referralId },
      data: updateData,
    });

    this.logger.log(`[Admin] Overrode referral ${referralId}: monthlyBoost=${updated.monthlyBoostCredits/100}, status=${updated.status}`);
    return { success: true, referral: updated, message: 'Referral terms updated successfully.' };
  }
}
