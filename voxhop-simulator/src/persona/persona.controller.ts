import { Controller, Get } from '@nestjs/common';
import { PersonaLoader } from './persona.loader';
import { Persona } from './persona.schema';

/**
 * PersonaController — HTTP endpoints for persona data and health.
 *
 * GET /personas → 200 OK with JSON array of validated persona objects (M-12).
 * GET /health   → 200 OK { "status": "ok" }.
 */
@Controller()
export class PersonaController {
  constructor(private readonly personaLoader: PersonaLoader) {}

  @Get('personas')
  getPersonas(): Persona[] {
    return this.personaLoader.getPersonas();
  }

  @Get('health')
  getHealth(): { status: string } {
    return { status: 'ok' };
  }
}
