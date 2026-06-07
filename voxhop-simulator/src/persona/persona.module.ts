import { Module } from '@nestjs/common';
import { PersonaLoader } from './persona.loader';
import { PersonaController } from './persona.controller';

@Module({
  controllers: [PersonaController],
  providers: [PersonaLoader],
  exports: [PersonaLoader],
})
export class PersonaModule {}
