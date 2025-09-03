// src/config.ts
import { z } from 'zod';

const schema = z.object({
  BOT_TOKEN: z.string().min(10),
  RPC_URL: z.string().url(),
  CHAIN_ID: z.coerce.number().default(369),
  ROUTER_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  WPLS_ADDRESS: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  MASTER_KEY: z.string().min(32),
});

export type AppConfig = z.infer<typeof schema>;

let cached: AppConfig | null = null;
export function getConfig(): AppConfig {
  if (cached) return cached;
  const parsed = schema.safeParse(process.env);
  if (!parsed.success) {
    console.error(parsed.error.flatten().fieldErrors);
    throw new Error('Invalid or missing environment variables');
  }
  cached = parsed.data;
  return cached;
}
