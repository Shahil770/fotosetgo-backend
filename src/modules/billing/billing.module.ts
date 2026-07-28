import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { BillingService } from './billing.service';
import { BillingController } from './billing.controller';

@Module({
  controllers: [BillingController],
  providers: [BillingService, PrismaService],
  exports: [BillingService],
})
export class BillingModule {}
