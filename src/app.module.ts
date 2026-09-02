import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { AuthModule } from './modules/auth/auth.module';
import { EventsModule } from './modules/events/events.module';
import { StorageModule } from './modules/storage/storage.module';
import { BillingModule } from './modules/billing/billing.module';
import { BusinessCardsModule } from './modules/business-cards/business-cards.module';
import { RedisModule } from './modules/redis/redis.module';
import { BeamModule } from './modules/beam/beam.module';
import { ReferralsModule } from './modules/referrals/referrals.module';
import { WalletModule } from './modules/wallet/wallet.module';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    RedisModule,
    AuthModule,
    EventsModule,
    StorageModule,
    BillingModule,
    BusinessCardsModule,
    BeamModule,
    ReferralsModule,
    WalletModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule { }
