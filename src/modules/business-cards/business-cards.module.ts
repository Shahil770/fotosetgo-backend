import { Module } from '@nestjs/common';
import { BusinessCardsController, PublicBusinessCardsController } from './business-cards.controller';
import { BusinessCardsService } from './business-cards.service';
import { PrismaService } from '../../prisma.service';

@Module({
  controllers: [BusinessCardsController, PublicBusinessCardsController],
  providers: [BusinessCardsService, PrismaService],
  exports: [BusinessCardsService]
})
export class BusinessCardsModule {}
