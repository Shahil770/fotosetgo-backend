import { Injectable, Logger, Inject } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PrismaService } from '../../prisma.service';

@Injectable()
export class CreditsRenewCronService {
  private readonly logger = new Logger(CreditsRenewCronService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject('REDIS_CLIENT') private readonly redis: any,
  ) {}

  // Run at 00:00 on the 1st day of every month (equivalent to last date midnight)
  @Cron('0 0 0 1 * *')
  async renewAllPhotographerCredits() {
    const lockKey = 'lock:cron:credits-renew';
    let acquired: any = null;
    try {
      acquired = await this.redis.set(lockKey, '1', 'EX', 3600, 'NX');
    } catch {
      acquired = 'OK';
    }
    if (!acquired) {
      this.logger.log('[CreditsRenewCron] Cron skipped — already running on another cluster instance.');
      return;
    }

    this.logger.log('[CreditsRenewCron] Starting monthly credit renewal job with dynamic referral boosts...');

    try {
      const now = new Date();

      // Find all photographers with active subscriptions and active referrals
      const photographers = await this.prisma.photographer.findMany({
        include: {
          user: { select: { id: true, name: true, email: true } },
          subscriptions: {
            where: { status: 'ACTIVE', endsAt: { gt: now } },
            include: { package: true },
          },
          referralsMade: {
            where: {
              status: 'ACTIVE',
              validUntil: { gt: now },
              referredUser: {
                subscriptions: {
                  some: { status: 'ACTIVE', endsAt: { gt: now } },
                },
              },
            },
            include: {
              referredUser: { include: { user: { select: { name: true } } } },
              package: true,
            },
          },
        },
      });

      this.logger.log(`[CreditsRenewCron] Processing monthly credit renewal for ${photographers.length} photographers in concurrent chunks...`);

      let renewedCount = 0;
      const CHUNK_SIZE = 25; // Optimal batch size for PostgreSQL connection pool

      for (let i = 0; i < photographers.length; i += CHUNK_SIZE) {
        const chunk = photographers.slice(i, i + CHUNK_SIZE);
        await Promise.all(
          chunk.map(async (photographer) => {
            try {
              const activeSub = photographer.subscriptions?.[0];
              const baseCredits = (activeSub && activeSub.package?.faceScanCredits) ? activeSub.package.faceScanCredits : 0;

              // Referrer is only eligible for monthly referral boost if they are on an active paid AI plan (baseCredits > 0)
              let totalReferralBoost = 0;
              const validReferrals = photographer.referralsMade || [];

              if (baseCredits > 0 && validReferrals.length > 0) {
                totalReferralBoost = validReferrals.reduce((sum, r) => sum + (r.monthlyBoostCredits || 0), 0);
              }

              const totalMonthlyQuota = baseCredits + totalReferralBoost;

              // Atomic Transaction: Reset creditBalance & create itemized ledger records
              await this.prisma.$transaction(async (tx) => {
                await tx.photographer.update({
                  where: { id: photographer.id },
                  data: { creditBalance: totalMonthlyQuota },
                });

                // 1. Log Base Plan Monthly Refill Entry in Ledger
                if (baseCredits > 0) {
                  await tx.creditTransaction.create({
                    data: {
                      photographerId: photographer.id,
                      amount: baseCredits,
                      action: 'MONTHLY_PLAN_RENEW',
                      description: `Monthly ${activeSub?.package?.name || 'Subscription'} Plan AI Fuel Refill (${(baseCredits / 100).toFixed(0)} Credits)`,
                    },
                  });
                }

                // 2. Log Itemized Monthly Referral Boost Entry in Ledger
                if (totalReferralBoost > 0) {
                  const friendNames = validReferrals.map((r) => r.referredUser?.studioName || r.referredUser?.user?.name || 'Referred Studio').join(', ');
                  await tx.creditTransaction.create({
                    data: {
                      photographerId: photographer.id,
                      amount: totalReferralBoost,
                      action: 'REFERRAL_MONTHLY_BOOST',
                      description: `Monthly Referral Fuel Boost (+${(totalReferralBoost / 100).toFixed(0)} Credits from ${validReferrals.length} active referred studio[s]: ${friendNames})`,
                    },
                  });
                }
              });

              renewedCount++;
            } catch (pErr: any) {
              this.logger.error(`[CreditsRenewCron] Failed to renew credits for photographer ${photographer.id}: ${pErr.message}`);
            }
          })
        );
      }

      this.logger.log(`[CreditsRenewCron] Successfully renewed credits with referral boosts for ${renewedCount} photographers.`);
    } catch (error: any) {
      this.logger.error('[CreditsRenewCron] Failed to renew photographer credits:', error.message);
    } finally {
      await this.redis.del(lockKey).catch(() => {});
    }
  }

  // Daily at 01:00 AM: Check expired subscriptions and expire outdated referrals
  @Cron('0 0 1 * * *')
  async checkSubscriptionExpiryAndGracePeriod() {
    const lockKey = 'lock:cron:subscription-expiry';
    let acquired: any = null;
    try {
      acquired = await this.redis.set(lockKey, '1', 'EX', 1800, 'NX');
    } catch {
      acquired = 'OK';
    }
    if (!acquired) {
      this.logger.log('[SubscriptionExpiryCron] Cron skipped — already running on another cluster instance.');
      return;
    }

    this.logger.log('[SubscriptionExpiryCron] Checking for expired subscriptions past grace period...');
    try {
      const now = new Date();
      // 15 days grace period cutoff
      const gracePeriodCutoff = new Date(now.getTime() - 15 * 24 * 60 * 60 * 1000);

      const expiredSubs = await this.prisma.subscription.findMany({
        where: {
          status: 'ACTIVE',
          endsAt: { lt: gracePeriodCutoff },
        },
        include: {
          photographer: true,
          package: true,
        },
        take: 100, // Process in batches of 100
      });

      const freePackage = await this.prisma.package.findUnique({
        where: { name: 'Free' },
      });

      const CHUNK_SIZE = 25;
      for (let i = 0; i < expiredSubs.length; i += CHUNK_SIZE) {
        const chunk = expiredSubs.slice(i, i + CHUNK_SIZE);
        await Promise.all(
          chunk.map(async (sub) => {
            try {
              await this.prisma.subscription.update({
                where: { id: sub.id },
                data: { status: 'EXPIRED' },
              });

              if (freePackage) {
                await this.prisma.photographer.update({
                  where: { id: sub.photographerId },
                  data: { activePackageId: freePackage.id },
                });
              }

              this.logger.log(`[SubscriptionExpiryCron] Subscription ${sub.id} for photographer ${sub.photographerId} marked EXPIRED.`);
            } catch (sErr: any) {
              this.logger.error(`[SubscriptionExpiryCron] Error expiring sub ${sub.id}: ${sErr.message}`);
            }
          })
        );
      }

      // Automatically expire outdated referrals where validUntil < now
      const expiredReferrals = await this.prisma.referral.updateMany({
        where: {
          status: 'ACTIVE',
          validUntil: { lt: now },
        },
        data: { status: 'EXPIRED' },
      });

      if (expiredReferrals.count > 0) {
        this.logger.log(`[SubscriptionExpiryCron] Marked ${expiredReferrals.count} referrals as EXPIRED.`);
      }
    } catch (error: any) {
      this.logger.error('[SubscriptionExpiryCron] Error checking subscription expirations:', error.message);
    } finally {
      await this.redis.del(lockKey).catch(() => {});
    }
  }
}
