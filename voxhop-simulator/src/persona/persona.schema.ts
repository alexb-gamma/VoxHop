import { z } from 'zod';

/**
 * PersonaSchema — Zod validation schema for persona JSON files.
 *
 * M-12: Used in PersonaLoader.onModuleInit() for safeParse validation.
 * MN-03: Server-side schema — NOT imported into client/src/ (client has its own type).
 */
export const PersonaSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  language: z.string().min(1),
  piperVoice: z.string().min(1),
  systemPrompt: z.string().min(1),
  conversationOpener: z.string().optional(),
});

export type Persona = z.infer<typeof PersonaSchema>;
