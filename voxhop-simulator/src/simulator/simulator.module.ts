import { Module } from '@nestjs/common';
import { SimulatorGateway } from './simulator.gateway';

@Module({
  providers: [SimulatorGateway],
})
export class SimulatorModule {}
