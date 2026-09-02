import { Module } from '@nestjs/common';
import { PrismaService } from '../../prisma.service';
import { BeamService } from './beam.service';
import { BeamController } from './beam.controller';
import { StorageModule } from '../storage/storage.module';

@Module({
  imports: [StorageModule],
  controllers: [BeamController],
  providers: [BeamService, PrismaService],
  exports: [BeamService],
})
export class BeamModule {}
