import { Module } from '@nestjs/common';
import { PersonaModule } from '../persona/persona.module';
import { SimulatorGateway } from './simulator.gateway';
import { CallSessionService } from './call-session.service';

@Module({
  imports: [PersonaModule],
  providers: [SimulatorGateway, CallSessionService],
})
export class SimulatorModule {}
