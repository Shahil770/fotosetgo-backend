import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { EventsService } from './events.service';
import { EventsController } from './events.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [EventsController],
  providers: [EventsService, PrismaService],
  exports: [EventsService],
})
export class EventsModule {}
