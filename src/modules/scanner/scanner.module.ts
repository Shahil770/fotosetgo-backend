import { Module } from '@nestjs/common';
import { ScannerService } from './scanner.service';
import { ScannerController } from './scanner.controller';
import { ScannerGuard } from './scanner.guard';
import { PrismaService } from '../../prisma.service';

@Module({
  controllers: [ScannerController],
  providers: [ScannerService, ScannerGuard, PrismaService],
  exports: [ScannerService],
})
export class ScannerModule {}
