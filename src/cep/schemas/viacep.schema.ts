import { z } from 'zod';

export const viaCepSuccessSchema = z.object({
  cep: z.string(),
  logradouro: z.string(),
  bairro: z.string(),
  localidade: z.string(),
  uf: z.string().length(2),
});

export const viaCepErrorSchema = z.object({
  erro: z.union([z.literal(true), z.literal('true')]),
});

export const viaCepSchema = z.union([viaCepSuccessSchema, viaCepErrorSchema]);

export type ViaCepSuccess = z.infer<typeof viaCepSuccessSchema>;
export type ViaCepPayload = z.infer<typeof viaCepSchema>;
