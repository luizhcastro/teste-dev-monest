import { z } from 'zod';

export const brasilApiSchema = z.object({
  cep: z.string(),
  street: z.string(),
  neighborhood: z.string(),
  city: z.string(),
  state: z.string().length(2),
});

export type BrasilApiPayload = z.infer<typeof brasilApiSchema>;
