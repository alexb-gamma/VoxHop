import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { PersonaSchema, Persona } from './persona.schema';

/**
 * PersonaLoader — loads and validates persona JSON files at startup.
 *
 * M-12: safeParse on every file; skip invalid with warn; first-seen dedup with warn;
 *       zero personas loaded → service remains healthy (GET /personas returns []).
 * MN-05: NO file-watching, NO chokidar, NO fs.watch(), NO setInterval re-read.
 *        Persona data is loaded ONCE at onModuleInit(). Container restart = reload.
 * M-09: Reads from /app/counterparties (mounted read-only in Docker — docker-compose.yml).
 */
@Injectable()
export class PersonaLoader implements OnModuleInit {
  private readonly logger = new Logger(PersonaLoader.name);
  private readonly personas: Persona[] = [];
  private readonly seenIds = new Set<string>();

  async onModuleInit(): Promise<void> {
    const dir = process.env.COUNTERPARTIES_DIR ?? '/app/counterparties';

    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      this.logger.warn(
        `[PersonaLoader] counterparties directory not found: ${dir} — starting with empty persona list`,
      );
      return;
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    this.logger.log(`[PersonaLoader] Found ${jsonFiles.length} JSON file(s) in ${dir}`);

    for (const filename of jsonFiles) {
      const filepath = join(dir, filename);

      let raw: string;
      try {
        raw = await readFile(filepath, 'utf-8');
      } catch {
        this.logger.warn(`[PersonaLoader] Skipping invalid persona: ${filename} (read error)`);
        continue;
      }

      let json: unknown;
      try {
        json = JSON.parse(raw);
      } catch {
        this.logger.warn(`[PersonaLoader] Skipping invalid persona: ${filename} (JSON parse error)`);
        continue;
      }

      const result = PersonaSchema.safeParse(json);
      if (!result.success) {
        this.logger.warn(
          `[PersonaLoader] Skipping invalid persona: ${filename} (schema validation failed: ${result.error.message})`,
        );
        continue;
      }

      const persona = result.data;

      // M-12: First-seen dedup — first file with this id wins
      if (this.seenIds.has(persona.id)) {
        this.logger.warn(
          `[PersonaLoader] Duplicate id "${persona.id}" in ${filename} — first-seen wins, skipping`,
        );
        continue;
      }

      this.seenIds.add(persona.id);
      this.personas.push(persona);
      this.logger.log(`[PersonaLoader] Loaded persona: id=${persona.id} name="${persona.name}"`);
    }

    // M-12: Zero personas loaded → healthy service (no crash, no process.exit)
    this.logger.log(`[PersonaLoader] Startup complete — ${this.personas.length} persona(s) loaded`);
  }

  getPersonas(): Persona[] {
    return this.personas;
  }
}
