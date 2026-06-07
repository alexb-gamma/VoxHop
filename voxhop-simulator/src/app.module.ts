import { Module } from '@nestjs/common';
import { PersonaModule } from './persona/persona.module';
import { SimulatorModule } from './simulator/simulator.module';

@Module({
  imports: [PersonaModule, SimulatorModule],
})
export class AppModule {}
