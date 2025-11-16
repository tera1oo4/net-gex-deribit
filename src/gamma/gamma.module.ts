import { Module } from '@nestjs/common';
import { GammaController } from './gamma.controller';
import { GammaService } from './gamma.service';

@Module({
  controllers: [GammaController],
  providers: [GammaService],
})
export class GammaModule {}
