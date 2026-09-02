import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';
import { CreditsRenewCronService } from './credits-renew-cron.service';

@Module({
  controllers: [BillingController],
  providers: [BillingService, PrismaService, CreditsRenewCronService],
  exports: [BillingService],
})
export class BillingModule {}
